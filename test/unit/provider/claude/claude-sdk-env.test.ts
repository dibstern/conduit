// Failure modes: a launch inherits another account's folder, an empty folder
// bypasses validation, the SDK login kind is lost, or daemon model aliases leak.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import {
	type ClaudeLogin,
	claudeLoginChange,
	makeClaudeSdkEnv,
	sameClaudeLogin,
} from "../../../../src/lib/provider/claude/claude-sdk-env.js";

// Login changes must distinguish account boundaries from settings on one account.
describe("claudeLoginChange", () => {
	const login: ClaudeLogin = {
		instanceId: "account-a",
		root: "/project",
		configDir: { _tag: "Configured", path: "/accounts/a" },
		shellConfig: { overrides: { REGION: "a" }, interactive: false },
	};
	it.each<[string, Partial<ClaudeLogin>, "None" | "Settings" | "Account"]>([
		["unchanged", {}, "None"],
		["another account", { instanceId: "account-b" }, "Account"],
		[
			"another folder on the same account",
			{ configDir: { _tag: "Configured", path: "/accounts/b" } },
			"Account",
		],
		[
			"equivalent resolved folder",
			{ configDir: { _tag: "Configured", path: "../accounts/a" } },
			"None",
		],
		[
			"declared shell overrides",
			{ shellConfig: { overrides: { REGION: "b" }, interactive: false } },
			"Settings",
		],
		[
			"declared interactive shell",
			{ shellConfig: { overrides: { REGION: "a" }, interactive: true } },
			"Settings",
		],
		["older peer without shell config", { shellConfig: undefined }, "None"],
	])("classifies %s", (_, change, expected) => {
		const next = { ...login, ...change };
		expect(claudeLoginChange(login, next)).toBe(expected);
		expect(sameClaudeLogin(login, next)).toBe(expected === "None");
	});

	it("classifies changed account env as settings, regardless of instance alias", () => {
		const account = {
			driver: "claude" as const,
			id: AccountIdSchema.make("account-a"),
			name: "Account A",
			folder: login.configDir,
			usageEligible: true,
			env: { REGION: "a" },
		};
		const first = { ...login, account };
		const second = {
			...login,
			instanceId: "alias",
			account: { ...account, env: { REGION: "b" } },
		};
		expect(claudeLoginChange(first, second)).toBe("Settings");
	});
});

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
