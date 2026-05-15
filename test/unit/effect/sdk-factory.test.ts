import { describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
	createSdkClient,
	createSdkClientEffect,
	type SdkFactoryOptions,
} from "../../../src/lib/instance/sdk-factory.js";

describe("Effect-based SDK factory", () => {
	it("returns SdkFactoryResult synchronously", () => {
		const result = createSdkClient({
			baseUrl: "http://localhost:12345",
		});

		expect(result.client).toBeDefined();
		expect(result.fetch).toBeInstanceOf(Function);
		expect(result.authHeaders).toBeDefined();
	});

	it("keeps retry behavior behind the Promise-shaped fetch callback", async () => {
		let callCount = 0;
		const result = createSdkClient({
			baseUrl: "http://localhost:12345",
			retry: {
				retries: 1,
				retryDelay: 1,
				baseFetch: async () => {
					callCount++;
					return new Response(callCount === 1 ? "retry" : "ok", {
						status: callCount === 1 ? 500 : 200,
					});
				},
			},
		});

		const response = await result.fetch("http://localhost:12345/test");

		expect(response.status).toBe(200);
		expect(callCount).toBe(2);
	});

	it("keeps SDK auth headers separate from GapEndpoints auth injection", async () => {
		const requests: Array<{
			input: RequestInfo | URL;
			init: RequestInit | undefined;
		}> = [];
		const result = createSdkClient({
			baseUrl: "http://localhost:12345",
			auth: { username: "user", password: "pass" },
			retry: {
				baseFetch: async (input, init) => {
					requests.push({ input, init });
					return new Response("ok", { status: 200 });
				},
			},
		});

		await result.fetch(new Request("http://localhost:12345/sdk"));
		await result.fetch("http://localhost:12345/gap", {
			headers: { Accept: "application/json" },
		});

		expect(result.authHeaders["Authorization"]).toMatch(/^Basic /);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.input).toBeInstanceOf(Request);
		expect((requests[0]?.input as Request).headers.get("Authorization")).toBe(
			null,
		);
		expect(requests[0]?.init?.headers).toBeUndefined();
		expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);

		const gapHeaders = new Headers(requests[1]?.init?.headers);
		expect(gapHeaders.get("Authorization")).toBe(
			result.authHeaders["Authorization"],
		);
		expect(gapHeaders.get("Accept")).toBe("application/json");
	});

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
