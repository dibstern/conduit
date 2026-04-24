import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSdkClientEffect,
	type SdkFactoryOptions,
} from "../../../src/lib/instance/sdk-factory.js";

describe("Effect-based SDK factory", () => {
	it("returns SdkFactoryResult on success", async () => {
		const options: SdkFactoryOptions = {
			baseUrl: "http://localhost:12345",
		};
		const result = await Effect.runPromiseExit(createSdkClientEffect(options));
		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value.client).toBeDefined();
			expect(result.value.fetch).toBeInstanceOf(Function);
			expect(result.value.authHeaders).toBeDefined();
		}
	});

	it("includes auth headers when credentials provided", async () => {
		const options: SdkFactoryOptions = {
			baseUrl: "http://localhost:12345",
			auth: { username: "user", password: "pass" },
		};
		const result = await Effect.runPromiseExit(createSdkClientEffect(options));
		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value.authHeaders["Authorization"]).toMatch(/^Basic /);
		}
	});

	it("legacy createSdkClient still works for daemon compat", async () => {
		const { createSdkClient } = await import(
			"../../../src/lib/instance/sdk-factory.js"
		);
		const result = createSdkClient({ baseUrl: "http://localhost:12345" });
		expect(result.client).toBeDefined();
	});
});
