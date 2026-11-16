import { Effect, Layer, Option } from "effect";
import type { DaemonTurns } from "../../src/lib/domain/daemon/Services/daemon-turns.js";
import {
	attachProviderTurnsLive,
	type ProviderTurnParts,
	type ProviderTurnServiceTag,
	ProviderTurns,
	ProviderTurnsLive,
} from "../../src/lib/domain/project-services/Services/provider-turn-service.js";
import { DaemonTurnsOrOwn } from "./daemon-turns.js";

/** The daemon's turn service when the test provides one; otherwise its own. */
export const ProviderTurnsOrOwn = Layer.unwrap(
	Effect.map(Effect.serviceOption(ProviderTurns), (shared) =>
		Option.isSome(shared)
			? Layer.succeed(ProviderTurns, shared.value)
			: ProviderTurnsLive,
	),
);

/** A project's turn service over the daemon's turns, or the test's own when it has no daemon. */
export const ProviderTurnServiceLive: Layer.Layer<
	ProviderTurnServiceTag,
	never,
	Exclude<ProviderTurnParts, DaemonTurns>
> = attachProviderTurnsLive.pipe(
	Layer.provide(ProviderTurnsOrOwn),
	Layer.provide(DaemonTurnsOrOwn),
);
