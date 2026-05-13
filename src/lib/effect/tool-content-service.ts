import { Context, Data, Effect, Layer } from "effect";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";

export class ToolContentServiceError extends Data.TaggedError(
	"ToolContentServiceError",
)<{
	readonly operation: "get";
	readonly toolId: string;
	readonly cause: unknown;
}> {}

export interface ToolContentService {
	readonly get: (
		toolId: string,
	) => Effect.Effect<string | undefined, ToolContentServiceError>;
}

export class ToolContentServiceTag extends Context.Tag("ToolContentService")<
	ToolContentServiceTag,
	ToolContentService
>() {}

const toError =
	(toolId: string) =>
	(cause: unknown): ToolContentServiceError =>
		new ToolContentServiceError({ operation: "get", toolId, cause });

export const ToolContentServiceLive: Layer.Layer<
	ToolContentServiceTag,
	never,
	ReadQueryEffectTag
> = Layer.effect(
	ToolContentServiceTag,
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		return {
			get: (toolId) =>
				readQuery.getToolContent(toolId).pipe(Effect.mapError(toError(toolId))),
		} satisfies ToolContentService;
	}),
);

export const ToolContentServiceNoop: Layer.Layer<ToolContentServiceTag> =
	Layer.succeed(ToolContentServiceTag, {
		get: () => Effect.succeed(undefined),
	});
