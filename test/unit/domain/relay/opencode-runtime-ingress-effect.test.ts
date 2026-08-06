import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
	type OpenCodeRuntimeIngressLog,
} from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import type { ProjectionRunnerEffect } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import { opencodeSessionCreatedRuntimeEvent } from "../../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import {
	makeSSEEvent,
	makeUnknownSSEEvent,
} from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-effect-runtime-ingress-001";

function makeRuntime(filename: string) {
	const persistenceLayer = makePersistenceEffectLayer(filename);
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistenceLayer)),
		),
	);
}

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

function makeProjectionRunner(): ProjectionRunnerEffect {
	return {
		projectEvent: vi.fn(() => Effect.void),
		projectBatch: vi.fn(() => Effect.void),
		recover: vi.fn(() =>
			Effect.succeed({
				startCursor: 0,
				endCursor: 0,
				totalReplayed: 0,
				durationMs: 0,
			}),
		),
		getFailures: vi.fn(() => Effect.succeed([])),
		isRecovered: vi.fn(() => Effect.succeed(true)),
		markRecovered: vi.fn(() => Effect.void),
	} satisfies ProjectionRunnerEffect;
}

function makeFakeIngress(options?: {
	readonly ingestBatch?: (
		events: readonly ProviderRuntimeEvent[],
	) => Effect.Effect<number, unknown>;
}) {
	const ingestion = {
		ingest: vi.fn((_event: ProviderRuntimeEvent) => Effect.succeed(1)),
		ingestBatch: vi.fn(
			(events: readonly ProviderRuntimeEvent[]) =>
				options?.ingestBatch?.(events) ?? Effect.succeed(events.length),
		),
		drain: vi.fn(() => Effect.void),
	} satisfies ProviderRuntimeIngestion;
	const log = makeLogger();
	const hook = new EffectOpenCodeRuntimeIngress({
		sql: {} as SqlClient.SqlClient,
		projectionRunner: makeProjectionRunner(),
		ingestion,
		log,
	});

	return { hook, ingestion, log };
}

