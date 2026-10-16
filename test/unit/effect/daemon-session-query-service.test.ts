import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	DaemonSessionQueryServiceLive,
	DaemonSessionQueryServiceTag,
} from "../../../src/lib/domain/relay/Services/daemon-session-query-service.js";

describe("standalone DaemonSessionQueryServiceLive", () => {
	it.effect(
		"starts without daemon config and retains the unsupported error",
		() =>
			Effect.gen(function* () {
				const service = yield* DaemonSessionQueryServiceTag;
				expect(yield* Effect.either(service.list({ limit: 5 }))).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "DaemonSessionQueryNotSupported",
						message:
							"Cross-project session listing is not supported in this mode",
					},
				});
			}).pipe(Effect.provide(DaemonSessionQueryServiceLive)),
	);
});
