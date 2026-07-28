import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClaudeSdkEnv } from "../../../../src/lib/provider/claude/claude-sdk-env.js";

describe("makeClaudeSdkEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("overrides the daemon Claude config dir for a named instance", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");

		const env = makeClaudeSdkEnv({ configDir: "/instances/work-claude" });

		expect(env["CLAUDE_CONFIG_DIR"]).toBe("/instances/work-claude");
	});

	it("does not inject a Claude config dir when none is configured", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);

		const env = makeClaudeSdkEnv();

		expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
	});

	it("preserves the daemon Claude config dir without a non-empty override", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");

		expect(makeClaudeSdkEnv()["CLAUDE_CONFIG_DIR"]).toBe("/daemon/claude");
		expect(makeClaudeSdkEnv({ configDir: "" })["CLAUDE_CONFIG_DIR"]).toBe(
			"/daemon/claude",
		);
	});
});
