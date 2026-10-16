import { Context, Data, Effect, Layer } from "effect";

export interface ScanResult {
	readonly discovered: number[];
	readonly lost: number[];
	readonly active: number[];
}

export class ScanServiceError extends Data.TaggedError("ScanServiceError")<{
	readonly cause: unknown;
}> {}

export class ScanServiceNotAvailable extends Data.TaggedError(
	"ScanServiceNotAvailable",
)<{
	readonly message: string;
}> {}

export interface ScanService {
	scanNow(): Effect.Effect<
		ScanResult,
		ScanServiceError | ScanServiceNotAvailable
	>;
}

export class ScanServiceTag extends Context.Tag("ScanService")<
	ScanServiceTag,
	ScanService
>() {}

export const ScanServiceLive: Layer.Layer<ScanServiceTag> = Layer.succeed(
	ScanServiceTag,
	{
		scanNow: () =>
			Effect.fail(
				new ScanServiceNotAvailable({ message: "Port scanning not available" }),
			),
	},
);
