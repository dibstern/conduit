import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqlError } from "@effect/sql/SqlError";
import {
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Queue,
	Stream,
} from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderInstanceIdSchema } from "../../../../src/lib/contracts/provider-instance.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	type OpenCodeInstanceEvent,
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
	type OpenCodeRuntimeIngressLog,
} from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	type ProviderRuntimeIngestion,
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ConfigTag } from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../../src/lib/domain/relay/Services/session-manager-service.js";
import { createSilentLogger } from "../../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import type { ProjectionRunnerEffect } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import { opencodeSessionCreatedRuntimeEvent } from "../../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import { createProjectRelay } from "../../../../src/lib/relay/relay-stack.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
} from "../../../helpers/mock-factories.js";
import {
	makeSSEEvent,
	makeUnknownSSEEvent,
} from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-effect-runtime-ingress-001";

// Failure modes: the selected instance's lifecycle uses the default alias while
// established sessions retain its named binding, alias sessions also need to
// settle, secondary stops must stay isolated, and permission/question waits
// must remain pending. The real relay graph runs without listening on sockets.
describe("selected OpenCode stop through the relay graph", () => {
	it.each([
		{ selectedId: "managed-test", stoppedId: "managed-test" },
		{ selectedId: "opencode", stoppedId: "opencode" },
		{ selectedId: "managed-test", stoppedId: "secondary" },
	])("settles $stoppedId with selected $selectedId while preserving other bindings and waits", async ({
		selectedId,
		stoppedId,
	}) => {
		mkdirSync("test-results", { recursive: true });
		const dir = mkdtempSync(
			join(process.cwd(), "test-results", "rqbc-named-stop-"),
		);
		const server = createServer();
		const events = await Effect.runPromise(
			Queue.unbounded<OpenCodeInstanceEvent>(),
		);
		const client = makeMockOpenCodeAPI();
		const send = (
			instanceId: string,
			payload: ReturnType<typeof makeSSEEvent>,
		) =>
			Queue.offer(events, {
				_tag: "event",
				instanceId: instanceId === "opencode" ? selectedId : instanceId,
				payload,
				health: {
					connected: false,
					stale: false,
					lastEventAt: null,
					reconnectCount: 0,
				},
			});
		const instances: OpenCodeInstances = {
			events: () => Stream.fromQueue(events),
			use: () => Effect.succeed(client),
			ifRunning: () => Effect.succeed(Option.none()),
			stop: (instanceId) =>
				Queue.offer(events, {
					_tag: "connection",
					instanceId,
					state: "stopped",
					managedStopped: true,
					health: {
						connected: false,
						stale: false,
						lastEventAt: null,
						reconnectCount: 0,
					},
				}).pipe(Effect.asVoid),
		};
		let relay: Awaited<ReturnType<typeof createProjectRelay>> | undefined;
		try {
			relay = await createProjectRelay({
				httpServer: server,
				noServer: true,
				projectDir: dir,
				configDir: dir,
				persistenceDbPath: join(dir, "events.db"),
				slug: "named-stop",
				openCodeInstanceId: selectedId,
				openCodeInstances: instances,
				publishGlobalSetting: () => Effect.void,
				log: createSilentLogger(),
			});
			const runtime = relay.effectRuntime.runtime;
			const rows = [
				{ id: "selected-work", provider: selectedId },
				{ id: "alias-work", provider: "opencode" },
				{ id: "secondary-work", provider: "secondary" },
				{ id: "selected-permission", provider: selectedId },
				{ id: "alias-question", provider: "opencode" },
			];
			await runtime.runPromise(
				Effect.gen(function* () {
					const manager = yield* SessionManagerServiceTag;
					const view = yield* OpenCodeInstancesTag;
					// Receiving secondary lifecycle events requires a used/restored binding.
					yield* view.use("secondary").pipe(Effect.scoped);
					for (const row of rows) {
						yield* manager.establishOpenCodeSession(
							{
								id: row.id,
								projectID: "named-stop",
								directory: dir,
								title: row.id,
								version: "test",
								time: { created: 0, updated: 0 },
							},
							ProviderInstanceIdSchema.make(row.provider),
						);
						yield* send(
							row.provider,
							makeSSEEvent("session.status", {
								sessionID: row.id,
								status: { type: "busy" },
							}),
						);
					}
					yield* send(
						selectedId,
						makeSSEEvent("permission.asked", {
							id: "stop-permission",
							sessionID: "selected-permission",
							permission: "bash",
							patterns: ["git *"],
							metadata: {},
							always: [],
						}),
					);
					yield* send(
						"opencode",
						makeSSEEvent("question.asked", {
							id: "stop-question",
							sessionID: "alias-question",
							questions: [],
						}),
					);
				}),
			);
			const snapshot = () =>
				runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						return yield* sql<{ id: string; provider: string; status: string }>`
					SELECT id, provider, status FROM sessions ORDER BY id`;
					}),
				);
			await vi.waitFor(async () => {
				expect(await snapshot()).toEqual(
					rows
						.map((row) => ({ ...row, status: "busy" }))
						.sort((a, b) => a.id.localeCompare(b.id)),
				);
				expect(
					await runtime.runPromise(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM pending_approvals WHERE status = 'pending'`;
						}),
					),
				).toEqual([{ count: 2 }]);
			});
			await runtime.runPromise(
				Effect.flatMap(OpenCodeInstancesTag, (view) => view.stop(stoppedId)),
			);
			await vi.waitFor(async () => {
				expect(await snapshot()).toEqual(
					rows
						.map((row) => ({
							...row,
							status:
								row.id.endsWith("work") &&
								(stoppedId === selectedId
									? row.provider === selectedId || row.provider === "opencode"
									: row.provider === stoppedId)
									? "idle"
									: "busy",
						}))
						.sort((a, b) => a.id.localeCompare(b.id)),
				);
			});
			const proof = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						pending: yield* sql<{ type: string; status: string }>`
						SELECT type, status FROM pending_approvals ORDER BY type`,
						completed: yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE type = 'turn.completed'`,
					};
				}),
			);
			expect(proof.pending).toEqual([
				{ type: "permission", status: "pending" },
				{ type: "question", status: "pending" },
			]);
			expect(proof.completed).toEqual([{ count: 0 }]);
		} finally {
			await relay?.stop();
			server.close();
			await Effect.runPromise(Queue.shutdown(events));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function makeRuntime(filename: string) {
	const persistenceLayer = makePersistenceEffectLayer(filename, "test-project");
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
		projectEvent: vi.fn(() =>
			Effect.succeed({ version: 0, sessionIds: [], removedSessionIds: [] }),
		),
		projectBatch: vi.fn(() =>
			Effect.succeed({ version: 0, sessionIds: [], removedSessionIds: [] }),
		),
		recover: vi.fn(() =>
			Effect.succeed({
				projectId: "test-project",
				startCursor: 0,
				endCursor: 0,
				totalReplayed: 0,
				durationMs: 0,
			}),
		),
		getFailures: vi.fn(() => Effect.succeed([])),
		isRecovered: vi.fn(() => Effect.succeed(true)),
		markRecovered: vi.fn(() => Effect.void),
		nextVersion: Effect.succeed(0),
	} satisfies ProjectionRunnerEffect;
}

function makeFakeIngress(options?: {
	readonly ingestBatch?: (
		events: readonly ProviderRuntimeEvent[],
	) => Effect.Effect<number, ProviderRuntimeIngestionError>;
}) {
	// Stand-in for the sessions table: a committed session.created projects it.
	const projected = new Set<string>();
	const ingestion = {
		ingest: vi.fn((_event: ProviderRuntimeEvent) => Effect.succeed(1)),
		ingestBatch: vi.fn(
			(
				events: readonly ProviderRuntimeEvent[],
				ingestOptions?: { readonly afterCommit?: Effect.Effect<void> },
			) =>
				(options?.ingestBatch?.(events) ?? Effect.succeed(events.length)).pipe(
					Effect.tap(() => {
						for (const event of events)
							if (event.type === "session.created")
								projected.add(event.sessionId);
					}),
					// Stand in for the durable boundary: only a batch that committed
					// runs afterCommit.
					Effect.tap(() => ingestOptions?.afterCommit ?? Effect.void),
				),
		),
		drain: vi.fn(() => Effect.void),
	} satisfies ProviderRuntimeIngestion;
	const log = makeLogger();
	const hook = new EffectOpenCodeRuntimeIngress({
		sql: ((strings: TemplateStringsArray, ...values: unknown[]) =>
			Effect.succeed(
				strings.join("?").includes("FROM sessions") &&
					projected.has(String(values[0]))
					? [{ id: values[0] }]
					: [],
			)) as unknown as SqlClient.SqlClient,
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

	it.each([
		"opencode",
		"managed-test",
	])("rolls back %s stop settlement when a new instance lifecycle starts before commit", async (selectedId) => {
		if (!hook || !runtime) throw new Error("test runtime not initialized");
		await Effect.runPromise(
			hook.onSSEEventEffect(
				makeSSEEvent("session.status", {
					sessionID: SESSION_ID,
					status: { type: "busy" },
				}),
				SESSION_ID,
				selectedId,
			),
		);
		const entered = await Effect.runPromise(Deferred.make<void>());
		const release = await Effect.runPromise(Deferred.make<void>());
		const stopIngress = await runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				return yield* makeEffectOpenCodeRuntimeIngress(makeLogger()).pipe(
					Effect.provideService(ProviderRuntimeIngestionTag, {
						...ingestion,
						ingestBatch: (events, options = {}) =>
							ingestion.ingestBatch(events, {
								...options,
								beforeCommit: Deferred.succeed(entered, undefined).pipe(
									Effect.zipRight(Deferred.await(release)),
									Effect.zipRight(options.beforeCommit ?? Effect.void),
								),
							}),
					}),
					Effect.provideService(
						ConfigTag,
						makeMockConfig({ openCodeInstanceId: selectedId }),
					),
				);
			}),
		);
		let current = true;
		const stopped = Effect.runPromiseExit(
			stopIngress.onInstanceStopped("opencode", () => current),
		);
		await Effect.runPromise(Deferred.await(entered));
		current = false;
		await Effect.runPromise(Deferred.succeed(release, undefined));
		await stopped;
		const rows = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ status: string }>`
					SELECT status FROM sessions WHERE id = ${SESSION_ID}`;
			}),
		);
		expect(rows).toEqual([{ status: "busy" }]);
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
				Effect.fail(
					new SqlError({ message: "SQLITE_BUSY: database is locked" }),
				),
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
