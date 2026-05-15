import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ScanServiceError,
	ScanServiceLive,
	ScanServiceNotAvailable,
	ScanServiceTag,
} from "../../../src/lib/domain/relay/Services/scan-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

describe("ScanServiceLive", () => {
	it.effect("runs the configured immediate scan callback", () => {
		const triggerScan = vi.fn(async () => ({
			discovered: [8080],
			lost: [3000],
			active: [8080, 4096],
		}));
		const layer = ScanServiceLive.pipe(
			Layer.provide(
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						triggerScan,
					}),
				),
			),
		);

		return Effect.gen(function* () {
			const service = yield* ScanServiceTag;
			const result = yield* service.scanNow();

			expect(triggerScan).toHaveBeenCalledOnce();
			expect(result).toEqual({
				discovered: [8080],
				lost: [3000],
				active: [8080, 4096],
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect("reports unavailable scans as a typed error", () => {
		const layer = ScanServiceLive.pipe(
			Layer.provide(Layer.succeed(ConfigTag, makeMockConfig())),
		);

		return Effect.gen(function* () {
			const service = yield* ScanServiceTag;
			const result = yield* Effect.either(service.scanNow());

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(ScanServiceNotAvailable);
				expect(result.left.message).toBe("Port scanning not available");
			}
		}).pipe(Effect.provide(layer));
	});

	it.effect("wraps scan callback failures", () => {
		const scanError = new Error("scanner failed");
		const layer = ScanServiceLive.pipe(
			Layer.provide(
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						triggerScan: vi.fn(async () => {
							throw scanError;
						}),
					}),
				),
			),
		);

		return Effect.gen(function* () {
			const service = yield* ScanServiceTag;
			const result = yield* Effect.either(service.scanNow());

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(ScanServiceError);
				expect(result.left.cause).toBe(scanError);
			}
		}).pipe(Effect.provide(layer));
	});
});
