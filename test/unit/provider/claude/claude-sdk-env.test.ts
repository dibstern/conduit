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

	it("strips model-alias overrides inherited from the daemon's launch shell", () => {
		vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "au.anthropic.claude-opus-5");
		vi.stubEnv("ANTHROPIC_MODEL", "au.anthropic.claude-opus-5");
		vi.stubEnv("ANTHROPIC_SMALL_FAST_MODEL", "au.anthropic.claude-haiku-4-5");

		const env = makeClaudeSdkEnv();

		expect(env).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
		expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
		expect(env).not.toHaveProperty("ANTHROPIC_SMALL_FAST_MODEL");
	});
});
