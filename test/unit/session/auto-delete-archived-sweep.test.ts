// Failure modes: unarchived descendants prevent deletion of an archived root,
// surviving forks lose their source,
// active work is removed, Never is ignored, event reclamation precedes deletion,
// or a retention delete schedules checkout removal. Exercise the canonical path
// with real SQLite projections, including a daemon timer cycle.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option, PubSub, Ref } from "effect";
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
	type Relay,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
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
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

describe("archived tree retention", () => {
	it.effect(
		"keeps excluded trees, deletes complete families and their events on a daemon cycle, then continues bounded work",
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
					SessionManagerServiceLive,
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
							Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
							Layer.effect(SessionActivityTag, makeSessionActivity),
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
					const service = yield* SessionManagerServiceTag;
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
					yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 'busy-agent'`;
					yield* sql`INSERT INTO turns (id, session_id, state, requested_at) VALUES ('active-turn', 'running-agent', 'running', 1)`;
					yield* seed("outside-fork");
					yield* sql`UPDATE sessions SET forked_from = 'fork-source-agent' WHERE id = 'outside-fork'`;
					yield* sql`UPDATE sessions SET forked_from = 'internal-fork' WHERE id = 'internal-fork-side'`;
					const relay: Relay = {
						slug: "test-project",
						syncGlobalSetting: () => Effect.void,
						refreshGlobalDefaults: () => Effect.void,
						rpcWsHandler: {} as Relay["rpcWsHandler"],
						stop: () => {},
						deleteArchivedSessions: (windowMs, at) =>
							service.deleteArchivedSessions(windowMs, at),
					};
					const get = vi.fn(() => Effect.succeed(relay));
					const bus = yield* DaemonEventBusTag;
					const changes = yield* PubSub.subscribe(bus);
					const activity = yield* SessionActivityTag;
					activity.background.record({
						sessionId: "background-agent",
						kind: "snapshot",
						tasks: [
							{ id: "live", type: "local_agent", description: "Still working" },
						],
					});
					yield* Layer.build(
						AutoSettleLive().pipe(
							Layer.provide(
								Layer.succeed(RelayCacheTag)({
									peek: () => Effect.succeed(Option.none<Relay>()),
									get,
									invalidate: () => Effect.void,
								}),
							),
						),
					);
					yield* TestClock.adjust("1 millis");
					expect(get).not.toHaveBeenCalled();
					expect(yield* read.getSession("eligible")).toBeDefined();
					yield* Ref.update(configRef, (config) => ({
						...config,
						autoDeleteArchivedAfterDays: 30,
					}));
					yield* TestClock.adjust("1 minute");
					expect(get).toHaveBeenCalledWith("test-project");
					for (const root of ["eligible", "internal-fork"])
						for (const id of [root, `${root}-side`, `${root}-agent`]) {
							expect(yield* read.getSession(id)).toBeUndefined();
							expect(yield* store.readAllBySession(id)).toEqual([]);
						}
					for (const root of [
						"unarchived",
						"recent",
						"pinned",
						"busy",
						"running",
						"fork-source",
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
