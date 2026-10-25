import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { DaemonStoreAvailability } from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import {
	makeProjectRegistryLive,
	markError,
	markReady,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	DraftPreWarmLive,
	DraftPreWarmTag,
} from "../../../src/lib/domain/relay/Services/draft-prewarm.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { ProviderRegistryLive } from "../../../src/lib/provider/provider-registry.js";

// An unavailable project's launch preparation must not run; clearing the
// failure must allow a fresh on-demand preparation in the same daemon.
it.effect(
	"refuses unavailable projects and prepares fresh after recovery",
	() => {
		const unavailable = new Map([["a", "Attachment failed"]]);
		return Effect.gen(function* () {
			const drafts = yield* DraftPreWarmTag;
			let prepared = 0;
			const input = Effect.sync(() => {
				prepared++;
				return undefined;
			});
			yield* drafts.warm("origin", "draft", "a", input);
			expect(prepared).toBe(0);
			unavailable.delete("a");
			yield* drafts.warm("origin", "draft", "a", input);
			expect(prepared).toBe(1);
		}).pipe(
			Effect.provide(
				DraftPreWarmLive.pipe(
					Layer.provide(ProviderRegistryLive()),
					Layer.provide(Layer.succeed(LoggerTag)(createSilentLogger())),
					Layer.provide(Layer.succeed(DaemonStoreAvailability)(unavailable)),
				),
			),
		);
	},
);

it.effect(
	"refuses retryable relay errors and prepares after relay recovery",
	() =>
		Effect.gen(function* () {
			const drafts = yield* DraftPreWarmTag;
			let prepared = 0;
			const input = Effect.sync(() => {
				prepared++;
				return undefined;
			});
			yield* markError("a", "Relay startup failed");
			yield* drafts.warm("origin", "draft", "a", input);
			expect(prepared).toBe(0);
			yield* markReady("a");
			yield* drafts.warm("origin", "draft", "a", input);
			expect(prepared).toBe(1);
		}).pipe(
			Effect.provide(
				DraftPreWarmLive.pipe(
					Layer.provide(ProviderRegistryLive()),
					Layer.provide(Layer.succeed(LoggerTag)(createSilentLogger())),
					Layer.provideMerge(
						Layer.mergeAll(
							makeProjectRegistryLive([
								{ slug: "a", title: "A", folders: ["/tmp/a"] },
							]),
							DaemonEventBusLive,
						),
					),
				),
			),
		),
);
