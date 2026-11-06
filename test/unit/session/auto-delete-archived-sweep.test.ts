// Failure modes: unarchived descendants prevent deletion of an archived root,
// active work is removed, Never is ignored, the sweep deletes event history,
// or a retention delete schedules checkout removal. Exercise the canonical path
// with real SQLite projections, including a daemon timer cycle.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Layer, PubSub, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { AutoSettleLive } from "../../../src/lib/domain/daemon/Layers/auto-settle-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type ProjectParts,
	ProjectServices,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { PortWatcher } from "../../../src/lib/domain/persistence/Services/port-watcher.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { projectSessionManager } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { publishLedgerTasks } from "../../helpers/ledger-tasks.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
	standaloneSessionManagerLive,
} from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

describe("archived tree retention", () => {
	it.effect(
		"keeps excluded trees, commits family deletions and preserves markers on a daemon cycle, then continues bounded work",
		() =>
			Effect.gen(function* () {
				const dir = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-retention-"))),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const cleanup = vi.fn(() => Effect.void);
				const api = makeMockOpenCodeAPI();
				const persistence = Layer.effect(
					PersistenceStore,
					Effect.context<PersistenceStoreContext>(),
				).pipe(
					Layer.provideMerge(
						makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
					),
				);
				const layer = Layer.provideMerge(
					standaloneSessionManagerLive,
					SessionWorkspaceLive,
				).pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							persistence,
							Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
							makeSessionManagerStateLive(),
							Layer.succeed(OpenCodeAPITag)(api),
							Layer.succeed(LoggerTag)(makeMockLogger()),
							Layer.succeed(ConfigTag)(
								makeMockConfig({
									configDir: dir,
									projectDir: dir,
									requestWorktreeCleanup: cleanup,
								}),
							),
							Layer.effect(SessionActivityTag, makeSessionActivity),
							Layer.succeed(PortWatcher)({
								mark: () => Effect.succeed({ kind: "unclaimed" } as const),
								known: () => true,
							}),
							RelayStatusSnapshotLive,
							makeOverridesStateLive(),
							Layer.succeed(OpenCodeInstancesTag)(
								makeOpenCodeInstancesStub({ opencode: api }),
							),
							DaemonEventBusLive,
							Layer.succeed(OrchestrationEngineTag)(
								new OrchestrationEngine({ registry: new ProviderRegistry() }),
							),
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({
									autoSettleAfterDays: null,
									autoArchiveAfterDays: null,
									autoDeleteArchivedAfterDays: null,
								}),
							),
							makeProjectRegistryLive([
								{ slug: "test-project", title: "Retention", folders: [dir] },
							]),
						),
					),
				);
				yield* Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					const read = yield* ReadQueryEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const service = yield* projectSessionManager;
					const configRef = yield* DaemonConfigRefTag;
					const now = 100 * DAY;
					yield* TestClock.setTime(now);
					yield* runner.markRecovered();
					const seed = (id: string, parentId?: string) =>
						Effect.gen(function* () {
							yield* runner.projectEvent(
								yield* store.append(
									canonicalEvent(
										"session.created",
										id,
										{
											sessionId: id,
											title: id,
											provider: "opencode",
											...(parentId ? { parentId } : {}),
											...(id.endsWith("-side") ? { sideThread: true } : {}),
										},
										{ createdAt: DAY },
									),
								),
							);
						});
					const archiveRoot = (id: string, archivedAt = 70 * DAY) =>
						Effect.gen(function* () {
							yield* runner.projectEvent(
								yield* store.append(
									canonicalEvent(
										"session.archived",
										id,
										{ sessionId: id, automatic: false },
										{ createdAt: archivedAt },
									),
								),
							);
						});
					for (const root of [
						"eligible",
						"unarchived",
						"recent",
						"pinned",
						"busy",
						"running",
						"fork-source",
						"internal-fork",
						"background",
					]) {
						for (const [id, parent] of [
							[root, undefined],
							[`${root}-side`, root],
							[`${root}-agent`, `${root}-side`],
						] as const)
							yield* seed(id, parent);
						if (root !== "unarchived")
							yield* archiveRoot(root, root === "recent" ? 99 * DAY : 70 * DAY);
					}
					expect((yield* read.getSession("eligible"))?.archived_at).toBe(
						70 * DAY,
					);
					expect(
						(yield* read.getSession("eligible-side"))?.archived_at,
					).toBeNull();
					expect((yield* read.getSession("eligible-side"))?.side_thread).toBe(
						1,
					);
					expect(
						(yield* read.getSession("eligible-agent"))?.archived_at,
					).toBeNull();
					yield* sql`UPDATE sessions SET pinned_at = 1 WHERE id = 'pinned-agent'`;
					// 8.3 (2849): deletion asks the ledger whether anything may act, not the row's status.
					yield* sql`INSERT INTO run_ledger_sessions (session_id, provider, state) VALUES ('busy-agent', 'claude', 'Open')`;
					yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 'eligible-agent'`;
					yield* sql`INSERT INTO turns (id, session_id, state, requested_at) VALUES ('active-turn', 'running-agent', 'running', 1)`;
					yield* seed("outside-fork");
					yield* sql`UPDATE sessions SET forked_from = 'fork-source-agent' WHERE id = 'outside-fork'`;
					yield* sql`UPDATE sessions SET forked_from = 'internal-fork' WHERE id = 'internal-fork-side'`;
					// The sweep runs through the project's real session manager once it opens.
					const open = vi.fn((_slug: string) =>
						Effect.succeed(Context.empty() as Context.Context<ProjectParts>),
					);
					const bus = yield* DaemonEventBusTag;
					const changes = yield* PubSub.subscribe(bus);
					const activity = yield* SessionActivityTag;
					publishLedgerTasks(activity.background, {
						sessionId: "background-agent",
						kind: "snapshot",
						tasks: [
							{ id: "live", type: "local_agent", description: "Still working" },
						],
					});
					yield* Layer.build(
						AutoSettleLive().pipe(
							Layer.provide(
								Layer.succeed(ProjectServices)({
									forProject: () => Effect.die("unused"),
									generation: () => Effect.die("unused"),
									open,
									opened: () => Effect.succeedNone,
									close: () => Effect.void,
								}),
							),
						),
					);
					yield* TestClock.adjust("1 millis");
					expect(open).not.toHaveBeenCalled();
					expect(yield* read.getSession("eligible")).toBeDefined();
					yield* Ref.update(configRef, (config) => ({
						...config,
						autoDeleteArchivedAfterDays: 30,
					}));
					yield* TestClock.adjust("1 minute");
					expect(open).toHaveBeenCalledWith("test-project");
					for (const root of ["eligible", "internal-fork", "fork-source"])
						for (const id of [root, `${root}-side`, `${root}-agent`]) {
							expect(yield* read.getSession(id)).toBeUndefined();
							const events = yield* store.readAllBySession(id);
							expect(
								events.some((event) => event.type === "session.deleted"),
							).toBe(true);
						}
					for (const root of [
						"unarchived",
						"recent",
						"pinned",
						"busy",
						"running",
						"background",
					])
						for (const id of [root, `${root}-side`, `${root}-agent`]) {
							expect(yield* read.getSession(id)).toBeDefined();
							expect(
								(yield* store.readAllBySession(id)).length,
							).toBeGreaterThan(0);
						}
					expect(
						(yield* PubSub.takeAll(changes)).some(
							(event) => event._tag === "DaemonSessionsChanged",
						),
					).toBe(true);
					expect(cleanup).not.toHaveBeenCalled();
					for (let index = 0; index < 51; index++) {
						yield* seed(`batch-${index}`);
						yield* archiveRoot(`batch-${index}`);
					}
					expect(yield* service.deleteArchivedSessions(30 * DAY, now)).toBe(50);
					expect(yield* service.deleteArchivedSessions(30 * DAY, now)).toBe(1);
					expect(yield* service.deleteArchivedSessions(30 * DAY, now)).toBe(0);
					expect(cleanup).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer));
			}),
	);
});
