import { Context, Data, Effect, Layer } from "effect";
import type {
	ArchivedSessionQueryOptions,
	ArchivedSessionQueryResult,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
} from "../../../shared-types.js";

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
	readonly listArchived: (
		options: ArchivedSessionQueryOptions,
	) => Effect.Effect<
		ArchivedSessionQueryResult,
		DaemonSessionQueryServiceError | DaemonSessionQueryNotSupported
	>;
	readonly list: (
		options: DaemonSessionQueryOptions,
	) => Effect.Effect<
		DaemonSessionQueryResult,
		DaemonSessionQueryServiceError | DaemonSessionQueryNotSupported
	>;
}

export class DaemonSessionQueryServiceTag extends Context.Service<
	DaemonSessionQueryServiceTag,
	DaemonSessionQueryService
>()("DaemonSessionQueryService") {}

export const DaemonSessionQueryServiceLive: Layer.Layer<DaemonSessionQueryServiceTag> =
	Layer.succeed(DaemonSessionQueryServiceTag, {
		listArchived: () =>
			Effect.fail(
				new DaemonSessionQueryNotSupported({
					message:
						"Cross-project session listing is not supported in this mode",
				}),
			),
		list: () =>
			Effect.fail(
				new DaemonSessionQueryNotSupported({
					message:
						"Cross-project session listing is not supported in this mode",
				}),
			),
	});
