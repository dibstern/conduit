// ─── OpenCode Runtime Ingress Projection Integration Test ───────────────────
// End-to-end: SSE event → EffectOpenCodeRuntimeIngress →
// ProviderRuntimeIngestion → append → project → verify read model tables.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	type EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
	type OpenCodeRuntimeIngressLog,
} from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import type { Message } from "../../../../src/lib/instance/sdk-types.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectorCursorEffectTag } from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { createEventId } from "../../../../src/lib/persistence/events.js";
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
	sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
) {
	const persistenceLayer = makePersistenceEffectLayer(filename, projectors);
	const ingestionDeps = sessionEventBusLayer
		? Layer.merge(persistenceLayer, sessionEventBusLayer)
		: persistenceLayer;
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(ingestionDeps)),
		),
	);
}

/** A change-signal bus whose first publish fails the way `outcome` says, so a
 *  test can prove that a post-commit publication defect cannot un-commit the
 *  translation state that explains the already durable batch. */
function makeFailFirstBusLayer(
	outcome: Effect.Effect<never>,
): Layer.Layer<SessionEventBusTag> {
	let published = 0;
	return Layer.succeed(SessionEventBusTag, {
		publish: () => (published++ === 0 ? outcome : Effect.void),
		publishAdvance: () => Effect.void,
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
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
		hook?.shutdown();
		await runtime?.dispose();
		hook = undefined;
		runtime = undefined;
	}

	async function startRuntime(
		projectors: readonly EffectProjector[] = createAllEffectProjectors(),
		sessionEventBusLayer?: Layer.Layer<SessionEventBusTag>,
		fetchSessionMessages?: Parameters<
			typeof makeEffectOpenCodeRuntimeIngress
		>[1],
	) {
		if (!dir) {
			dir = mkdtempSync(join(tmpdir(), "conduit-runtime-ingress-projection-"));
			dbPath = join(dir, "events.db");
		}
		if (!dbPath) throw new Error("test database path not initialized");
		log = makeLogger();
		const nextRuntime = makeRuntime(dbPath, projectors, sessionEventBusLayer);
		runtime = nextRuntime;
		hook = await nextRuntime.runPromise(
			makeEffectOpenCodeRuntimeIngress(log, fetchSessionMessages),
		);
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
		providerInstanceId = "opencode",
	) {
		return Effect.runPromise(
			currentHook().onSSEEventEffect(event, sessionId, providerInstanceId),
		);
	}

	async function ingestOk(
		event: Parameters<EffectOpenCodeRuntimeIngress["onSSEEventEffect"]>[0],
		sessionId = SESSION_ID,
		providerInstanceId = "opencode",
	) {
		const result = await ingest(event, sessionId, providerInstanceId);
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

	async function persistSessionCreated(
		sessionId: string,
		providerInstanceId: string,
	) {
		await currentRuntime().runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest({
					eventId: createEventId(),
					type: "session.created",
					providerId: "opencode",
					sessionId,
					providerRefs: { providerSessionId: sessionId },
					rawSource: { kind: "test.named-session-created" },
					createdAt: Date.now(),
					data: {
						sessionId,
						title: "Named session",
						provider: providerInstanceId,
					},
				} satisfies ProviderRuntimeEvent);
			}),
		);
	}

	async function readProviderBindings(sessionId: string) {
		return currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					session_provider: string;
					binding_provider: string;
				}>`
					SELECT
						sessions.provider AS session_provider,
						session_providers.provider AS binding_provider
					FROM sessions
					JOIN session_providers ON session_providers.session_id = sessions.id
					WHERE sessions.id = ${sessionId}
						AND session_providers.status = 'active'`;
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

	it("does not let the ingress session seeder overwrite an existing named provider", async () => {
		await persistSessionCreated(SESSION_ID, "work-oc");

		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-stale-seeder-001",
				info: { role: "assistant", parts: [] },
			}),
			SESSION_ID,
			"opencode",
		);

		expect(await readProviderBindings(SESSION_ID)).toEqual([
			{
				session_provider: "work-oc",
				binding_provider: "work-oc",
			},
		]);
	});

	it("seeds a first-seen named child with its OpenCode instance id", async () => {
		const childSessionId = "sess-proj-child-001";

		const result = await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: childSessionId,
				messageID: "msg-child-001",
				info: { role: "assistant", parts: [] },
			}),
			childSessionId,
			"work-oc",
		);

		expect(result.sessionSeeded).toBe(true);
		expect(await readProviderBindings(childSessionId)).toEqual([
			{
				session_provider: "work-oc",
				binding_provider: "work-oc",
			},
		]);
	});

	it("retains a named provider when a fresh ingress re-seeds after restart", async () => {
		await persistSessionCreated(SESSION_ID, "work-oc");
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-before-restart-001",
				info: { role: "assistant", parts: [] },
			}),
			SESSION_ID,
			"work-oc",
		);

		await disposeRuntime();
		await startRuntime();

		const result = await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-after-restart-001",
				info: { role: "assistant", parts: [] },
			}),
			SESSION_ID,
			"work-oc",
		);

		expect(result.sessionSeeded).toBe(true);
		expect(await readProviderBindings(SESSION_ID)).toEqual([
			{
				session_provider: "work-oc",
				binding_provider: "work-oc",
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

	// OpenCode names a sub-agent's parent only on session.created, which
	// translates to nothing; the session is seeded by its first translatable
	// event. Losing the parent there makes a sub-agent a root, and a root gets
	// the turn-end dot (conduit-test-hk9m.3).
	it("seeds a sub-agent under the parent its session.created named", async () => {
		const childId = "sess-proj-child";
		await persistSessionCreated(SESSION_ID, "opencode");
		await ingest(
			makeSSEEvent("session.created", {
				info: { id: childId, parentID: SESSION_ID, title: "Sub-agent" },
			}),
			childId,
		);
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: childId,
				info: {
					id: "child-msg-001",
					role: "assistant",
					time: { created: 1000, completed: 2000 },
				},
			}),
			childId,
		);

		const rows = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ parent_id: string | null; unread: number }>`
					SELECT parent_id, unread FROM sessions WHERE id = ${childId}`;
			}),
		);
		expect(rows).toEqual([{ parent_id: SESSION_ID, unread: 0 }]);
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

	it("projects modern OpenCode message content without duplicating completion", async () => {
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "user-msg-modern",
					role: "user",
					time: { created: 1000 },
				},
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				part: {
					id: "user-part-modern",
					sessionID: SESSION_ID,
					messageID: "user-msg-modern",
					type: "text",
					text: "ping",
				},
			}),
		);
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "assistant-msg-modern",
					role: "assistant",
					time: { created: 2000 },
				},
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "assistant-msg-modern",
				partID: "assistant-part-modern",
				field: "text",
				delta: "po",
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "assistant-msg-modern",
				partID: "assistant-part-modern",
				field: "text",
				delta: "n",
			}),
		);
		await ingestOk(
			makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				part: {
					id: "assistant-part-modern",
					sessionID: SESSION_ID,
					messageID: "assistant-msg-modern",
					type: "text",
					text: "pong",
				},
			}),
		);
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "assistant-msg-modern",
					role: "assistant",
					cost: 0.01,
					tokens: { input: 10, output: 2 },
					time: { created: 2000, completed: 2100 },
				},
			}),
		);

		const messages = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string; role: string; text: string }>`
					SELECT id, role, text
					FROM messages
					WHERE session_id = ${SESSION_ID}
					ORDER BY CASE WHEN role = 'user' THEN 0 ELSE 1 END, id`;
			}),
		);
		expect(messages).toEqual([
			{ id: "user-msg-modern", role: "user", text: "ping" },
			{ id: "assistant-msg-modern", role: "assistant", text: "pong" },
		]);

		const stored = await readStored();
		expect(
			stored.filter((event) => event.type === "turn.completed"),
		).toHaveLength(1);
	});

	it("rolls back repeated projector failures and stores exactly one deterministic session seed on retry", async () => {
		const failingProjector = makeFailingProjector();
		await disposeRuntime();
		await startRuntime([...createAllEffectProjectors(), failingProjector]);

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
			error: "simulated projection failure",
		});
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				eventType: "message.created",
				sessionId: SESSION_ID,
				error: expect.any(String),
			}),
		);

		expect(await readStored()).toEqual([]);
		expect(await readProviderBindings(SESSION_ID)).toEqual([]);

		const providerEventCount = 10;
		for (let index = 1; index < providerEventCount; index++) {
			const retryResult = await ingest(
				makeSSEEvent("message.created", {
					sessionID: SESSION_ID,
					messageID: `msg-retry-${index}`,
					info: { role: "assistant", parts: [] },
				}),
			);
			expect(retryResult).toMatchObject({
				ok: false,
				reason: "error",
				error: "simulated projection failure",
			});
			expect(await readStored()).toEqual([]);
			expect(await readProviderBindings(SESSION_ID)).toEqual([]);
		}
		expect(log.warn).toHaveBeenCalledTimes(providerEventCount);

		const projectedMessages = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string }>`
					SELECT id
					FROM messages
					WHERE session_id = ${SESSION_ID}`;
			}),
		);
		expect(projectedMessages).toEqual([]);

		vi.spyOn(failingProjector, "project").mockReturnValue(
			Effect.succeed({ stamped: [], removed: [] }),
		);
		const retryResult = await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: `msg-retry-${providerEventCount - 1}`,
				info: { role: "assistant", parts: [] },
			}),
		);
		expect(retryResult.sessionSeeded).toBe(true);
		const storedAfterRetry = await readStored();
		expect(storedAfterRetry.map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);
		expect(
			storedAfterRetry.filter((event) => event.type === "session.created"),
		).toEqual([
			expect.objectContaining({
				eventId: `evt_opencode_session_created_${SESSION_ID}`,
			}),
		]);
	});

	it("retries the session seed after a transient projector failure", async () => {
		let projectionAttempts = 0;
		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			{
				name: "transient-failing-message-projector",
				handles: ["message.created"],
				project: () => {
					projectionAttempts++;
					return projectionAttempts === 1
						? Effect.fail(
								new ProjectionError({
									projector: "transient-failing-message-projector",
									operation: "project",
									cause: new Error("simulated transient projection failure"),
								}),
							)
						: Effect.succeed({ stamped: [], removed: [] });
				},
			},
		]);

		const providerEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-transient-001",
			info: { role: "assistant", parts: [] },
		});
		const firstResult = await ingest(providerEvent);
		expect(firstResult).toMatchObject({
			ok: false,
			reason: "error",
			error: "simulated transient projection failure",
		});
		expect(await readStored()).toEqual([]);
		expect(await readProviderBindings(SESSION_ID)).toEqual([]);

		const recoveryResult = await ingest(providerEvent);
		expect(recoveryResult).toMatchObject({
			ok: true,
			sessionSeeded: true,
		});
		const stored = await readStored();
		expect(stored.map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);
		expect(stored[0]?.eventId).toBe(
			`evt_opencode_session_created_${SESSION_ID}`,
		);

		const projection = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sessions = yield* sql<{ id: string }>`
					SELECT id FROM sessions WHERE id = ${SESSION_ID}`;
				const messages = yield* sql<{ id: string }>`
					SELECT id FROM messages
					WHERE session_id = ${SESSION_ID}
					ORDER BY id`;
				return { sessions, messages };
			}),
		);
		expect(projection).toEqual({
			sessions: [{ id: SESSION_ID }],
			messages: [{ id: "msg-transient-001" }],
		});
	});

	it("retries an event for an already durable session after a projector failure", async () => {
		let projectionFails = false;
		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			{
				name: "toggleable-message-projector",
				handles: ["message.created"],
				project: () =>
					projectionFails
						? Effect.fail(
								new ProjectionError({
									projector: "toggleable-message-projector",
									operation: "project",
									cause: new Error("simulated projection failure"),
								}),
							)
						: Effect.succeed({ stamped: [], removed: [] }),
			},
		]);

		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-durable-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		const blocked = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-durable-002",
			info: { role: "assistant", parts: [] },
		});
		projectionFails = true;
		expect(await ingest(blocked)).toMatchObject({ ok: false, reason: "error" });
		expect((await readStored()).map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);

		projectionFails = false;
		expect(await ingest(blocked)).toMatchObject({ ok: true });

		const messages = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ id: string }>`
					SELECT id FROM messages
					WHERE session_id = ${SESSION_ID}
					ORDER BY id`;
			}),
		);
		expect(messages).toEqual([
			{ id: "msg-durable-001" },
			{ id: "msg-durable-002" },
		]);
	});

	it("keeps text emitted by a concurrent event when a rolled-back event is in flight", async () => {
		let releaseRollingBack = () => {};
		const rollingBackGate = new Promise<void>((resolve) => {
			releaseRollingBack = resolve;
		});
		let releaseSnapshot = () => {};
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});

		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			{
				name: "paused-failing-message-projector",
				handles: ["message.created"],
				project: () =>
					Effect.promise(() => rollingBackGate).pipe(
						Effect.andThen(
							Effect.fail(
								new ProjectionError({
									projector: "paused-failing-message-projector",
									operation: "project",
									cause: new Error("simulated projection failure"),
								}),
							),
						),
					),
			},
			{
				name: "gated-text-projector",
				handles: ["text.delta"],
				project: () =>
					Effect.promise(() => snapshotGate).pipe(
						Effect.as({ stamped: [], removed: [] }),
					),
			},
		]);

		const rollingBack = ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-concurrent",
				info: { role: "assistant", parts: [] },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));

		const snapshot = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: {
				id: "part-concurrent",
				sessionID: SESSION_ID,
				messageID: "msg-concurrent",
				type: "text",
				text: "hello",
			},
		});
		const snapshotRun = ingest(snapshot);
		await new Promise((resolve) => setTimeout(resolve, 25));

		releaseRollingBack();
		expect(await rollingBack).toMatchObject({ ok: false, reason: "error" });
		releaseSnapshot();
		expect(await snapshotRun).toMatchObject({ ok: true });

		await ingest(snapshot);

		const parts = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ text: string }>`
					SELECT text FROM message_parts
					WHERE id = ${"part-concurrent"}`;
			}),
		);
		expect(parts).toEqual([{ text: "hello" }]);
	});

	function textSnapshot(partId: string, messageId: string, text: string) {
		return makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: {
				id: partId,
				sessionID: SESSION_ID,
				messageID: messageId,
				type: "text",
				text,
			},
		});
	}

	async function historyFlag() {
		return currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ history_complete: number }>`
					SELECT history_complete FROM sessions WHERE id = ${SESSION_ID}`;
				return rows[0]?.history_complete;
			}),
		);
	}

	async function waitForCondition(check: () => Promise<boolean>) {
		for (let attempt = 0; attempt < 200; attempt++) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("timed out waiting for condition");
	}

	async function readPartText(partId: string) {
		return currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ text: string }>`
					SELECT text FROM message_parts WHERE id = ${partId}`;
			}),
		);
	}

	function pausedFailingMessageProjector(gate: Promise<void>): EffectProjector {
		return {
			name: "paused-failing-message-projector",
			handles: ["message.created"],
			project: () =>
				Effect.promise(() => gate).pipe(
					Effect.andThen(
						Effect.fail(
							new ProjectionError({
								projector: "paused-failing-message-projector",
								operation: "project",
								cause: new Error("simulated projection failure"),
							}),
						),
					),
				),
		};
	}

	it("keeps durable text out of a reconnect that lands while a rolled-back event holds the session gate", async () => {
		let releaseRollingBack = () => {};
		const rollingBackGate = new Promise<void>((resolve) => {
			releaseRollingBack = resolve;
		});

		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			pausedFailingMessageProjector(rollingBackGate),
		]);

		const snapshot = textSnapshot("part-reconnect", "msg-reconnect", "hello");
		await ingestOk(snapshot);

		const rollingBack = ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-reconnect-blocked",
				info: { role: "assistant", parts: [] },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));

		Effect.runFork(currentHook().onReconnect());

		releaseRollingBack();
		expect(await rollingBack).toMatchObject({ ok: false, reason: "error" });

		await ingest(snapshot);

		expect(await readPartText("part-reconnect")).toEqual([{ text: "hello" }]);
	});

	it("does not let an in-flight commit restore announcement state a reconnect discarded", async () => {
		let releaseGatedText = () => {};
		const gatedText = new Promise<void>((resolve) => {
			releaseGatedText = resolve;
		});

		await disposeRuntime();
		await startRuntime([
			...createAllEffectProjectors(),
			{
				name: "gated-text-projector",
				handles: ["text.delta"],
				project: () =>
					Effect.promise(() => gatedText).pipe(
						Effect.as({ stamped: [], removed: [] }),
					),
			},
		]);

		const created = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-announced",
			info: { role: "assistant", parts: [] },
		});
		await ingestOk(created);

		const inFlight = ingest(
			textSnapshot("part-announced", "msg-announced", "hi"),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));

		Effect.runFork(currentHook().onReconnect());

		releaseGatedText();
		expect(await inFlight).toMatchObject({ ok: true });

		// The reconnect asked for every message to be announced again; a batch
		// that was translated before it must not put the old answer back.
		expect(await ingest(created)).toMatchObject({ ok: true });
	});

	it("commits live events across reconnect and discards the stale REST result", async () => {
		let releaseFirst = () => {};
		const firstFetch = new Promise<readonly []>((resolve) => {
			releaseFirst = () => resolve([]);
		});
		let firstStarted = () => {};
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.promise(async () => {
				calls++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				if (calls === 1) {
					firstStarted();
					await firstFetch;
				}
				inFlight--;
				return [];
			}),
		);
		const first = ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-before-reconnect",
				info: { role: "assistant", parts: [] },
			}),
		);
		await started;
		const second = ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-after-reconnect",
				info: { role: "assistant", parts: [] },
			}),
		);
		await Effect.runPromise(currentHook().onReconnect());
		expect(await first).toMatchObject({ ok: true });
		expect(await second).toMatchObject({ ok: true });
		releaseFirst();
		for (let attempt = 0; calls < 2 && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(calls).toBe(2);
		expect(
			await ingest(
				makeSSEEvent("message.created", {
					sessionID: SESSION_ID,
					messageID: "msg-after-stale-fetch",
					info: { role: "assistant", parts: [] },
				}),
			),
		).toMatchObject({ ok: true });
		expect(maxInFlight).toBe(1);
		expect(
			(await readStored())
				.filter((event) => event.type === "message.created")
				.map((event) => event.data.messageId),
		).toEqual([
			"msg-before-reconnect",
			"msg-after-reconnect",
			"msg-after-stale-fetch",
		]);
	});

	it("persists a reconnect gap and retries an idle session after backoff", async () => {
		let calls = 0;
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.sync(() => {
				calls++;
				if (calls === 2) throw new Error("REST outage");
				return [
					{
						id: "msg-idle",
						sessionID: SESSION_ID,
						role: "assistant" as const,
						time: { created: Date.now(), completed: Date.now() },
						parts: [],
					},
				];
			}),
		);
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-idle",
				info: { role: "assistant", parts: [] },
			}),
		);
		const complete = () =>
			currentRuntime().runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const rows = yield* sql<{
						history_complete: number;
					}>`SELECT history_complete FROM sessions WHERE id = ${SESSION_ID}`;
					return rows[0]?.history_complete;
				}),
			);
		for (let attempt = 0; (await complete()) !== 1 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await complete()).toBe(1);
		await Effect.runPromise(currentHook().onReconnect());
		for (let attempt = 0; (await complete()) !== 0 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await complete()).toBe(0);
		for (let attempt = 0; calls < 3 && attempt < 200; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(3);
		expect(await complete()).toBe(1);
	});

	it("does not complete history from REST fetched before a live removal", async () => {
		let releaseFetch: ((messages: readonly Message[]) => void) | undefined;
		let calls = 0;
		const fetched = new Promise<readonly Message[]>((resolve) => {
			releaseFetch = resolve;
		});
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () => {
			calls++;
			return calls === 1 ? Effect.promise(() => fetched) : Effect.never;
		});
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-removed-during-fetch",
				info: { role: "assistant", parts: [] },
			}),
		);
		for (let attempt = 0; calls === 0 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);
		await ingest(
			makeSSEEvent("message.removed", {
				sessionID: SESSION_ID,
				messageID: "msg-removed-during-fetch",
			}),
		);
		releaseFetch?.([
			{
				id: "msg-removed-during-fetch",
				sessionID: SESSION_ID,
				role: "assistant",
				time: { created: Date.now() },
				parts: [],
			},
		]);
		for (let attempt = 0; calls < 2 && attempt < 200; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(2);
		expect(
			await Effect.runPromise(currentHook().isHistoryComplete(SESSION_ID)),
		).toBe(false);
	});

	it.each([
		{
			name: "unsettled text gap",
			storedText: "",
			restText: "hello",
			settled: false,
			expected: 0,
		},
		{
			name: "exact settled match",
			storedText: "hello",
			restText: "hello",
			settled: true,
			expected: 1,
		},
		{
			name: "settled text difference",
			storedText: "hello",
			restText: "goodbye",
			settled: true,
			expected: 1,
		},
	])("reconciles history content for $name", async ({
		storedText,
		restText,
		settled,
		expected,
	}) => {
		const created = Date.now() - 10_000;
		const messageId = "msg-content-proof";
		const partId = "part-content-proof";
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: messageId,
					sessionID: SESSION_ID,
					role: "assistant",
					time: { created },
				},
			}),
		);
		await ingestOk(textSnapshot(partId, messageId, "hello"));
		if (settled) {
			await ingestOk(
				makeSSEEvent("message.updated", {
					sessionID: SESSION_ID,
					info: {
						id: messageId,
						sessionID: SESSION_ID,
						role: "assistant",
						time: { created, completed: created + 1 },
					},
				}),
			);
		}
		if (storedText === "") {
			await currentRuntime().runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE message_parts SET text = '' WHERE id = ${partId}`;
				}),
			);
		}
		await disposeRuntime();
		let fetches = 0;
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.sync(() => {
				fetches++;
				return [
					{
						id: messageId,
						sessionID: SESSION_ID,
						role: "assistant",
						time: { created, ...(settled ? { completed: created + 1 } : {}) },
						parts: [{ id: partId, type: "text", text: restText }],
					},
				];
			}),
		);
		await ingest(
			makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			}),
		);
		await waitForCondition(async () => fetches > 0);
		if (expected === 1)
			await waitForCondition(async () => (await historyFlag()) === 1);
		else await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await historyFlag()).toBe(expected);
	});

	it("corrects a different REST tool output", async () => {
		const created = Date.now() - 10_000;
		let output = "first result";
		const fetch = () =>
			Effect.sync(() => [
				{
					id: "msg-tool-proof",
					sessionID: SESSION_ID,
					role: "assistant" as const,
					time: { created, completed: created + 1 },
					parts: [
						{
							id: "part-tool-proof",
							type: "tool",
							tool: "bash",
							callID: "call-tool-proof",
							state: {
								status: "completed",
								input: { command: "ls" },
								output,
								metadata: {},
							},
						},
					],
				},
			]);
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, fetch);
		await ingestOk(
			makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			}),
		);
		await waitForCondition(async () => (await historyFlag()) === 1);
		output = "different result";
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, fetch);
		await ingestOk(
			makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			}),
		);
		await waitForCondition(
			async () =>
				(await readStored()).filter(
					(event) =>
						event.type === "message.snapshot" &&
						event.data.messageId === "msg-tool-proof",
				).length === 2,
		);
		expect(await historyFlag()).toBe(1);
	});

	it("rechecks an imported row invalidated by a late event on session idle", async () => {
		let fetches = 0;
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.sync(() => {
				fetches++;
				return [
					{
						id: "msg-imported",
						sessionID: SESSION_ID,
						role: "user",
						time: { created: 1000 },
						parts: [
							{
								id: "part-imported",
								messageID: "msg-imported",
								type: "text",
								text: "hello",
							},
						],
					},
				];
			}),
		);
		await ingest(makeSSEEvent("session.created", { info: { id: SESSION_ID } }));
		await waitForCondition(async () => (await historyFlag()) === 1);
		await ingest(textSnapshot("part-imported", "msg-imported", "hello again"));
		expect(await historyFlag()).toBe(0);
		const before = fetches;
		await ingest(
			makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			}),
		);
		await waitForCondition(async () => fetches > before);
		await waitForCondition(async () => (await historyFlag()) === 1);
	});

	it("invalidates complete history when a live text part is rewritten", async () => {
		const created = Date.now() - 10_000;
		let releaseFirst: ((messages: readonly Message[]) => void) | undefined;
		const firstFetch = new Promise<readonly Message[]>((resolve) => {
			releaseFirst = resolve;
		});
		let fetches = 0;
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () => {
			fetches++;
			return fetches === 1
				? Effect.promise(() => firstFetch)
				: Effect.succeed([
						{
							id: "msg-rewrite",
							sessionID: SESSION_ID,
							role: "assistant",
							time: { created, completed: created + 1 },
							parts: [{ id: "part-rewrite", type: "text", text: "hello" }],
						},
					]);
		});
		await ingestOk(
			makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "msg-rewrite",
					sessionID: SESSION_ID,
					role: "assistant",
					time: { created, completed: created + 1 },
				},
			}),
		);
		await waitForCondition(async () => fetches === 1);
		await ingestOk(textSnapshot("part-rewrite", "msg-rewrite", "hello"));
		releaseFirst?.([]);
		await waitForCondition(async () => (await historyFlag()) === 1);
		await ingest(textSnapshot("part-rewrite", "msg-rewrite", "goodbye"));
		expect(await historyFlag()).toBe(0);
		expect(await readPartText("part-rewrite")).toEqual([{ text: "hello" }]);
	});

	it("counts stale REST fetches toward the pending attempt cap", async () => {
		let fetches = 0;
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.promise(async () => {
				fetches++;
				await ingest(
					makeSSEEvent("session.status", {
						sessionID: SESSION_ID,
						status: { type: "busy" },
					}),
				);
				return [];
			}),
		);
		await ingest(makeSSEEvent("session.created", { info: { id: SESSION_ID } }));
		await new Promise((resolve) => setTimeout(resolve, 8_000));
		expect(fetches).toBeLessThanOrEqual(3);
		expect(await historyFlag()).toBe(0);
	}, 12_000);

	it("limits concurrent REST history requests across sessions", async () => {
		let active = 0;
		let maxActive = 0;
		let started = 0;
		const releases: Array<() => void> = [];
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.promise(
				() =>
					new Promise<readonly Message[]>((resolve) => {
						active++;
						started++;
						maxActive = Math.max(maxActive, active);
						releases.push(() => {
							active--;
							resolve([]);
						});
					}),
			),
		);
		for (let index = 0; index < 6; index++) {
			const sessionId = `sess-backfill-limit-${index}`;
			await ingestOk(
				makeSSEEvent("message.created", {
					sessionID: sessionId,
					messageID: `msg-backfill-limit-${index}`,
					info: { role: "assistant", parts: [] },
				}),
				sessionId,
			);
		}
		for (let attempt = 0; started < 4 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(started).toBe(4);
		expect(maxActive).toBe(4);
		for (const release of releases.splice(0)) release();
		for (let attempt = 0; started < 6 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(started).toBe(6);
		expect(maxActive).toBe(4);
		for (const release of releases.splice(0)) release();
	});

	it("starts history reconciliation when the first sighting has no translation", async () => {
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.succeed([
				{
					id: "msg-from-rest",
					sessionID: SESSION_ID,
					role: "user",
					time: { created: 1000 },
					parts: [
						{ id: "part-from-rest", type: "text", text: "earlier question" },
					],
				},
			]),
		);
		const result = await ingest(
			makeSSEEvent("session.created", {
				info: { id: SESSION_ID, title: "Existing session" },
			}),
		);
		expect(result).toMatchObject({ ok: false, reason: "not-translatable" });
		for (let attempt = 0; attempt < 100; attempt++) {
			if (
				(await readStored()).some(
					(event) =>
						event.type === "message.snapshot" &&
						event.data.messageId === "msg-from-rest",
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(
			(await readStored()).some(
				(event) =>
					event.type === "message.snapshot" &&
					event.data.messageId === "msg-from-rest",
			),
		).toBe(true);
	});

	it("does not import a REST result after its session is removed", async () => {
		let release = () => {};
		const fetched = new Promise<readonly []>((resolve) => {
			release = () => resolve([]);
		});
		let started = () => {};
		const fetching = new Promise<void>((resolve) => {
			started = resolve;
		});
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), undefined, () =>
			Effect.promise(() => {
				started();
				return fetched;
			}),
		);
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-before-delete",
				info: { role: "assistant", parts: [] },
			}),
		);
		await fetching;
		await ingest(makeSSEEvent("session.deleted", { sessionID: SESSION_ID }));
		release();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const rows = await currentRuntime().runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					history_complete: number;
				}>`SELECT history_complete FROM sessions WHERE id = ${SESSION_ID}`;
			}),
		);
		expect(rows[0]?.history_complete).toBe(0);
	});

	it("rolls back an import when reconnect lands during projection", async () => {
		let calls = 0;
		let crossed = () => {};
		const crossedProjection = new Promise<void>((resolve) => {
			crossed = resolve;
		});
		let release = () => {};
		const laterFetch = new Promise<readonly Message[]>((resolve) => {
			release = () => resolve([]);
		});
		let reconnectInsideProjection = false;
		await disposeRuntime();
		await startRuntime(
			[
				...createAllEffectProjectors(),
				{
					name: "reconnect-during-rest-projection",
					handles: ["message.snapshot"],
					project: (event) =>
						Effect.sync(() => {
							if (
								event.metadata.rawSource === "opencode.rest" &&
								!reconnectInsideProjection
							) {
								reconnectInsideProjection = true;
								currentHook().onReconnect();
								crossed();
							}
							return { stamped: [], removed: [] };
						}),
				},
			],
			undefined,
			() =>
				Effect.promise<readonly Message[]>(() => {
					calls++;
					if (calls === 1) return Promise.resolve<readonly Message[]>([]);
					if (calls === 2)
						return Promise.resolve([
							{
								id: "msg-rest-stale",
								sessionID: SESSION_ID,
								role: "user",
								time: { created: Date.now() + 60_000 },
								parts: [{ id: "part-rest-stale", type: "text", text: "old" }],
							},
						]);
					return laterFetch;
				}),
		);
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-live",
				info: { role: "assistant", parts: [] },
			}),
		);
		for (let attempt = 0; calls < 1 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await Effect.runPromise(currentHook().onReconnect());
		await crossedProjection;
		for (let attempt = 0; calls < 3 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			(await readStored()).some(
				(event) =>
					event.type === "message.snapshot" &&
					event.data.messageId === "msg-rest-stale",
			),
		).toBe(false);
		release();
	});

	it("reconciles again when reconnect lands after REST commit", async () => {
		let fetches = 0;
		let armed = false;
		let reconnected = false;
		const bus = Layer.succeed(SessionEventBusTag, {
			publish: () => Effect.void,
			publishAdvance: () =>
				Effect.sync(() => {
					if (armed && !reconnected) {
						reconnected = true;
						Effect.runFork(currentHook().onReconnect());
					}
				}),
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.empty),
		} satisfies SessionEventBus);
		await disposeRuntime();
		await startRuntime(createAllEffectProjectors(), bus, () =>
			Effect.sync(() => {
				fetches++;
				return fetches === 1
					? []
					: [
							{
								id: "msg-live-after-commit",
								sessionID: SESSION_ID,
								role: "assistant" as const,
								time: { created: Date.now() },
								parts: [],
							},
							{
								id: "msg-rest-after-commit",
								sessionID: SESSION_ID,
								role: "user",
								time: { created: Date.now() + 60_000 },
								parts: [
									{
										id: "part-rest-after-commit",
										type: "text",
										text: "earlier",
									},
								],
							},
						];
			}),
		);
		await ingestOk(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-live-after-commit",
				info: { role: "assistant", parts: [] },
			}),
		);
		for (let attempt = 0; fetches < 1 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		armed = true;
		await Effect.runPromise(currentHook().onReconnect());
		for (let attempt = 0; fetches < 3 && attempt < 100; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reconnected).toBe(true);
		expect(fetches).toBe(3);
		expect(
			await Effect.runPromise(currentHook().isHistoryComplete(SESSION_ID)),
		).toBe(false);
	});

	it("keeps translation state committed when post-commit publication dies", async () => {
		await disposeRuntime();
		await startRuntime(
			createAllEffectProjectors(),
			makeFailFirstBusLayer(Effect.die(new Error("bus publish exploded"))),
		);

		const snapshot = textSnapshot("part-publish-die", "msg-publish", "hello");
		await expect(ingest(snapshot)).rejects.toThrow();
		expect(await readPartText("part-publish-die")).toEqual([{ text: "hello" }]);

		await ingest(snapshot);

		expect(await readPartText("part-publish-die")).toEqual([{ text: "hello" }]);
	});

	it("keeps translation state committed when post-commit publication is interrupted", async () => {
		await disposeRuntime();
		await startRuntime(
			createAllEffectProjectors(),
			makeFailFirstBusLayer(Effect.interrupt),
		);

		const snapshot = textSnapshot("part-publish-int", "msg-publish", "hello");
		await expect(ingest(snapshot)).rejects.toThrow();
		expect(await readPartText("part-publish-int")).toEqual([{ text: "hello" }]);

		await ingest(snapshot);

		expect(await readPartText("part-publish-int")).toEqual([{ text: "hello" }]);
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
