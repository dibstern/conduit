import { Context, Data, Effect, Layer } from "effect";
import type {
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
} from "../../../shared-types.js";
import { ConfigTag } from "./services.js";

export class DaemonSessionQueryServiceError extends Data.TaggedError(
	"DaemonSessionQueryServiceError",
)<{
	readonly cause: unknown;
}> {}

export class DaemonSessionQueryNotSupported extends Data.TaggedError(
	"DaemonSessionQueryNotSupported",
)<{
	readonly message: string;
}> {}

export interface DaemonSessionQueryService {
	readonly list: (
		options: DaemonSessionQueryOptions,
	) => Effect.Effect<
		DaemonSessionQueryResult,
		DaemonSessionQueryServiceError | DaemonSessionQueryNotSupported
	>;
}

export class DaemonSessionQueryServiceTag extends Context.Tag(
	"DaemonSessionQueryService",
)<DaemonSessionQueryServiceTag, DaemonSessionQueryService>() {}

export const DaemonSessionQueryServiceLive: Layer.Layer<
	DaemonSessionQueryServiceTag,
	never,
	ConfigTag
> = Layer.effect(
	DaemonSessionQueryServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		return {
			list: (options) =>
				Effect.gen(function* () {
					const listDaemonSessions = config.listDaemonSessions;
					if (listDaemonSessions == null) {
						return yield* new DaemonSessionQueryNotSupported({
							message:
								"Cross-project session listing is not supported in this mode",
						});
					}
					return yield* Effect.tryPromise({
						try: () => Promise.resolve(listDaemonSessions(options)),
						catch: (cause) => new DaemonSessionQueryServiceError({ cause }),
					});
				}),
		};
	}),
);
