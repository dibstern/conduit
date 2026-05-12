import { Context, Data, Effect, Layer } from "effect";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { ReadQueryTag } from "./services.js";

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

export const ToolContentServiceLive: Layer.Layer<ToolContentServiceTag> =
	Layer.succeed(ToolContentServiceTag, {
		get: (toolId) =>
			Effect.gen(function* () {
				const readQueryEffectOption =
					yield* Effect.serviceOption(ReadQueryEffectTag);
				if (readQueryEffectOption._tag === "Some") {
					return yield* readQueryEffectOption.value
						.getToolContent(toolId)
						.pipe(Effect.mapError(toError(toolId)));
				}

				const readQueryOption = yield* Effect.serviceOption(ReadQueryTag);
				if (readQueryOption._tag === "Some") {
					return yield* Effect.try({
						try: () => readQueryOption.value.getToolContent(toolId),
						catch: toError(toolId),
					});
				}

				return undefined;
			}),
	});
