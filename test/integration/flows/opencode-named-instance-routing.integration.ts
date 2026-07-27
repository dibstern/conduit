import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../../e2e/fixtures/recorded/types.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const NAMED_INSTANCE_ID = "work-oc";
const NAMED_SESSION_ID = "ses_named_instance";

function withCreatedSessionId(
	recording: OpenCodeRecording,
	sessionId: string,
): OpenCodeRecording {
	// The recording addresses one session by a fixed id embedded in REST paths,
	// response bodies, and SSE event sessionIDs. Rewrite EVERY occurrence to the
	// target id so the mock's path-keyed queues (prompt_async, message GET) and
	// SSE stream all match the id the relay uses after create.
	const createInteraction = recording.interactions.find(
		(
			interaction,
		): interaction is Extract<OpenCodeInteraction, { kind: "rest" }> =>
			interaction.kind === "rest" &&
			interaction.method === "POST" &&
			interaction.path === "/session",
	);
	if (
		createInteraction === undefined ||
		typeof createInteraction.responseBody !== "object" ||
		createInteraction.responseBody === null
	) {
		throw new Error("Recording has no POST /session interaction with a body");
	}
	const originalId = (createInteraction.responseBody as { id?: unknown }).id;
	if (typeof originalId !== "string" || originalId.length === 0) {
		throw new Error("Recorded POST /session response has no string id");
	}
	const rewritten = JSON.parse(
		JSON.stringify(recording).split(originalId).join(sessionId),
	) as OpenCodeRecording;
	return { ...rewritten, name: `${recording.name}-named-instance` };
}

function requestCount(
	mock: MockOpenCodeServer,
	matches: (detail: string) => boolean,
): number {
	return mock.diagnostics.filter(
		(entry) =>
			entry.event === "request" &&
			entry.detail !== undefined &&
			matches(entry.detail),
	).length;
}

const sessionCreateCount = (mock: MockOpenCodeServer): number =>
	requestCount(mock, (detail) => detail === "POST /session");

const promptCount = (mock: MockOpenCodeServer): number =>
	requestCount(mock, (detail) =>
		/^POST \/session\/[^/]+\/prompt_async(?:\?|$)/.test(detail),
	);

describe("Integration: named OpenCode instance routing", () => {
	let harness: RelayHarness;
	let namedMock: MockOpenCodeServer;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "conduit-named-instance-"));
		namedMock = new MockOpenCodeServer(
			withCreatedSessionId(
				loadOpenCodeRecording("chat-simple"),
				NAMED_SESSION_ID,
			),
		);
		await namedMock.start();

		const daemonConfig: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances: [
				{
					id: NAMED_INSTANCE_ID,
					name: "Work OpenCode",
					port: 0,
					managed: false,
					driver: "opencode",
					url: namedMock.url,
				},
			],
		};
		writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(daemonConfig));
		harness = await createRelayHarness("chat-simple", {
			configDir: tempDir,
			persistenceDbPath: join(tempDir, "events.sqlite"),
		});
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
		if (namedMock) await namedMock.stop();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates, prompts, and streams on the bound server without changing default routing", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		const defaultCreatesBefore = sessionCreateCount(harness.mock);
		const namedCreatesBefore = sessionCreateCount(namedMock);
		const created = await client.createSession("Named instance", {
			instanceId: NAMED_INSTANCE_ID,
		});
		const namedSessionId = created["id"];
		expect(namedSessionId).toBe(NAMED_SESSION_ID);
		expect(sessionCreateCount(namedMock)).toBe(namedCreatesBefore + 1);
		expect(sessionCreateCount(harness.mock)).toBe(defaultCreatesBefore);

		client.clearReceived();
		const defaultPromptsBeforeNamedTurn = promptCount(harness.mock);
		const namedPromptsBeforeNamedTurn = promptCount(namedMock);
		const namedDelta = client.waitFor("delta", {
			timeout: 15_000,
			predicate: (message) => message["sessionId"] === namedSessionId,
		});
		const namedDone = client.waitFor("done", {
			timeout: 15_000,
			predicate: (message) =>
				message["sessionId"] === namedSessionId && message["code"] === 0,
		});
		await client.sendMessage("Reply with just the word 'pong'.", {
			sessionId: NAMED_SESSION_ID,
			originId: client.getClientId(),
		});
		const [delta, done] = await Promise.all([namedDelta, namedDone]);
		expect(delta["text"]).toBeTruthy();
		expect(done["code"]).toBe(0);
		expect(promptCount(namedMock)).toBe(namedPromptsBeforeNamedTurn + 1);
		// Isolation: the named turn never touched the project-default server A.
		// (Positive default-instance -> A routing is unchanged by 4.4 — the
		// clientFor-returns-undefined default path — and is covered by the wider
		// OpenCode integration suite; the relay-harness default session is
		// Claude-backed, so it must not be used to assert OpenCode routing here.)
		expect(promptCount(harness.mock)).toBe(defaultPromptsBeforeNamedTurn);

		await client.viewSession(NAMED_SESSION_ID);
		await namedMock.stop();
		client.clearReceived();
		const defaultPromptsBeforeFailure = promptCount(harness.mock);
		const failure = client.waitFor("error", {
			timeout: 8_000,
			predicate: (message) =>
				message["sessionId"] === NAMED_SESSION_ID &&
				message["code"] === "SEND_FAILED",
		});
		const failedDone = client.waitFor("done", {
			timeout: 8_000,
			predicate: (message) =>
				message["sessionId"] === NAMED_SESSION_ID && message["code"] === 1,
		});
		await client.sendMessage("This must not fall back to server A.", {
			sessionId: NAMED_SESSION_ID,
			originId: client.getClientId(),
		});
		const [failureMessage] = await Promise.all([failure, failedDone]);
		// conduit classifies a dead named server as an OpenCodeConnectionError
		// ("OpenCode unreachable during <label>") regardless of the volatile raw
		// cause (ECONNREFUSED / fetch failed / undici Request-reuse). Assert that
		// stable connection-failure classification, not the platform-specific cause.
		expect(failureMessage["message"]).toMatch(
			/unreachable|ECONNREFUSED|fetch failed|timed out/i,
		);
		expect(promptCount(harness.mock)).toBe(defaultPromptsBeforeFailure);
	}, 45_000);
});
