import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("env module", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("exports DEFAULT_CONFIG_DIR from homedir when XDG_CONFIG_HOME is unset", async () => {
		delete process.env["XDG_CONFIG_HOME"];
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toMatch(/\.opencode-relay$/);
	});

	it("respects XDG_CONFIG_HOME when set", async () => {
		process.env["XDG_CONFIG_HOME"] = "/tmp/xdg-test";
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toBe("/tmp/xdg-test/opencode-relay");
	});

	it("DEFAULT_PORT is 2633", async () => {
		const { DEFAULT_PORT } = await import("../../src/lib/env.js");
		expect(DEFAULT_PORT).toBe(2633);
	});

	it("DEFAULT_OC_PORT is 4096", async () => {
		const { DEFAULT_OC_PORT } = await import("../../src/lib/env.js");
		expect(DEFAULT_OC_PORT).toBe(4096);
	});

	it("ENV.host defaults to 127.0.0.1 when HOST is not set", async () => {
		delete process.env["HOST"];
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.host).toBe("127.0.0.1");
	});

	it("ENV.host respects HOST env var", async () => {
		process.env["HOST"] = "0.0.0.0";
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.host).toBe("0.0.0.0");
	});

	it("ENV.debug is false by default", async () => {
		delete process.env["DEBUG"];
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.debug).toBe(false);
	});

	it('ENV.debug is true when DEBUG="1"', async () => {
		process.env["DEBUG"] = "1";
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.debug).toBe(true);
	});

	it('ENV.opencodeUsername defaults to "opencode"', async () => {
		delete process.env["OPENCODE_SERVER_USERNAME"];
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.opencodeUsername).toBe("opencode");
	});
});
