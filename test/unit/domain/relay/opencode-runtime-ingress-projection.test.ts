// ─── OpenCode Runtime Ingress Projection Integration Test ───────────────────
// End-to-end: SSE event → EffectOpenCodeRuntimeIngress →
// ProviderRuntimeIngestion → append → project → verify read model tables.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
	type OpenCodeRuntimeIngressLog,
} from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectorCursorEffectTag } from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-proj-001";

function makeLogger(): OpenCodeRuntimeIngressLog & {
	warn: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	verbose: ReturnType<typeof vi.fn>;
} {
	return {
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		verbose: vi.fn(),
	};
}

function makeRuntime(
	filename: string,
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
) {
	const persistenceLayer = makePersistenceEffectLayer(filename, projectors);
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistenceLayer)),
		),
	);
}

function makeFailingProjector(): EffectProjector {
	return {
		name: "failing-message-projector",
		handles: ["message.created"],
		project: () =>
			Effect.fail(
				new ProjectionError({
					projector: "failing-message-projector",
					operation: "project",
					cause: new Error("simulated projection failure"),
				}),
			),
	};
}

describe("OpenCode Runtime Ingress Projection (SSE → append → project → read model)", () => {
	let dir: string | undefined;
	let dbPath: string | undefined;
	let runtime: ReturnType<typeof makeRuntime> | undefined;
	let log: ReturnType<typeof makeLogger>;
	let hook: EffectOpenCodeRuntimeIngress | undefined;

	async function disposeRuntime() {
		hook?.stopStatsLogging();
		await runtime?.dispose();
		hook = undefined;
		runtime = undefined;
	}

	async function startRuntime(
		projectors: readonly EffectProjector[] = createAllEffectProjectors(),
	) {
		if (!dir) {
			dir = mkdtempSync(join(tmpdir(), "conduit-runtime-ingress-projection-"));
			dbPath = join(dir, "events.db");
		}
		if (!dbPath) throw new Error("test database path not initialized");
		log = makeLogger();
		const nextRuntime = makeRuntime(dbPath, projectors);
		runtime = nextRuntime;
		hook = await nextRuntime.runPromise(makeEffectOpenCodeRuntimeIngress(log));
	}

	function currentRuntime() {
		if (!runtime) throw new Error("test runtime not initialized");
		return runtime;
	}

	function currentHook() {
		if (!hook) throw new Error("test ingress not initialized");
		return hook;
	}

	async function ingest(
		event: Parameters<EffectOpenCodeRuntimeIngress["onSSEEventEffect"]>[0],
		sessionId = SESSION_ID,
	) {
		return Effect.runPromise(currentHook().onSSEEventEffect(event, sessionId));
	}

	async function ingestOk(
		event: Parameters<EffectOpenCodeRuntimeIngress["onSSEEventEffect"]>[0],
		sessionId = SESSION_ID,
	) {
		const result = await ingest(event, sessionId);
		if (!result.ok) {
			throw new Error(
				`ingress failed for ${event.type}: ${result.reason}${result.error ? ` (${result.error})` : ""}`,
			);
		}
		return result;
	}

	async function readStored(sessionId = SESSION_ID) {
		return currentRuntime().runPromise(
			Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				return yield* eventStore.readBySession(sessionId);
			}),
		);
	}

	beforeEach(async () => {
		await startRuntime();
	});

	afterEach(async () => {
		await disposeRuntime();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		dbPath = undefined;
	});

	it("message.created SSE event creates event in store AND row in messages table", async () => {
		const result = await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const stored = await readStored();
		expect(stored).toHaveLength(2);
		expect(stored[0]?.type).toBe("session.created");
		expect(stored[1]?.type).toBe("message.created");

		const rows = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					session_id: string;
					message_id: string;
					role: string;
				}>`
					SELECT sessions.id AS session_id, messages.id AS message_id, messages.role
					FROM sessions
					JOIN messages ON messages.session_id = sessions.id
					WHERE sessions.id = ${SESSION_ID}`;
			}),
		);
		expect(rows).toEqual([
			{
				session_id: SESSION_ID,
				message_id: "msg-001",
				role: "assistant",
			},
		]);
	});

	it("session is seeded and session.created event creates session and provider projections", async () => {
		const result = await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		expect(result).toMatchObject({
			ok: true,
			sessionSeeded: true,
		});

		const rows = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					id: string;
					provider: string;
					session_provider: string;
				}>`
					SELECT sessions.id, sessions.provider, session_providers.provider AS session_provider
					FROM sessions
					JOIN session_providers ON session_providers.session_id = sessions.id
					WHERE sessions.id = ${SESSION_ID}`;
			}),
		);
		expect(rows).toEqual([
			{
				id: SESSION_ID,
				provider: "opencode",
				session_provider: "opencode",
			},
		]);
	});

	it("tool lifecycle events create message_parts rows", async () => {
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-tool-001",
				part: {
					type: "tool",
					id: "part-tool-001",
					tool: "Bash",
					callID: "call-001",
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
		);

		const started = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					id: string;
					message_id: string;
					tool_name: string;
				}>`
					SELECT id, message_id, tool_name
					FROM message_parts
					WHERE message_id = ${"msg-001"} AND type = 'tool'`;
			}),
		);
		expect(started).toHaveLength(1);
		expect(started[0]?.tool_name).toBe("Bash");

		await ingestOk(
			makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-tool-001",
				part: {
					type: "tool",
					id: "part-tool-001",
					tool: "Bash",
					callID: "call-001",
					state: { status: "completed", output: "file list" },
					time: { start: 1000, end: 1500 },
				},
			}),
		);

		const completed = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string; status: string }>`
					SELECT id, status
					FROM message_parts
					WHERE message_id = ${"msg-001"} AND type = 'tool'`;
			}),
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.status).toBe("completed");
	});

	it("turn.completed updates turn with cost/tokens", async () => {
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "user-msg-001",
				info: { role: "user", parts: [] },
			}),
		);
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "asst-msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "asst-msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "Hello world",
			}),
		);
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "asst-msg-001",
					role: "assistant",
					cost: 0.05,
					tokens: { input: 1000, output: 500 },
					time: { created: 1000, completed: 2000 },
				},
			}),
		);

		const stored = await readStored();
		expect(stored.some((event) => event.type === "turn.completed")).toBe(true);

		const turns = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					state: string;
					cost: number | null;
					tokens_in: number | null;
					tokens_out: number | null;
				}>`
					SELECT state, cost, tokens_in, tokens_out
					FROM turns
					WHERE session_id = ${SESSION_ID}`;
			}),
		);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			state: "completed",
			cost: 0.05,
			tokens_in: 1000,
			tokens_out: 500,
		});
	});

	it("projection errors are logged and surfaced while stored events remain durable", async () => {
		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			makeFailingProjector(),
		]);

		const result = await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		expect(result).toMatchObject({
			ok: false,
			reason: "error",
		});
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				eventType: "message.created",
				sessionId: SESSION_ID,
				error: expect.any(String),
				durableSession: true,
			}),
		);

		const stored = await readStored();
		expect(stored.map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);

		const retryResult = await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-002",
				info: { role: "assistant", parts: [] },
			}),
		);

		expect(retryResult).toMatchObject({
			ok: true,
			eventsWritten: 1,
			sessionSeeded: false,
		});

		const storedAfterRetry = await readStored();
		expect(
			storedAfterRetry.filter((event) => event.type === "session.created"),
		).toHaveLength(1);
	});

	it("projector cursors advance after successful projection", async () => {
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		const stored = await readStored();
		expect(
			stored.map((event) => ({ sequence: event.sequence, type: event.type })),
		).toEqual([
			{ sequence: 1, type: "session.created" },
			{ sequence: 2, type: "message.created" },
		]);
		const expectedLastSequence = stored[1]?.sequence;

		const cursors = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const cursorRepo = yield* ProjectorCursorEffectTag;
				return yield* cursorRepo.listAll();
			}),
		);
		const cursorByName = new Map(
			cursors.map((cursor) => [cursor.projectorName, cursor.lastAppliedSeq]),
		);
		expect(cursorByName.get("session")).toBe(expectedLastSequence);
		expect(cursorByName.get("message")).toBe(expectedLastSequence);
		expect(cursorByName.get("provider")).toBe(expectedLastSequence);
	});

	it("text.delta creates a text part in message_parts", async () => {
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "Hello world",
			}),
		);

		const parts = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string; message_id: string; text: string }>`
					SELECT id, message_id, text
					FROM message_parts
					WHERE message_id = ${"msg-001"} AND type = 'text'`;
			}),
		);
		expect(parts).toEqual([
			{
				id: "part-text-001",
				message_id: "msg-001",
				text: "Hello world",
			},
		]);
	});

	it("multiple SSE events build correct read model state", async () => {
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "Here is the result: ",
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "success",
			}),
		);

		const parts = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ text: string }>`
					SELECT text
					FROM message_parts
					WHERE message_id = ${"msg-001"} AND type = 'text'`;
			}),
		);
		expect(parts).toEqual([{ text: "Here is the result: success" }]);
	});

	it("recovers read model projections from stored domain events", async () => {
		await disposeRuntime();
		await startRuntime([]);

		const result = await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: "sess-recover-001",
				messageID: "msg-recover-001",
				info: { role: "assistant", parts: [] },
			}),
			"sess-recover-001",
		);
		expect(result.eventsWritten).toBe(2);

		const beforeRecovery = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string }>`
					SELECT id
					FROM messages
					WHERE session_id = ${"sess-recover-001"}`;
			}),
		);
		expect(beforeRecovery).toHaveLength(0);

		await disposeRuntime();
		await startRuntime();

		const afterRecovery = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string; role: string }>`
					SELECT id, role
					FROM messages
					WHERE session_id = ${"sess-recover-001"}`;
			}),
		);
		expect(afterRecovery).toEqual([
			{
				id: "msg-recover-001",
				role: "assistant",
			},
		]);
	});
});
