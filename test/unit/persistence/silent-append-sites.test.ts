// The append sites that never published anything of their own. Each test drives
// the real site against a real SQLite file with the real projectors and a real
// SessionEventBus, and asks the two questions a subscriber cares about: did the
// row move, and did anyone say so?
//
// A durable stamp is not a notification. `announcedDuring` subscribes before the
// site runs and reads what came back, so a site that projects without publishing
// fails here rather than stranding a waiting client.
//
// Sites that do NOT reach a version-stamping projector are recorded here as
// failing-to-advance on purpose, so the gap is visible rather than assumed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Chunk, Deferred, Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { StatusPollerLive } from "../../../src/lib/domain/relay/Layers/status-poller-layer.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	makeSessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	persistSessionPermissionMode,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import {
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
} from "../../../src/lib/domain/relay/Services/session-title-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { EventSinkImpl } from "../../../src/lib/provider/event-sink.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const versionOf = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			version: number;
		}>`SELECT version FROM sessions WHERE id = ${sessionId}`;
		return rows[0]?.version;
	});

/**
 * The session ids a real subscriber was told about while `action` ran. The
 * subscription is acquired first so the advance cannot slip through the gap, and
 * the wait is bounded so a site that publishes nothing reports an empty list
 * instead of hanging.
 */
const announcedDuring = <A, E, R>(action: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const bus = yield* SessionEventBusTag;
		const advances = yield* bus.subscribeAdvances();
		yield* action;
		const seen = yield* Stream.runCollect(Stream.take(advances, 1)).pipe(
			Effect.timeoutTo({
				duration: "2 seconds",
				onTimeout: () => Chunk.empty<ReadModelAdvance>(),
				onSuccess: (chunk) => chunk,
			}),
		);
		return [...seen].flatMap((advance) => [...advance.sessionIds]);
	});

/** One assistant message is all the title generator reads. */
async function* assistantTitle(text: string): AsyncIterable<unknown> {
	yield { type: "assistant", message: { content: [{ type: "text", text }] } };
}

type RestStatuses = Awaited<ReturnType<OpenCodeAPI["session"]["statuses"]>>;

/** The poller layer, real persistence behind it, with REST answers we choose. */
const makeStatusPollerLayer = (dbPath: string, restStatuses: RestStatuses) => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue(restStatuses);
	const bus = makeSessionEventBusLive();
	return Layer.provideMerge(
		StatusPollerLive,
		Layer.mergeAll(
			bus,
			makePersistenceEffectLayer(dbPath, createAllEffectProjectors(), bus),
			Layer.succeed(ConfigTag, makeMockConfig({ persistenceDbPath: dbPath })),
			Layer.succeed(LoggerTag, makeMockLogger()),
			Layer.succeed(OpenCodeAPITag, api),
			makePollerStateLive(),
			makePollerPubSubLive(),
			RelayStatusSnapshotLive,
			makeSessionManagerStateLive(),
		),
	);
};

const seedBusySession = (sessionId: string, updatedAt: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			VALUES (${sessionId}, 'opencode', ${sessionId}, 'busy', 1000, ${updatedAt})`;
		expect(yield* versionOf(sessionId)).toBe(0);
	});

const withTempDb = async (body: (dbPath: string) => Promise<void>) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-silent-append-"));
	try {
		await body(join(dir, "events.db"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

it("establishOpenCodeSession advances the version of the session it seeds", async () => {
	await withTempDb(async (dbPath) => {
		const bus = makeSessionEventBusLive();
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				bus,
				makePersistenceEffectLayer(dbPath, createAllEffectProjectors(), bus),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
				Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
				Layer.succeed(LoggerTag, makeMockLogger()),
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const manager = yield* SessionManagerServiceTag;
					const announced = yield* announcedDuring(
						manager.establishOpenCodeSession(
							{
								id: "established",
								projectID: "project",
								directory: "/tmp/project",
								title: "Established",
								version: "1",
								time: { created: 1, updated: 1 },
							},
							defaultInstanceIdForDriver("opencode"),
						),
					);
					expect(yield* versionOf("established")).toBeGreaterThan(0);
					expect(announced).toContain("established");
				}).pipe(Effect.provide(layer), Effect.orDie),
			),
		);
	});
});

it("persistSessionPermissionMode advances the version of the session it edits", async () => {
	await withTempDb(async (dbPath) => {
		const bus = makeSessionEventBusLive();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
						VALUES ('permissioned', 'claude', 'Permissioned', 'idle', 1000, 1000)`;
					expect(yield* versionOf("permissioned")).toBe(0);

					const announced = yield* announcedDuring(
						persistSessionPermissionMode("permissioned", "full"),
					);

					expect(yield* versionOf("permissioned")).toBeGreaterThan(0);
					expect(announced).toContain("permissioned");
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							bus,
							makePersistenceEffectLayer(
								dbPath,
								createAllEffectProjectors(),
								bus,
							),
						),
					),
					Effect.orDie,
				),
			),
		);
	});
});

