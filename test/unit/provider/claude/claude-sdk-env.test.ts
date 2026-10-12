// Failure modes: a launch inherits another account's folder, an empty folder
// bypasses validation, the SDK login kind is lost, or daemon model aliases leak.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClaudeSdkEnv } from "../../../../src/lib/provider/claude/claude-sdk-env.js";

describe("makeClaudeSdkEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("overrides the daemon Claude config dir for a named instance", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");

		const env = makeClaudeSdkEnv({
			configDir: { _tag: "Configured", path: "/instances/work-claude" },
		});

		expect(env["CLAUDE_CONFIG_DIR"]).toBe("/instances/work-claude");
	});

	it.each([
		"",
		"   ",
	])("rejects an empty folder %j despite a conflicting base environment", (path) => {
		expect(() =>
			makeClaudeSdkEnv({
				configDir: { _tag: "Configured", path },
				baseEnv: { CLAUDE_CONFIG_DIR: "/wrong/account" },
			}),
		).toThrow("Claude config directory must be non-empty");
	});

	it("keeps implicit and explicit logins distinct for the same standard folder", () => {
		const baseEnv = {
			HOME: "/wrong/home",
			CLAUDE_CONFIG_DIR: "/wrong/account",
		};
		const path = "/account/home/.claude";
		const implicit = makeClaudeSdkEnv({
			configDir: { _tag: "SdkDefault", path },
			baseEnv,
		});
		expect(implicit).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		expect(implicit["HOME"]).toBe("/account/home");
		const explicit = makeClaudeSdkEnv({
			configDir: { _tag: "Configured", path },
			baseEnv,
		});
		expect(explicit["CLAUDE_CONFIG_DIR"]).toBe(path);
		expect(explicit["HOME"]).toBe(baseEnv.HOME);
	});

	it("strips model-alias overrides inherited from the daemon's launch shell", () => {
		vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "au.anthropic.claude-opus-5");
		vi.stubEnv("ANTHROPIC_MODEL", "au.anthropic.claude-opus-5");
		vi.stubEnv("ANTHROPIC_SMALL_FAST_MODEL", "au.anthropic.claude-haiku-4-5");

		const env = makeClaudeSdkEnv({
			configDir: { _tag: "Configured", path: "/instances/claude" },
		});

		expect(env).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
		expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
		expect(env).not.toHaveProperty("ANTHROPIC_SMALL_FAST_MODEL");
	});
});
