import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	InstanceManagementServiceLive,
	InstanceManagementServiceTag,
} from "../../../src/lib/domain/relay/Services/instance-management-service.js";

describe("standalone InstanceManagementServiceLive", () => {
	it.effect(
		"starts without daemon callbacks and reports unsupported operations",
		() =>
			Effect.gen(function* () {
				const service = yield* InstanceManagementServiceTag;
				const operations = [
					["list", service.list()],
					["add", service.add({ name: "Standalone", driver: "claude" })],
					["remove", service.remove("missing")],
					["start", service.start("missing")],
					["stop", service.stop("missing")],
					["update", service.update("missing", { name: "Renamed" })],
					["rename", service.rename("missing", "Renamed")],
				] as const;
				for (const [operation, effect] of operations) {
					expect(yield* Effect.result(effect)).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "InstanceManagementServiceError",
							operation,
							cause: expect.objectContaining({
								message: "Instance management not available",
							}),
						},
					});
				}
			}).pipe(Effect.provide(InstanceManagementServiceLive)),
	);
});