it("the status poller's corrective write advances the version", async () => {
	await withTempDb(async (dbPath) => {
		const layer = makeStatusPollerLayer(dbPath, {
			// REST disagrees with the projected row, which is what makes
			// reconciliation inject a corrective session.status event.
			corrected: { type: "idle" },
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* seedBusySession("corrected", Date.now());
					const poller = yield* StatusPollerTag;

					const announced = yield* announcedDuring(poller.reconcileNow());

					expect(yield* versionOf("corrected")).toBeGreaterThan(0);
					expect(announced).toContain("corrected");
				}).pipe(Effect.provide(layer), Effect.orDie),
			),
		);
	});
});

it("the status poller's staleness write advances the version", async () => {
	await withTempDb(async (dbPath) => {
		// REST knows nothing about the session, so only the staleness pass can
		// fire: busy for far longer than the 30-minute threshold.
		const layer = makeStatusPollerLayer(dbPath, {});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* seedBusySession("stale", 0);
					const poller = yield* StatusPollerTag;

					const announced = yield* announcedDuring(poller.reconcileNow());

					expect(yield* versionOf("stale")).toBeGreaterThan(0);
					expect(announced).toContain("stale");
				}).pipe(Effect.provide(layer), Effect.orDie),
			),
		);
	});
});

