import { Deferred, Effect, Exit, HashMap, Layer, PubSub, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { StatusPollerLive } from "../../../src/lib/domain/project-services/Layers/status-poller-layer.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/project-services/Services/pending-interaction-service.js";
import { ProjectStatusSnapshotLive } from "../../../src/lib/domain/project-services/Services/project-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
} from "../../../src/lib/domain/project-services/Services/services.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/project-services/Services/session-manager-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
	PollerPubSubTag,
} from "../../../src/lib/domain/project-services/Services/session-status-poller.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { activeRunEvents, publishRun } from "../../helpers/ledger-tasks.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const pollerLayer = (api: ReturnType<typeof makeMockOpenCodeAPI>) =>
	StatusPollerLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makePersistenceEffectLayer(":memory:", "test-project"),
				PendingInteractionServiceLive,
				Layer.succeed(ConfigTag)(makeMockConfig()),
				Layer.succeed(LoggerTag)(makeMockLogger()),
				Layer.succeed(OpenCodeAPITag)(api),
				makePollerStateLive(),
				makePollerPubSubLive(),
				ProjectStatusSnapshotLive,
				Layer.effect(SessionActivityTag, makeSessionActivity),
				makeSessionManagerStateLive({
					cachedParentMap: HashMap.make(["child", "parent"]),
				}),
			),
		),
	);

const insertParentAndBusyChild = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
		VALUES ('parent', 'opencode', 'Parent', 'idle', 1, 1, 'test-project')`;
	yield* sql`INSERT INTO sessions (id, provider, title, status, parent_id, created_at, updated_at, project_id)
		VALUES ('child', 'opencode', 'Child', 'busy', 'parent', 2, 2, 'test-project')`;
});

// The poller only runs when OpenCode is reachable. After a restart without it,
// a Claude turn still running in its runner must not read as idle to browsers.
// 82tn.32.30: busy is the ledger's active Run in the store, never the row's status.
it("a poller that never started reads busy from the store's ledger, not the row's status", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
					VALUES ('parent', 'opencode', 'Parent', 'idle', 1, 1, 'test-project'),
						('stale', 'opencode', 'Stale', 'busy', 3, 3, 'test-project')`;
				yield* sql`INSERT INTO sessions (id, provider, title, status, parent_id, created_at, updated_at, project_id)
					VALUES ('child', 'opencode', 'Child', 'idle', 'parent', 2, 2, 'test-project')`;
				yield* (yield* makeCommitAndSignal)(activeRunEvents("child"));
				const poller = yield* StatusPollerTag;
				expect(yield* poller.isProcessing("child")).toBe(true);
				expect(yield* poller.isProcessing("parent")).toBe(true);
				expect(yield* poller.isProcessing("stale")).toBe(false);
			}),
		).pipe(Effect.provide(pollerLayer(makeMockOpenCodeAPI()))),
	);
});

it("keeps Claude status observation and exposes ownership separately", async () => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue({
		"opencode-1": { type: "busy" },
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
					VALUES ('opencode-1', 'opencode', 'OpenCode', 'busy', 1, 1, 'test-project'),
						('claude-1', 'claude', 'Claude', 'busy', 2, 2, 'test-project')`;
				// 82tn.32.30: the row's busy is not read; the ledger's active Run, as the view holds it, is.
				publishRun((yield* SessionActivityTag).background, "claude-1");
				const poller = yield* StatusPollerTag;
				yield* poller.start();
				expect(yield* poller.getCurrentStatuses()).toEqual({
					"opencode-1": { type: "idle" },
					"claude-1": { type: "busy" },
				});
				expect(yield* poller.getSessionProviders()).toEqual(
					new Map([
						["opencode-1", "opencode"],
						["claude-1", "claude"],
					]),
				);
			}),
		).pipe(Effect.provide(pollerLayer(api))),
	);
});

it("the poller returns source statuses without parent or message-activity augmentation", async () => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue({
		parent: { type: "idle" },
		child: { type: "busy" },
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* insertParentAndBusyChild;
				const { background } = yield* SessionActivityTag;
				publishRun(background, "child");
				const poller = yield* StatusPollerTag;
				yield* poller.markMessageActivity("content-only");
				yield* poller.start();
				yield* Effect.promise(() =>
					vi.waitFor(async () =>
						expect(
							await Effect.runPromise(poller.getCurrentStatuses()),
						).toEqual({
							parent: { type: "idle" },
							child: { type: "busy" },
						}),
					),
				);
				const processing = yield* poller.isProcessing("parent");
				expect(processing).toBe(true);
				yield* poller.stop();
				background.publish("child", { tag: "none" }, undefined, {});
				yield* poller.start();
				const finished = yield* poller.isProcessing("parent");
				expect(finished).toBe(false);
			}),
		).pipe(Effect.provide(pollerLayer(api))),
	);
});

// Lane 16o row 111: a closed relay's "changed" listener would recover commands and
// reduce monitoring a second time for each status change after it was replaced.
it("drops a changed listener when the scope that added it closes", async () => {
	const seen = vi.fn();
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const poller = yield* StatusPollerTag;
				const pubsub = yield* PollerPubSubTag;
				const project = yield* Scope.make();
				yield* poller.on("changed", seen).pipe(Scope.provide(project));
				yield* Scope.close(project, Exit.void);
				const kept = yield* Deferred.make<void>();
				yield* poller.on("changed", () => {
					Deferred.doneUnsafe(kept, Exit.void);
				});
				// The poller subscribes in a fiber of its own; publish until it hears one.
				yield* Effect.race(
					Deferred.await(kept),
					PubSub.publish(pubsub, { statuses: {}, statusesChanged: true }).pipe(
						Effect.andThen(Effect.sleep("10 millis")),
						Effect.forever,
					),
				);
			}),
		).pipe(Effect.provide(pollerLayer(makeMockOpenCodeAPI()))),
	);
	expect(seen).not.toHaveBeenCalled();
});
