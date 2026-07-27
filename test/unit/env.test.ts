import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("env module", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("exports DEFAULT_CONFIG_DIR from homedir when XDG_CONFIG_HOME is unset", async () => {
		// CONDUIT_CONFIG_DIR takes precedence over the XDG/homedir logic, so it
		// must be cleared to exercise the fallback (it is set in this machine's env).
		vi.stubEnv("CONDUIT_CONFIG_DIR", undefined);
		vi.stubEnv("XDG_CONFIG_HOME", undefined);
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toMatch(/\.conduit$/);
	});

	it("respects XDG_CONFIG_HOME when set", async () => {
		// CONDUIT_CONFIG_DIR takes precedence over XDG_CONFIG_HOME, so clear it
		// to exercise the XDG branch (it is set in this machine's env).
		vi.stubEnv("CONDUIT_CONFIG_DIR", undefined);
		vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg-test");
		const { DEFAULT_CONFIG_DIR } = await import("../../src/lib/env.js");
		expect(DEFAULT_CONFIG_DIR).toBe("/tmp/xdg-test/conduit");
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
		vi.stubEnv("HOST", undefined);
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.host).toBe("127.0.0.1");
	});

	it("ENV.host respects HOST env var", async () => {
		vi.stubEnv("HOST", "0.0.0.0");
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.host).toBe("0.0.0.0");
	});

	it("ENV.debug is false by default", async () => {
		vi.stubEnv("DEBUG", undefined);
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.debug).toBe(false);
	});

	it('ENV.debug is true when DEBUG="1"', async () => {
		vi.stubEnv("DEBUG", "1");
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.debug).toBe(true);
	});

	it('ENV.opencodeUsername defaults to "opencode"', async () => {
		vi.stubEnv("OPENCODE_SERVER_USERNAME", undefined);
		const { ENV } = await import("../../src/lib/env.js");
		expect(ENV.opencodeUsername).toBe("opencode");
	});

	it("resolveTraceConfig defaults to local daemon logs under configDir", async () => {
		const { resolveTraceConfig } = await import("../../src/lib/env.js");
		expect(resolveTraceConfig("/tmp/conduit-config", {})).toEqual({
			enabled: true,
			filePath: "/tmp/conduit-config/logs/server.trace.ndjson",
			maxBytes: 10_485_760,
			maxFiles: 10,
			batchWindowMs: 200,
		});
	});

	it("resolveTraceConfig resolves relative trace files against configDir", async () => {
		const { resolveTraceConfig } = await import("../../src/lib/env.js");
		expect(
			resolveTraceConfig("/tmp/conduit-config", {
				CONDUIT_TRACE_FILE: "custom/trace.ndjson",
			}).filePath,
		).toBe("/tmp/conduit-config/custom/trace.ndjson");
	});

	it("resolveTraceConfig bounds numeric overrides and falls back on invalid numbers", async () => {
		const { resolveTraceConfig } = await import("../../src/lib/env.js");
		const config = resolveTraceConfig("/tmp/conduit-config", {
			CONDUIT_TRACE_MAX_BYTES: "123abc",
			CONDUIT_TRACE_MAX_FILES: "200",
			CONDUIT_TRACE_BATCH_WINDOW_MS: "not-a-number",
		});

		expect(config.maxBytes).toBe(10_485_760);
		expect(config.maxFiles).toBe(100);
		expect(config.batchWindowMs).toBe(200);
	});

	it("resolveTraceConfig clamps complete numeric strings only", async () => {
		const { resolveTraceConfig } = await import("../../src/lib/env.js");
		const config = resolveTraceConfig("/tmp/conduit-config", {
			CONDUIT_TRACE_MAX_BYTES: "1",
		});

		expect(config.maxBytes).toBe(1024);
	});

	it("resolveTraceConfig disables local tracing with CONDUIT_TRACE_ENABLED=0", async () => {
		const { resolveTraceConfig } = await import("../../src/lib/env.js");
		expect(
			resolveTraceConfig("/tmp/conduit-config", {
				CONDUIT_TRACE_ENABLED: "0",
			}).enabled,
		).toBe(false);
	});
});
