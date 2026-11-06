import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Context,
	Effect,
	Exit,
	Layer,
	Logger,
	Option,
	PubSub,
	References,
	Scope,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { AutoSettleLive } from "../../../src/lib/domain/daemon/Layers/auto-settle-layer.js";
import { makeDaemonSharedStoreLayer } from "../../../src/lib/domain/daemon/Layers/daemon-shared-store-layer.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type ProjectParts,
	ProjectServices,
	ProjectServicesError,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import {
	SessionGit,
	type SessionGitChange,
} from "../../../src/lib/domain/daemon/Services/session-git.js";
import { PortWatcher } from "../../../src/lib/domain/persistence/Services/port-watcher.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

// The sweep reads no project service, so an empty context stands in for an opened project.
const openedContext = Context.empty() as Context.Context<ProjectParts>;

const projectServices = (
	overrides: Partial<ProjectServices["Service"]>,
): Layer.Layer<ProjectServices> =>
	Layer.succeed(ProjectServices)({
		forProject: () => Effect.die("unused"),
		generation: () => Effect.die("unused"),
		open: () => Effect.succeed(openedContext),
		opened: () => Effect.succeedNone,
		close: () => Effect.void,
		...overrides,
	});

// Each project's manager settles with `settle`; archive and delete find nothing.
const sessionManagers = (
	settle: (slug: string) => Effect.Effect<number, SessionManagerError>,
) =>
	Layer.succeed(SessionManagerServiceTag)({
		forProject: (slug) =>
			makeMockSessionManagerService({
				settleIdleSessions: () => settle(slug),
				archiveIdleSessions: () => Effect.succeed(0),
				deleteArchivedSessions: () => Effect.succeed(0),
			}),
		parts: () => Effect.die("unused"),
	});

// The watcher has scanned, so nothing waits on its readiness.
const knownWatcher = Layer.succeed(PortWatcher)({
	mark: () => Effect.succeed({ kind: "unclaimed" } as const),
	known: () => true,
});

