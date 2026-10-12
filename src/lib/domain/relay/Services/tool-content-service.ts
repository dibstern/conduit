import { Context, Data, Effect, Layer } from "effect";
import type { ToolDetail } from "../../../contracts/tool-wire.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";

export class ToolContentServiceError extends Data.TaggedError(
	"ToolContentServiceError",
)<{
	readonly operation: "details";
	readonly sessionId: string;
	readonly toolIds: readonly string[];
	readonly cause: unknown;
}> {}

export interface ToolContentService {
	/** Full input and output of each of the session's tools; unknown ids are
	 *  left out. */
	readonly details: (
		sessionId: string,
		toolIds: readonly string[],
	) => Effect.Effect<readonly ToolDetail[], ToolContentServiceError>;
}

export class ToolContentServiceTag extends Context.Tag("ToolContentService")<
	ToolContentServiceTag,
	ToolContentService
>() {}

export const ToolContentServiceLive: Layer.Layer<
	ToolContentServiceTag,
	never,
	ReadQueryEffectTag
> = Layer.effect(
	ToolContentServiceTag,
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		return {
			details: (sessionId, toolIds) =>
				readQuery.readToolDetails(sessionId, toolIds).pipe(
					Effect.mapError(
						(cause) =>
							new ToolContentServiceError({
								operation: "details",
								sessionId,
								toolIds,
								cause,
							}),
					),
				),
		} satisfies ToolContentService;
	}),
);

export const ToolContentServiceNoop: Layer.Layer<ToolContentServiceTag> =
	Layer.succeed(ToolContentServiceTag, {
		details: () => Effect.succeed([]),
	});
