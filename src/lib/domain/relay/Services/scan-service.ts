import { Context, Data, Effect, Layer } from "effect";
import { ConfigTag } from "./services.js";

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

export const ScanServiceLive: Layer.Layer<ScanServiceTag, never, ConfigTag> =
	Layer.effect(
		ScanServiceTag,
		Effect.gen(function* () {
			const config = yield* ConfigTag;

			return {
				scanNow: () =>
					Effect.gen(function* () {
						const triggerScan = config.triggerScan;
						if (triggerScan == null) {
							return yield* new ScanServiceNotAvailable({
								message: "Port scanning not available",
							});
						}
						return yield* Effect.tryPromise({
							try: () => triggerScan(),
							catch: (cause) => new ScanServiceError({ cause }),
						});
					}),
			};
		}),
	);
