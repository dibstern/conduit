// ADR-0002: these assertions are pinned to captured OpenCode wire traffic,
// never to the provider SDK's event types.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, expect, it, vi } from "vitest";
import {
	apiDelete,
	apiGet,
	apiPost,
	checkServerHealth,
	connectSSE,
	getPinnedVersion,
	OPENCODE_BASE_URL,
} from "./helpers/server-connection.js";
import type { TestSession } from "./helpers/session-helpers.js";

interface Envelope {
	directory?: string;
	project?: string;
	payload: {
		id: string;
		type: string;
		properties?: Record<string, unknown>;
		syncEvent?: {
			id: string;
			type: string;
			seq: number;
			aggregateID: string;
			data: Record<string, unknown>;
		};
	};
}

interface PendingAsk {
	id: string;
	sessionID: string;
	questions?: { options: { label: string }[] }[];
}

const SESSION_EVENTS = [
	"session.created",
	"session.updated",
	"session.status",
	"session.diff",
	"session.idle",
	"session.error",
	"message.updated",
	"message.part.updated",
	"message.part.delta",
	"permission.asked",
	"permission.replied",
	"question.asked",
	"question.replied",
];
const DIRECTORY_EVENTS = [
	"plugin.added",
	"catalog.updated",
	"reference.updated",
	"integration.updated",
];
// These are the only captured envelopes with no directory. project.updated
// instead carries the literal "global", not the directory that triggered it.
const NO_DIRECTORY_EVENTS = ["server.connected", "server.heartbeat"];

function assertRouting(envelopes: Envelope[], sessions: Map<string, string>) {
	const directories = [...new Set(sessions.values())];
	expect(directories).toHaveLength(2);
	expect(sessions.size).toBe(4);
	for (const envelope of envelopes) {
		const { payload, directory } = envelope;
		expect(payload.id).toEqual(expect.any(String));
		if (NO_DIRECTORY_EVENTS.includes(payload.type)) {
			expect(envelope).not.toHaveProperty("directory");
			expect(envelope).not.toHaveProperty("project");
			expect(payload.properties).toEqual({});
			continue;
		}
		if (payload.type === "project.updated") {
			expect(directory).toBe("global");
			expect(envelope.project).toEqual(expect.any(String));
			expect(payload.properties?.["id"]).toBe(envelope.project);
			continue;
		}
		expect(envelope.project).toBe("global");
		expect(directories, payload.type).toContain(directory);
		if (DIRECTORY_EVENTS.includes(payload.type)) {
			expect(payload.properties).toEqual(expect.any(Object));
			continue;
		}

		let properties = payload.properties;
		let type = payload.type;
		if (type === "sync") {
			const sync = payload.syncEvent;
			assert.exists(sync);
			expect(payload).not.toHaveProperty("properties");
			expect(sync.id).toBe(payload.id);
			expect(Number.isInteger(sync.seq)).toBe(true);
			expect(sync.seq).toBeGreaterThanOrEqual(0);
			expect(sync.aggregateID).toBe(sync.data["sessionID"]);
			expect([
				"session.created.1",
				"session.updated.1",
				"message.updated.1",
				"message.part.updated.1",
			]).toContain(sync.type);
			properties = sync.data;
			type = sync.type.slice(0, -2);
		}
		expect(SESSION_EVENTS, `unreviewed event type ${type}`).toContain(type);
		assert.exists(properties);
		const id = properties["sessionID"];
		expect(id).toEqual(expect.any(String));
		expect(sessions.get(String(id)), `${type} origin`).toBe(directory);
		for (const key of ["info", "part"]) {
			const nested = properties[key] as Record<string, unknown> | undefined;
			if (nested?.["sessionID"] !== undefined) {
				expect(nested["sessionID"]).toBe(id);
			}
		}
		if (["session.created", "session.updated"].includes(type)) {
			const info = properties["info"] as Record<string, unknown>;
			expect(info["id"]).toBe(id);
			expect(info["directory"]).toBe(directory);
		}
		if (type === "session.status") {
			const status = properties["status"] as { type: string };
			expect(["busy", "idle", "retry"]).toContain(status.type);
			if (status.type !== "retry")
				expect(status).toEqual({ type: status.type });
		}
		expect(type, JSON.stringify(properties)).not.toBe("session.error");
	}
	for (const type of NO_DIRECTORY_EVENTS) {
		expect(envelopes.some(({ payload }) => payload.type === type)).toBe(true);
	}
}