it("the auto-title rename advances the version of the session it renames", async () => {
	await withTempDb(async (dbPath) => {
		const renamed = await Effect.runPromise(Deferred.make<void>());
		const sessionManager = makeMockSessionManagerService({
			sendDualSessionLists: vi.fn(() => Deferred.succeed(renamed, undefined)),
		});
		const bus = makeSessionEventBusLive();
		const layer = Layer.provideMerge(
			makeSessionTitleServiceLive({
				queryFactory: () => assistantTitle("Investigate The OAuth Loop"),
			}),
			Layer.mergeAll(
				bus,
				makePersistenceEffectLayer(dbPath, createAllEffectProjectors(), bus),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(SessionManagerServiceTag, sessionManager),
				// The service only reports a finished rename through the ws
				// handler, so the test needs one to know when to look.
				Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
						VALUES ('titled', 'claude', 'Claude Session', 'idle', 1000, 1000)`;
					expect(yield* versionOf("titled")).toBe(0);

					const titles = yield* SessionTitleServiceTag;
					const announced = yield* announcedDuring(
						Effect.gen(function* () {
							yield* titles.startForFirstClaudeMessage({
								sessionId: "titled",
								firstMessage: "OAuth keeps redirecting after callback.",
							});
							yield* Deferred.await(renamed);
						}),
					);

					expect(yield* versionOf("titled")).toBeGreaterThan(0);
					expect(announced).toContain("titled");
				}).pipe(Effect.provide(layer), Effect.orDie),
			),
		);
	});
});

it("ensureClaudeSubagentSession announces the subagent session it creates", async () => {
	await withTempDb(async (dbPath) => {
		const bus = makeSessionEventBusLive();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					// A real session.created, because the subagent path refuses to
					// attach to a parent the event store has never heard of.
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent(
							"session.created",
							"agent-parent",
							{
								sessionId: "agent-parent",
								title: "Parent",
								provider: "claude",
							},
							{ provider: "claude" },
						),
					]);

					const persist = yield* ClaudeEventPersistEffectTag;
					const announced = yield* announcedDuring(
						persist.ensureClaudeSubagentSession({
							childSessionId: "agent-child",
							parentSessionId: "agent-parent",
							providerSessionId: "sdk-agent",
							title: "Explore Agent",
						}),
					);

					expect(yield* versionOf("agent-child")).toBeGreaterThan(0);
					expect(announced).toContain("agent-child");
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							bus,
							makePersistenceEffectLayer(
								dbPath,
								createAllEffectProjectors(),
								bus,
							),
						),
					),
					Effect.orDie,
				),
			),
		);
	});
});

it("persistClaudeSubagent announces the subagent session it writes messages to", async () => {
	await withTempDb(async (dbPath) => {
		const bus = makeSessionEventBusLive();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					// A real session.created, because the subagent path refuses to
					// attach to a parent the event store has never heard of.
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent(
							"session.created",
							"batch-parent",
							{
								sessionId: "batch-parent",
								title: "Parent",
								provider: "claude",
							},
							{ provider: "claude" },
						),
					]);

					const persist = yield* ClaudeEventPersistEffectTag;
					yield* persist.ensureClaudeSubagentSession({
						childSessionId: "batch-child",
						parentSessionId: "batch-parent",
						providerSessionId: "sdk-batch",
						title: "Batch Agent",
					});
					const before = yield* versionOf("batch-child");

					const announced = yield* announcedDuring(
						persist.persistClaudeSubagent({
							childSessionId: "batch-child",
							parentSessionId: "batch-parent",
							providerSessionId: "sdk-batch",
							title: "Batch Agent",
							events: [
								canonicalEvent(
									"message.created",
									"batch-child",
									{
										sessionId: "batch-child",
										messageId: "batch-m1",
										role: "assistant",
									},
									{ provider: "claude" },
								),
							],
						}),
					);

					expect(yield* versionOf("batch-child")).toBeGreaterThan(before ?? 0);
					expect(announced).toContain("batch-child");
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							bus,
							makePersistenceEffectLayer(
								dbPath,
								createAllEffectProjectors(),
								bus,
							),
						),
					),
					Effect.orDie,
				),
			),
		);
	});
});

// ─── Reported gaps ──────────────────────────────────────────────────────────

it("REPORTED GAP: the provider cleanup receipt reaches no projector at all", () => {
	// session-manager-service.ts appends session.provider_cleanup_failed with no
	// projection step, and no projector claims the type — so the receipt is
	// durable but can never move a version. Left alone deliberately: making it
	// project would change what the read model contains, which is not T-4's job.
	expect(
		createAllEffectProjectors().filter((projector) =>
			projector.handles.includes("session.provider_cleanup_failed"),
		),
	).toEqual([]);
});

it("REPORTED GAP: the legacy event sink projects, but through unstamped projectors", async () => {
	await withTempDb(async (dbPath) => {
		const persistence = PersistenceLayer.open(dbPath);
		try {
			persistence.db.exec(
				`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				 VALUES ('legacy', 'opencode', 'Legacy', 'idle', 1000, 1000)`,
			);
			persistence.projectionRunner.recover();
			const sink = new EventSinkImpl({
				eventStore: persistence.eventStore,
				projectionRunner: persistence.projectionRunner,
				sessionId: "legacy",
				provider: "opencode",
			});

			await Effect.runPromise(
				sink.push(
					providerRuntimeEvent(
						"message.created",
						"legacy",
						{
							sessionId: "legacy",
							messageId: "legacy-m1",
							role: "assistant",
						},
						{ eventId: "evt-legacy-1", providerId: "opencode" },
					),
				),
			);

			// The event is durable and the legacy read model moved...
			expect(
				persistence.db.query("SELECT id FROM messages WHERE id = 'legacy-m1'"),
			).toEqual([{ id: "legacy-m1" }]);
			// ...but the synchronous projectors do not stamp `version`, so this
			// write is still silent. It is also unreachable: nothing outside this
			// test constructs EventSinkImpl — the live Claude path goes through
			// createRelayEventSink → ProviderRuntimeIngestion → commitAndSignal.
			expect(
				persistence.db.query(
					"SELECT version FROM sessions WHERE id = 'legacy'",
				),
			).toEqual([{ version: 0 }]);
		} finally {
			persistence.close();
		}
	});
});
