// test/unit/instance/sdk-factory.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	createSdkClient,
	type SdkFactoryOptions,
} from "../../../src/lib/instance/sdk-factory.js";

describe("createSdkClient", () => {
	it("creates an OpencodeClient with the given baseUrl", () => {
		const { client } = createSdkClient({ baseUrl: "http://localhost:4096" });
		expect(client).toBeDefined();
		expect(client.session).toBeDefined();
		expect(client.event).toBeDefined();
	});

	it("applies directory header when provided", () => {
		const { client } = createSdkClient({
			baseUrl: "http://localhost:4096",
			directory: "/home/user/project",
		});
		expect(client).toBeDefined();
	});

	it("uses custom fetch when provided", () => {
		const customFetch = vi.fn(async () => new Response("ok"));
		const { client } = createSdkClient({
			baseUrl: "http://localhost:4096",
			fetch: customFetch,
		});
		expect(client).toBeDefined();
	});

	it("returns authHeaders when auth is configured", () => {
		const { authHeaders } = createSdkClient({
			baseUrl: "http://localhost:4096",
			auth: { username: "user", password: "pass" },
		});
		expect(authHeaders["Authorization"]).toMatch(/^Basic /);
	});
});
