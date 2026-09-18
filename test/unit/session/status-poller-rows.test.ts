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
			}),
		).pipe(Effect.provide(layer)),
	);
});
