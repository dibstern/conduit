import { describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
	createSdkClientEffect,
	type SdkFactoryOptions,
} from "../../../src/lib/instance/sdk-factory.js";

describe("Effect-based SDK factory", () => {
	it.effect("returns SdkFactoryResult on success", () =>
		Effect.gen(function* () {
			const options: SdkFactoryOptions = {
				baseUrl: "http://localhost:12345",
			};
			const result = yield* Effect.exit(createSdkClientEffect(options));
			expect(Exit.isSuccess(result)).toBe(true);
			if (Exit.isSuccess(result)) {
				expect(result.value.client).toBeDefined();
				expect(result.value.fetch).toBeInstanceOf(Function);
				expect(result.value.authHeaders).toBeDefined();
			}
		}),
	);

	it.effect("includes auth headers when credentials provided", () =>
		Effect.gen(function* () {
			const options: SdkFactoryOptions = {
				baseUrl: "http://localhost:12345",
				auth: { username: "user", password: "pass" },
			};
			const result = yield* Effect.exit(createSdkClientEffect(options));
			expect(Exit.isSuccess(result)).toBe(true);
			if (Exit.isSuccess(result)) {
				expect(result.value.authHeaders["Authorization"]).toMatch(/^Basic /);
			}
		}),
	);
});
