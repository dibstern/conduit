import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	ScanServiceLive,
	ScanServiceNotAvailable,
	ScanServiceTag,
} from "../../../src/lib/domain/relay/Services/scan-service.js";

describe("standalone ScanServiceLive", () => {
	it.effect("starts without daemon config and reports unavailable scans", () =>
		Effect.gen(function* () {
			const service = yield* ScanServiceTag;
			const result = yield* Effect.result(service.scanNow());
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "ScanServiceNotAvailable",
					message: "Port scanning not available",
				},
			});
			if (result._tag === "Failure")
				expect(result.failure).toBeInstanceOf(ScanServiceNotAvailable);
		}).pipe(Effect.provide(ScanServiceLive)),
	);
});
