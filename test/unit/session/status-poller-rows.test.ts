import { Effect, HashMap, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { StatusPollerLive } from "../../../src/lib/domain/relay/Layers/status-poller-layer.js";
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
import {
	patchMissingDoneForProcessingState,
	type SessionHistorySource,
} from "../../../src/lib/session/session-switch.js";
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
		Layer.provide(
			Layer.mergeAll(
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
				const poller = yield* StatusPollerTag;
				yield* poller.markMessageActivity("content-only");
				yield* poller.start();
				expect(yield* poller.getCurrentStatuses()).toEqual({
					parent: { type: "idle" },
					child: { type: "busy" },
				});
				const processing = yield* poller.isProcessing("parent");
				expect(processing).toBe(true);
				const history: SessionHistorySource = {
					kind: "cached-events",
					hasMore: false,
					events: [{ type: "delta", sessionId: "parent", text: "working" }],
				};
				expect(
					patchMissingDoneForProcessingState(history, "parent", processing),
				).toEqual(history);
				yield* poller.stop();
				vi.spyOn(api.session, "statuses").mockResolvedValue({
					parent: { type: "idle" },
					child: { type: "idle" },
				});
				yield* poller.start();
				const finished = yield* poller.isProcessing("parent");
				expect(finished).toBe(false);
				expect(
					patchMissingDoneForProcessingState(history, "parent", finished),
				).toEqual({
					...history,
					events: [
						...history.events,
						{ type: "done", sessionId: "parent", code: 0 },
					],
				});
			}),
		).pipe(Effect.provide(layer)),
	);
});
