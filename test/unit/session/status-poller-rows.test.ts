import { SqlClient } from "@effect/sql";
import { Effect, HashMap, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { StatusPollerLive } from "../../../src/lib/domain/relay/Layers/status-poller-layer.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

it("the poller returns source statuses without parent or message-activity augmentation", async () => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue({
		parent: { type: "idle" },
		child: { type: "busy" },
	});
	const layer = StatusPollerLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makePersistenceEffectLayer(":memory:"),
				PendingInteractionServiceLive,
				Layer.succeed(ConfigTag, makeMockConfig()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(OpenCodeAPITag, api),
				makePollerStateLive(),
				makePollerPubSubLive(),
				RelayStatusSnapshotLive,
				makeSessionManagerStateLive({
					cachedParentMap: HashMap.make(["child", "parent"]),
				}),
			),
		),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES ('parent', 'opencode', 'Parent', 'idle', 1, 1)`;
				yield* sql`INSERT INTO sessions (id, provider, title, status, parent_id, created_at, updated_at)
					VALUES ('child', 'opencode', 'Child', 'busy', 'parent', 2, 2)`;
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
				vi.spyOn(api.session, "statuses").mockResolvedValue({
					parent: { type: "idle" },
					child: { type: "idle" },
				});
				yield* poller.start();
				const finished = yield* poller.isProcessing("parent");
				expect(finished).toBe(false);
			}),
		).pipe(Effect.provide(layer)),
	);
});
