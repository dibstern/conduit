import { Context, Data, Effect, Layer } from "effect";
import type { ToolDetail } from "../../../contracts/tool-wire.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";

export class ToolContentServiceError extends Data.TaggedError(
	"ToolContentServiceError",
)<{
	readonly operation: "details";
	readonly toolIds: readonly string[];
	readonly cause: unknown;
}> {}

export interface ToolContentService {
	/** Full input and output of each known tool; unknown ids are left out. */
	readonly details: (
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
			details: (toolIds) =>
				readQuery.readToolDetails(toolIds).pipe(
					Effect.mapError(
						(cause) =>
							new ToolContentServiceError({
								operation: "details",
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