function assertLifecycle(
	envelopes: Envelope[],
	id: string,
	ask: "permission" | "question",
) {
	const events = envelopes
		.filter(({ payload }) => payload.properties?.["sessionID"] === id)
		.map(({ payload }) => payload);
	const asked = events.findIndex(({ type }) => type === `${ask}.asked`);
	const replied = events.findIndex(({ type }) => type === `${ask}.replied`);
	const statuses = events.filter(({ type }) => type === "session.status");
	expect(statuses.map(({ properties }) => properties?.["status"])).toEqual(
		expect.arrayContaining([{ type: "busy" }, { type: "idle" }]),
	);
	expect(statuses.at(-1)?.properties?.["status"]).toEqual({ type: "idle" });
	expect(asked).toBeGreaterThanOrEqual(0);
	expect(replied).toBeGreaterThan(asked);
	const request = events[asked]?.properties;
	expect(events[replied]?.properties).toEqual(
		ask === "permission"
			? { sessionID: id, requestID: request?.["id"], reply: "once" }
			: { sessionID: id, requestID: request?.["id"], answers: [["Continue"]] },
	);
	expect(
		events.findIndex(
			({ type, properties }) =>
				type === "session.status" &&
				(properties?.["status"] as { type: string }).type === "idle",
		),
	).toBeGreaterThan(replied);
	expect(events.some(({ type }) => type === "session.idle")).toBe(true);
}

it("replays the reviewed 1.18.34 global-stream wire fixture", () => {
	const envelopes = readFileSync(
		new URL(
			"../fixtures/opencode-wire/global-stream-1.18.34.jsonl",
			import.meta.url,
		),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Envelope);
	const sessions = new Map<string, string>();
	for (const { directory, payload } of envelopes) {
		if (payload.type !== "session.created") continue;
		assert.exists(directory);
		sessions.set(String(payload.properties?.["sessionID"]), directory);
	}
	assertRouting(envelopes, sessions);
	for (const directory of new Set(sessions.values())) {
		for (const ask of ["permission", "question"] as const) {
			const requests = envelopes.filter(
				(envelope) =>
					envelope.directory === directory &&
					envelope.payload.type === `${ask}.asked`,
			);
			expect(requests).toHaveLength(1);
			assertLifecycle(
				envelopes,
				String(requests[0]?.payload.properties?.["sessionID"]),
				ask,
			);
		}
	}
});

