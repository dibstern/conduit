// Auto-titling OpenCode sessions end to end (conduit-test-o4yo.2), against a
// real, temporary OpenCode server. The title model is stubbed, so no test
// makes a live title call; OpenCode turns use a free model.
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClaudeTitleQueryFactory } from "../../../src/lib/domain/relay/Services/claude-title-generator.js";
import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../../e2e/helpers/opencode-spawner.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

// Re-check on an OpenCode bump: the free roster churns
// (`opencode models | grep '^opencode/'` on an isolated instance).
const FREE_MODEL = "opencode/mimo-v2.6-flash-free";
const FALLBACK_TITLE = /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

async function* titleReply(title: string): AsyncIterable<unknown> {
	yield {
		type: "assistant",
		message: { content: [{ type: "text", text: title }] },
	};
}

const makeSignal = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("Integration: OpenCode session titles", () => {
	let opencode: SpawnedOpenCode;
	let harness: RelayHarness;
	let client: TestWsClient;
	// Each test installs its own title model behind the relay's stub.
	let titleQuery: ClaudeTitleQueryFactory = () => titleReply("Unused");
	const titleCalls = vi.fn();

	beforeAll(async () => {
		opencode = await spawnOpenCode({
			env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: FREE_MODEL }) },
		});
		harness = await createRelayHarness("chat-simple", {
			opencodeUrl: opencode.url,
			defaultModel: FREE_MODEL,
			titleQuery: (params) => {
				titleCalls(params);
				return titleQuery(params);
			},
		});
		client = await harness.connectWsClient();
		await client.waitForInitialState();
	}, 60_000);

	afterAll(async () => {
		await client?.close();
		await harness?.stop();
		opencode?.stop();
	});

	const conduitTitle = (sessionId: string): string | undefined => {
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const row = db
				.prepare("SELECT title FROM sessions WHERE id = ?")
				.get(sessionId) as { title: string } | undefined;
			return row?.title;
		} finally {
			db.close();
		}
	};

	const renameEvents = (sessionId: string) => {
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			return db
				.prepare(
					`SELECT json_extract(data, '$.title') AS title,
					        json_extract(metadata, '$.source') AS source
					   FROM events
					  WHERE session_id = ? AND type = 'session.renamed'
					  ORDER BY sequence`,
				)
				.all(sessionId) as { title: string; source: string | null }[];
		} finally {
			db.close();
		}
	};

	const opencodeTitle = async (sessionId: string): Promise<string> => {
		const res = await fetch(`${opencode.url}/session/${sessionId}`);
		const body = (await res.json()) as { title: string };
		return body.title;
	};

	const setOpenCodeTitle = (sessionId: string, title: string) =>
		fetch(`${opencode.url}/session/${sessionId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});

	const createUntitledSession = async (): Promise<string> => {
		const created = await client.createSession();
		const sessionId = created["id"] as string;
		expect(await opencodeTitle(sessionId)).toBe("Untitled");
		expect(conduitTitle(sessionId)).toBe("Untitled");
		client.clearReceived();
		return sessionId;
	};

	const send = (sessionId: string, text: string) =>
		client.sendMessage(text, { sessionId, originId: client.getClientId() });

	it("titles the first message in Conduit and OpenCode, and keeps it", async () => {
		titleQuery = () => titleReply("Fix Header Selector");
		titleCalls.mockClear();
		const sessionId = await createUntitledSession();

		const turnEnd = client.waitForTurnEnd(sessionId, 120_000);
		await send(sessionId, "Reply with just the word 'pong'.");
		await vi.waitFor(
			async () => {
				expect(conduitTitle(sessionId)).toBe("Fix Header Selector");
				expect(await opencodeTitle(sessionId)).toBe("Fix Header Selector");
			},
			{ timeout: 15_000 },
		);
		expect(titleCalls).toHaveBeenCalledTimes(1);
		expect(String(titleCalls.mock.calls[0]?.[0]?.prompt)).toContain(
			"Reply with just the word 'pong'.",
		);

		// The turn ran in OpenCode, and its own titler left the session alone.
		await turnEnd;
		const messages = (await (
			await fetch(`${opencode.url}/session/${sessionId}/message`)
		).json()) as { info: { role: string } }[];
		expect(messages.map((message) => message.info.role)).toContain("assistant");
		expect(await opencodeTitle(sessionId)).toBe("Fix Header Selector");
		expect(conduitTitle(sessionId)).toBe("Fix Header Selector");

		// OpenCode reporting a placeholder title later does not revert it.
		await setOpenCodeTitle(sessionId, "Untitled");
		await vi.waitFor(
			() =>
				expect(renameEvents(sessionId)).toContainEqual({
					title: "Untitled",
					source: null,
				}),
			{ timeout: 15_000 },
		);
		expect(conduitTitle(sessionId)).toBe("Fix Header Selector");

		// A follow-up message is not titled again.
		const followUpEnd = client.waitForTurnEnd(sessionId, 120_000);
		await send(sessionId, "Reply with just the word 'ping'.");
		await followUpEnd;
		expect(titleCalls).toHaveBeenCalledTimes(1);
	}, 300_000);

	it("lets a manual rename made while titling win in Conduit and OpenCode", async () => {
		const started = makeSignal();
		const release = makeSignal();
		const finished = makeSignal();
		titleQuery = async function* () {
			started.resolve();
			try {
				await release.promise;
				yield* titleReply("Auto Title Too Late");
			} finally {
				finished.resolve();
			}
		};
		titleCalls.mockClear();
		const sessionId = await createUntitledSession();

		await send(sessionId, "Explain the session list sorting.");
		await started.promise;
		await client.renameSession(sessionId, "Manual Title");
		await vi.waitFor(
			async () => {
				expect(conduitTitle(sessionId)).toBe("Manual Title");
				expect(await opencodeTitle(sessionId)).toBe("Manual Title");
			},
			{ timeout: 15_000 },
		);

		release.resolve();
		await finished.promise;
		// Give a late auto-title every chance to land before asserting it didn't.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(titleCalls).toHaveBeenCalledTimes(1);
		expect(conduitTitle(sessionId)).toBe("Manual Title");
		expect(await opencodeTitle(sessionId)).toBe("Manual Title");
		expect(renameEvents(sessionId).map((event) => event.title)).not.toContain(
			"Auto Title Too Late",
		);
	}, 120_000);

	it("falls back to a dated title when the title model fails", async () => {
		titleQuery = async function* () {
			yield* [];
			throw new Error("title model unavailable");
		};
		titleCalls.mockClear();
		const sessionId = await createUntitledSession();

		await send(sessionId, "Summarise the failing tests.");
		await vi.waitFor(
			async () => {
				expect(conduitTitle(sessionId)).toMatch(FALLBACK_TITLE);
				expect(await opencodeTitle(sessionId)).toBe(conduitTitle(sessionId));
			},
			{ timeout: 15_000 },
		);
		expect(titleCalls).toHaveBeenCalledTimes(1);
	}, 120_000);
});