describe("daemon automatic settlement layer", () => {
	it.effect(
		"skips missing projects on every sweep and logs once at debug level",
		() =>
			Effect.gen(function* () {
				const directory = mkdtempSync(join(tmpdir(), "conduit-auto-missing-"));
				const missingDirectory = join(directory, "missing");
				const sweep = vi.fn(() => Effect.succeed(1));
				const open = vi.fn(() => Effect.succeed(openedContext));
				const logs: Array<{ level: string; message: unknown }> = [];
				const logger = Logger.make(({ logLevel, message }) => {
					logs.push({ level: logLevel.toUpperCase(), message });
				});
				const layer = AutoSettleLive().pipe(
					Layer.provide(knownWatcher),
					Layer.provide(
						makeDaemonSharedStoreLayer(directory, defaultDaemonConfig()),
					),
					Layer.provide(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: 3 }),
							),
							makeProjectRegistryLive([
								{
									slug: "running",
									title: "Running",
									folders: [missingDirectory],
								},
								{
									slug: "cold",
									title: "Cold",
									folders: [missingDirectory],
								},
							]),
							projectServices({
								opened: (slug) =>
									Effect.succeed(
										slug === "running"
											? Option.some(openedContext)
											: Option.none(),
									),
								open,
							}),
							sessionManagers(sweep),
							DaemonEventBusLive,
							Logger.layer([logger]),
						),
					),
				);
				const scope = yield* Scope.make();
				try {
					yield* Layer.buildWithScope(Layer.fresh(layer), scope).pipe(
						Effect.provideService(References.MinimumLogLevel, "Debug"),
					);
					yield* TestClock.adjust("1 millis");
					yield* TestClock.adjust("2 minutes");
					expect(open).not.toHaveBeenCalled();
					expect(sweep).not.toHaveBeenCalled();
					expect(
						logs.filter(
							(log) =>
								log.level === "DEBUG" &&
								String(log.message).includes(
									"Skipping background work for missing project directory",
								),
						),
					).toHaveLength(1);
					expect(logs.filter((log) => log.level === "WARN")).toEqual([]);
					mkdirSync(missingDirectory);
					yield* TestClock.adjust("1 minute");
					expect(sweep).toHaveBeenCalled();
				} finally {
					yield* Scope.close(scope, Exit.void);
					rmSync(directory, { recursive: true, force: true });
				}
			}),
	);

	it.effect(
		"ticks once per minute despite git publications, skips cold empty projects, and survives one project failure",
		() =>
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "conduit-auto-layer-"));
				const calls: string[] = [];
				const changes = yield* Effect.acquireRelease(
					PubSub.unbounded<SessionGitChange>(),
					PubSub.shutdown,
				);
				const settles = new Map<
					string,
					() => Effect.Effect<number, SessionManagerError>
				>([
					[
						"broken",
						() =>
							Effect.fail(
								new SessionManagerError({ operation: "settle", cause: "boom" }),
							),
					],
					[
						"running",
						() =>
							Effect.sync(() => {
								calls.push("running");
								return 1;
							}),
					],
				]);
				const open = vi.fn((_slug: string) => Effect.succeed(openedContext));
				const layer = AutoSettleLive().pipe(
					Layer.provide(knownWatcher),
					Layer.provide(makeDaemonSharedStoreLayer(dir, defaultDaemonConfig())),
					Layer.provideMerge(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: 3 }),
							),
							makeProjectRegistryLive([
								{
									slug: "broken",
									title: "Broken",
									folders: [dir],
									lastUsed: 3,
								},
								{
									slug: "running",
									title: "Running",
									folders: [dir],
									lastUsed: 2,
								},
								{
									slug: "cold",
									title: "Cold",
									folders: [dir],
									lastUsed: 1,
								},
							]),
							projectServices({
								opened: (slug) =>
									Effect.succeed(
										settles.has(slug)
											? Option.some(openedContext)
											: Option.none(),
									),
								open,
							}),
							sessionManagers(
								(slug) => settles.get(slug)?.() ?? Effect.succeed(0),
							),
							Layer.succeed(SessionGit)({
								read: () => Effect.succeed(undefined),
								changes: Stream.fromPubSub(changes),
								invalidate: () => Effect.void,
							}),
							DaemonEventBusLive,
						),
					),
				);
				const scope = yield* Scope.make();
				try {
					yield* Layer.buildWithScope(Layer.fresh(layer), scope);
					yield* TestClock.adjust("1 millis");
					expect(calls).toContain("running");
					expect(open).not.toHaveBeenCalledWith("cold");
					const beforePublication = calls.length;
					for (let version = 1; version <= 100; version++)
						yield* PubSub.publish(changes, {
							directory: dir,
							sessionIds: ["running-s1"],
							version,
						});
					yield* TestClock.adjust("1 millis");
					expect(calls).toHaveLength(beforePublication);
					yield* TestClock.adjust("1 minute");
					expect(calls).toHaveLength(beforePublication + 1);
				} finally {
					yield* Scope.close(scope, Exit.void);
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);

	it.effect(
		"starts a cold project only when its persisted session is eligible",
		() =>
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "conduit-auto-cold-"));
				const now = Date.now();
				const old = now - 4 * DAY;
				const dbPath = join(dir, "events.db");
				yield* Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.markRecovered();
					for (const event of [
						canonicalEvent(
							"session.created",
							"cold-s1",
							{ sessionId: "cold-s1", title: "Cold", provider: "opencode" },
							{ createdAt: old - 1 },
						),
						canonicalEvent(
							"message.created",
							"cold-s1",
							{ sessionId: "cold-s1", messageId: "m1", role: "assistant" },
							{ createdAt: old },
						),
					])
						yield* runner.projectEvent(yield* store.append(event));
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(dbPath, "cold"), {
						local: true,
					}),
				);
				const sweep = vi.fn(() => Effect.succeed(1));
				const open = vi.fn((_slug: string) => Effect.succeed(openedContext));
				const layer = AutoSettleLive().pipe(
					Layer.provide(knownWatcher),
					Layer.provide(makeDaemonSharedStoreLayer(dir, defaultDaemonConfig())),
					Layer.provideMerge(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: 3 }),
							),
							makeProjectRegistryLive([
								{
									slug: "cold",
									title: "Cold",
									folders: [dir],
									lastUsed: 1,
								},
							]),
							projectServices({ open }),
							sessionManagers(sweep),
							DaemonEventBusLive,
						),
					),
				);
				const scope = yield* Scope.make();
				try {
					yield* TestClock.setTime(now);
					yield* Layer.buildWithScope(Layer.fresh(layer), scope);
					yield* TestClock.adjust("1 millis");
					expect(open).toHaveBeenCalledWith("cold");
					expect(sweep).toHaveBeenCalled();
				} finally {
					yield* Scope.close(scope, Exit.void);
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);

	it.effect(
		"disables settlement but still stops workers for missing projects",
		() =>
			Effect.gen(function* () {
				const opened = vi.fn(() => Effect.succeedNone);
				const close = vi.fn((_slug: string) => Effect.void);
				const dir = mkdtempSync(join(tmpdir(), "conduit-auto-disabled-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				);
				const layer = AutoSettleLive().pipe(
					Layer.provide(knownWatcher),
					Layer.provide(makeDaemonSharedStoreLayer(dir, defaultDaemonConfig())),
					Layer.provideMerge(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: null }),
							),
							makeProjectRegistryLive([
								{
									slug: "cold",
									title: "Cold",
									folders: ["/missing"],
									lastUsed: 1,
								},
							]),
							projectServices({
								opened,
								open: (projectId) =>
									Effect.fail(
										new ProjectServicesError({
											projectId,
											reason: "must skip",
										}),
									),
								close,
							}),
							sessionManagers(() => Effect.die("must skip")),
							DaemonEventBusLive,
						),
					),
				);
				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(Layer.fresh(layer), scope);
				yield* TestClock.adjust("1 minute");
				expect(opened).not.toHaveBeenCalled();
				expect(close).toHaveBeenCalledWith("cold");
				yield* Scope.close(scope, Exit.void);
			}),
	);
});