it("pins global directory routing, session demand and pending-list scope from the wire", async () => {
	// A missing global-setup URL must fail, never hit the user's live server.
	expect(process.env["OPENCODE_URL"]).toBeTruthy();
	expect(["4096", "2633"]).not.toContain(new URL(OPENCODE_BASE_URL).port);
	const envelopes: Envelope[] = [];
	const pendingLists: {
		phase: "pending" | "resolved";
		path: string;
		result: PendingAsk[];
	}[] = [];
	const sessions: (TestSession & {
		directory: string;
		ask: "permission" | "question";
	})[] = [];
	const directories: string[] = [];
	let passed = false;
	let version: string | undefined;
	const { controller, ready } = connectSSE("/global/event", ({ data }) => {
		envelopes.push(JSON.parse(data) as Envelope);
	});

	try {
		await ready;
		await vi.waitFor(() => expect(envelopes.length).toBeGreaterThan(0));
		const health = await checkServerHealth();
		expect(health?.healthy).toBe(true);
		version = health?.version;
		expect(version).toBe(getPinnedVersion());
		for (const name of ["a", "b"]) {
			// OpenCode resolves macOS /var aliases before publishing directories.
			directories.push(
				realpathSync(mkdtempSync(join(tmpdir(), `opencode-global-${name}-`))),
			);
		}

		for (const directory of directories) {
			for (const ask of ["permission", "question"] as const) {
				const query = `?directory=${encodeURIComponent(directory)}`;
				const session = await apiPost<TestSession>(`/session${query}`, {
					title: `global-stream-${ask}`,
					permission: [{ permission: "bash", pattern: "*", action: "ask" }],
				});
				sessions.push({ ...session, directory, ask });
				expect(session.directory).toBe(directory);
				await apiPost(`/session/${session.id}/prompt_async${query}`, {
					// Same unauthenticated model as helpers/session-helpers.ts.
					model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
					agent: "build",
					parts: [
						{
							type: "text",
							text:
								ask === "permission"
									? "Use the bash tool exactly once to run: printf 'global-stream-contract\\n'. Do not use any other tool. After it completes, say DONE and stop."
									: 'Use the question tool exactly once, with one question: "Continue the contract test?", header "Contract", options [{"label":"Continue","description":"Finish this test"}], multiple false. You MUST invoke the question tool, do not ask in text. After I answer, say DONE and stop. Do not use any other tool.',
						},
					],
				});
				await vi.waitFor(
					() =>
						expect(
							envelopes.some(
								({ payload }) =>
									payload.type === `${ask}.asked` &&
									payload.properties?.["sessionID"] === session.id,
							),
						).toBe(true),
					{ timeout: 90_000, interval: 100 },
				);
			}
		}

		for (const endpoint of ["permission", "question"] as const) {
			for (const directory of [undefined, ...directories]) {
				const path = `/${endpoint}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`;
				const result = await apiGet<PendingAsk[]>(path);
				pendingLists.push({ phase: "pending", path, result });
				// 1.18.34's unscoped lists are NOT global. Even with asks in both
				// directories they return []; scoped lists return only that ask.
				const expected = envelopes
					.filter(
						(envelope) =>
							envelope.directory === directory &&
							envelope.payload.type === `${endpoint}.asked`,
					)
					.map(({ payload }) => payload.properties);
				expect(expected).toHaveLength(directory ? 1 : 0);
				expect(result).toEqual(expected);
			}
		}

		// Reply using the directory from the SSE envelope, not a guessed scope.
		for (const { directory, payload } of [...envelopes]) {
			if (!["permission.asked", "question.asked"].includes(payload.type)) {
				continue;
			}
			assert.exists(directory);
			const request = payload.properties as unknown as PendingAsk;
			const endpoint = payload.type.split(".")[0];
			await apiPost(
				`/${endpoint}/${request.id}/reply?directory=${encodeURIComponent(directory)}`,
				endpoint === "permission"
					? { reply: "once" }
					: { answers: request.questions?.map(() => ["Continue"]) },
			);
		}

		await vi.waitFor(
			() => {
				// A fast model must not finish the test before the first keepalive.
				expect(
					envelopes.some(({ payload }) => payload.type === "server.heartbeat"),
				).toBe(true);
				for (const session of sessions) {
					const events = envelopes.filter(
						({ payload }) => payload.properties?.["sessionID"] === session.id,
					);
					expect(
						events.some(
							({ payload }) => payload.type === `${session.ask}.replied`,
						),
					).toBe(true);
					expect(
						events.some(
							({ payload }) =>
								payload.type === "session.status" &&
								(payload.properties?.["status"] as { type: string }).type ===
									"idle",
						),
					).toBe(true);
					expect(
						events.some(({ payload }) => payload.type === "session.idle"),
					).toBe(true);
				}
			},
			{ timeout: 90_000, interval: 100 },
		);
		for (const { id, directory, ask } of sessions) {
			assertLifecycle(envelopes, id, ask);
			const path = `/${ask}?directory=${encodeURIComponent(directory)}`;
			const result = await apiGet<PendingAsk[]>(path);
			pendingLists.push({ phase: "resolved", path, result });
			expect(result).toEqual([]);
		}
		controller.abort();
		assertRouting(
			envelopes,
			new Map(sessions.map(({ id, directory }) => [id, directory])),
		);
		passed = true;
	} finally {
		controller.abort();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/pa3r-1-opencode-global-stream.json",
			JSON.stringify(
				{
					ticket: "conduit-test-pa3r.1",
					capturedAt: new Date().toISOString(),
					version,
					passed,
					directories,
					sessions,
					pendingLists,
					retryObserved: envelopes.some(
						({ payload }) =>
							payload.type === "session.status" &&
							(payload.properties?.["status"] as { type: string }).type ===
								"retry",
					),
					envelopes,
				},
				null,
				2,
			),
		);
		for (const session of sessions) {
			const query = `?directory=${encodeURIComponent(session.directory)}`;
			await apiPost(`/session/${session.id}/abort${query}`, {}).catch(() => {});
			await apiDelete(`/session/${session.id}${query}`).catch(() => {});
		}
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}, 420_000);