describe("EffectOpenCodeRuntimeIngress", () => {
	let dir: string | undefined;
	let runtime: ReturnType<typeof makeRuntime> | undefined;
	let hook: EffectOpenCodeRuntimeIngress | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-effect-runtime-ingress-"));
		const filename = join(dir, "events.db");
		const testRuntime = makeRuntime(filename);
		runtime = testRuntime;
		hook = await testRuntime.runPromise(
			makeEffectOpenCodeRuntimeIngress(makeLogger()),
		);
	});

	afterEach(async () => {
		hook?.stopStatsLogging();
		await runtime?.dispose();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("persists and projects translated SSE events through Effect services", async () => {
		if (!hook || !runtime) throw new Error("test runtime not initialized");
		const result = await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("message.created", {
					sessionID: SESSION_ID,
					messageID: "msg-effect-001",
					info: { role: "assistant", parts: [] },
				}),
				SESSION_ID,
				"opencode",
			),
		);

		if (!result.ok) throw new Error(result.error ?? result.reason);
		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 2,
			sessionSeeded: true,
		});

		const rows = runtime.runSync(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					session_provider: string;
					message_id: string;
					message_role: string;
					event_count: number;
				}>`
					SELECT
						sessions.provider AS session_provider,
						messages.id AS message_id,
						messages.role AS message_role,
						(SELECT COUNT(*) FROM events WHERE session_id = ${SESSION_ID}) AS event_count
					FROM sessions
					JOIN messages ON messages.session_id = sessions.id
					WHERE sessions.id = ${SESSION_ID}`;
			}),
		);

		expect(rows).toEqual([
			{
				session_provider: "opencode",
				message_id: "msg-effect-001",
				message_role: "assistant",
				event_count: 2,
			},
		]);
	});

	it("does not recreate a durable OpenCode session after ingress restarts", async () => {
		if (!runtime) throw new Error("test runtime not initialized");
		await runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					opencodeSessionCreatedRuntimeEvent(SESSION_ID, "opencode"),
				);
			}),
		);

		const restartedIngress = await runtime.runPromise(
			makeEffectOpenCodeRuntimeIngress(makeLogger()),
		);
		const result = await Effect.runPromise(
			restartedIngress.onSSEEventEffect(
				makeSSEEvent("message.created", {
					sessionID: SESSION_ID,
					messageID: "msg-after-restart",
					info: { role: "assistant", parts: [] },
				}),
				SESSION_ID,
				"opencode",
			),
		);
		const creationCount = runtime.runSync(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
					WHERE session_id = ${SESSION_ID} AND type = 'session.created'`;
				return rows[0]?.count;
			}),
		);

		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 1,
			sessionSeeded: true,
		});
		expect(creationCount).toBe(1);
	});
});

describe("EffectOpenCodeRuntimeIngress ProviderRuntimeIngestion boundary", () => {
	it("returns no-session and does not ingest when sessionId is missing", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			info: { role: "assistant", parts: [] },
		});

		const result = await Effect.runPromise(
			hook.onSSEEventEffect(event, undefined, "opencode"),
		);

		expect(result).toEqual({ ok: false, reason: "no-session" });
		expect(ingestion.ingestBatch).not.toHaveBeenCalled();
	});

	it("returns not-translatable for non-translatable SSE events", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const event = makeUnknownSSEEvent("pty.data", {
			sessionID: SESSION_ID,
			data: "some terminal output",
		});

		const result = await Effect.runPromise(
			hook.onSSEEventEffect(event, SESSION_ID, "opencode"),
		);

		expect(result).toEqual({ ok: false, reason: "not-translatable" });
		expect(ingestion.ingestBatch).not.toHaveBeenCalled();
	});

	it("seeds the first translatable event for a session before ingesting translated events", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			info: { role: "assistant", parts: [] },
		});

		const result = await Effect.runPromise(
			hook.onSSEEventEffect(event, SESSION_ID, "opencode"),
		);

		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 2,
			sessionSeeded: true,
		});
		expect(ingestion.ingestBatch).toHaveBeenCalledTimes(1);
		const batch = ingestion.ingestBatch.mock.calls[0]?.[0];
		expect(batch?.map((runtimeEvent) => runtimeEvent.type)).toEqual([
			"session.created",
			"message.created",
		]);
		expect(batch?.[0]).toMatchObject({
			type: "session.created",
			providerId: "opencode",
			sessionId: SESSION_ID,
			data: {
				sessionId: SESSION_ID,
				title: "Untitled",
				provider: "opencode",
			},
			metadata: {
				synthetic: true,
				source: "opencode-runtime-ingress",
			},
		});
		expect(batch?.[1]).toMatchObject({
			type: "message.created",
			providerId: "opencode",
			sessionId: SESSION_ID,
			data: {
				messageId: "msg-effect-001",
				role: "assistant",
				sessionId: SESSION_ID,
			},
		});
	});

	it("seeds the first translatable event with the per-call provider instance id", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-named-001",
			info: { role: "assistant", parts: [] },
		});

		await Effect.runPromise(
			hook.onSSEEventEffect(event, SESSION_ID, "work-oc"),
		);

		const batch = ingestion.ingestBatch.mock.calls[0]?.[0];
		expect(batch?.[0]).toMatchObject({
			type: "session.created",
			providerId: "opencode",
			data: {
				provider: "work-oc",
			},
		});
		expect(batch?.[1]).toMatchObject({
			type: "message.created",
			providerId: "opencode",
		});
	});

	it("keeps interleaved provider instance ids isolated on one shared ingress", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const workSessionId = "sess-effect-work-001";
		const personalSessionId = "sess-effect-personal-001";

		await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("message.created", {
					sessionID: workSessionId,
					messageID: "msg-effect-work-001",
					info: { role: "assistant", parts: [] },
				}),
				workSessionId,
				"work-oc",
			),
		);
		await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("message.created", {
					sessionID: personalSessionId,
					messageID: "msg-effect-personal-001",
					info: { role: "assistant", parts: [] },
				}),
				personalSessionId,
				"personal-oc",
			),
		);
		await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("message.part.delta", {
					sessionID: workSessionId,
					messageID: "msg-effect-work-001",
					partID: "part-effect-work-001",
					field: "text",
					delta: "work",
				}),
				workSessionId,
				"work-oc",
			),
		);
		await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("message.part.delta", {
					sessionID: personalSessionId,
					messageID: "msg-effect-personal-001",
					partID: "part-effect-personal-001",
					field: "text",
					delta: "personal",
				}),
				personalSessionId,
				"personal-oc",
			),
		);

		expect(ingestion.ingestBatch.mock.calls[0]?.[0]?.[0]).toMatchObject({
			type: "session.created",
			sessionId: workSessionId,
			data: { provider: "work-oc" },
		});
		expect(ingestion.ingestBatch.mock.calls[1]?.[0]?.[0]).toMatchObject({
			type: "session.created",
			sessionId: personalSessionId,
			data: { provider: "personal-oc" },
		});
		expect(
			ingestion.ingestBatch.mock.calls[2]?.[0]?.map((event) => event.type),
		).toEqual(["text.delta"]);
		expect(
			ingestion.ingestBatch.mock.calls[3]?.[0]?.map((event) => event.type),
		).toEqual(["text.delta"]);
	});

	it("does not emit duplicate session.created events for later events in the same session", async () => {
		const { hook, ingestion } = makeFakeIngress();
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			info: { role: "assistant", parts: [] },
		});
		await Effect.runPromise(
			hook.onSSEEventEffect(createEvent, SESSION_ID, "opencode"),
		);
		ingestion.ingestBatch.mockClear();

		const deltaEvent = makeSSEEvent("message.part.delta", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			partID: "part-effect-001",
			field: "text",
			delta: "Hello world",
		});
		const result = await Effect.runPromise(
			hook.onSSEEventEffect(deltaEvent, SESSION_ID, "opencode"),
		);

		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 1,
			sessionSeeded: false,
		});
		expect(ingestion.ingestBatch).toHaveBeenCalledTimes(1);
		const batch = ingestion.ingestBatch.mock.calls[0]?.[0];
		expect(batch?.map((runtimeEvent) => runtimeEvent.type)).toEqual([
			"text.delta",
		]);
	});

	it("returns error and increments error stats when ingestion fails", async () => {
		const { hook } = makeFakeIngress({
			ingestBatch: () =>
				Effect.fail(new Error("SQLITE_BUSY: database is locked")),
		});
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			info: { role: "assistant", parts: [] },
		});

		const result = await Effect.runPromise(
			hook.onSSEEventEffect(event, SESSION_ID, "opencode"),
		);

		expect(result).toMatchObject({
			ok: false,
			reason: "error",
			error: "SQLITE_BUSY: database is locked",
		});
		expect(hook.getStats().errors).toBe(1);
	});

	it("onReconnect resets translator state without clearing already-seen sessions", async () => {
		const { hook, ingestion, log } = makeFakeIngress();
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			info: { role: "assistant", parts: [] },
		});
		await Effect.runPromise(
			hook.onSSEEventEffect(createEvent, SESSION_ID, "opencode"),
		);

		const toolPending = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Read",
				callID: "call-001",
				state: { status: "pending", input: {} },
			},
		});
		await Effect.runPromise(
			hook.onSSEEventEffect(toolPending, SESSION_ID, "opencode"),
		);

		hook.onReconnect();
		expect(log.info).toHaveBeenCalledWith(
			"opencode-runtime-ingress: translator reset on reconnect",
		);
		ingestion.ingestBatch.mockClear();

		const toolRunning = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-effect-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Read",
				callID: "call-001",
				state: { status: "running", input: {} },
			},
		});
		const result = await Effect.runPromise(
			hook.onSSEEventEffect(toolRunning, SESSION_ID, "opencode"),
		);

		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 2,
			sessionSeeded: false,
		});
		expect(ingestion.ingestBatch).toHaveBeenCalledTimes(1);
		const batch = ingestion.ingestBatch.mock.calls[0]?.[0];
		expect(batch?.map((runtimeEvent) => runtimeEvent.type)).toEqual([
			"tool.started",
			"tool.running",
		]);
	});
});
