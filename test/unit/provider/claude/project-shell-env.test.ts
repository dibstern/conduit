import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeProviderInstanceDeps } from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeSdkEnv } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	findExecutable,
	ProjectShellEnvResolver,
} from "../../../../src/lib/provider/project-shell-env.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import {
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

let home: string;
let project: string;
const resolvers: ProjectShellEnvResolver[] = [];

function resolver(
	options: ConstructorParameters<typeof ProjectShellEnvResolver>[0] = {},
) {
	const value = new ProjectShellEnvResolver({
		env: {
			HOME: home,
			ZDOTDIR: home,
			SHELL: "/bin/zsh",
			PATH: "/usr/bin:/bin",
		},
		watchIntervalMs: 20,
		...options,
	});
	resolvers.push(value);
	return value;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "conduit-shell-env-"));
	project = join(home, "project");
	mkdirSync(project);
	writeFileSync(join(home, ".zprofile"), 'export PATH="/usr/bin:/bin"\n');
});

afterEach(() => {
	for (const value of resolvers.splice(0)) value.close();
	rmSync(home, { recursive: true, force: true });
});

describe("project shell environment", () => {
	it("captures a noisy login shell and passes its env to a Claude query, sanitising last", async () => {
		writeFileSync(
			join(home, ".zprofile"),
			[
				'export PATH="/usr/bin:/bin"',
				'echo "startup banner"',
				'export PROJECT_LOGIN_VALUE="line one=1\nline two"',
				'export ANTHROPIC_API_KEY="login-secret"',
			].join("\n"),
		);
		writeFileSync(join(home, ".zshrc"), 'export INTERACTIVE_ONLY="on"\n');
		const env = resolver();
		env.register(project, {
			overrides: {
				PROJECT_OVERRIDE: "explicit",
				ANTHROPIC_AUTH_TOKEN: "override-secret",
				CLAUDE_AGENT_SDK_CLIENT_APP: "wrong",
			},
		});
		await env.refresh(project);
		const queryFactory = vi.fn<
			NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
		>(() => createMockQuery([makeSuccessResult()]));
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: project,
			shellEnv: (directory) => env.get(directory),
			queryFactory,
		});
		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					workspaceRoot: project,
					model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
					configDir: "/named/claude",
				}),
			),
		);
		const sdkEnv = queryFactory.mock.calls[0]?.[0]?.options?.env;
		expect(sdkEnv).toMatchObject({
			PROJECT_LOGIN_VALUE: "line one=1\nline two",
			PROJECT_OVERRIDE: "explicit",
			CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
			CLAUDE_CONFIG_DIR: "/named/claude",
			ENABLE_CLAUDEAI_MCP_SERVERS: "false",
		});
		expect(sdkEnv).not.toHaveProperty("INTERACTIVE_ONLY");
		expect(sdkEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(sdkEnv).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
		expect(env.snapshot(project).sources).toEqual(["login", "overrides"]);
	});

	it.each([
		"login",
		"overrides",
		"default",
	] as const)("persists the %s Claude profile for forks and resumes after an env refresh", async (source) => {
		const configDir = join(
			home,
			source === "default" ? ".claude" : "claude-profile",
		);
		writeFileSync(
			join(home, ".zprofile"),
			`export PATH="/usr/bin:/bin"\n${source === "default" ? "" : `export CLAUDE_CONFIG_DIR="${source === "login" ? configDir : join(home, "other-profile")}"\n`}`,
		);
		const env = resolver();
		env.register(
			project,
			source === "overrides"
				? { overrides: { CLAUDE_CONFIG_DIR: configDir } }
				: {},
		);
		await env.refresh(project);
		const queryFactory = vi.fn<
			NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
		>(() => createMockQuery([makeSuccessResult()]));
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: project,
			shellEnv: (directory) => env.get(directory),
			queryFactory,
		});
		const input = makeBaseSendTurnInput({
			workspaceRoot: project,
			model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
		});
		const result = await Effect.runPromise(instance.sendTurnEffect(input));
		if (source !== "default")
			expect(
				queryFactory.mock.calls[0]?.[0]?.options?.env?.["CLAUDE_CONFIG_DIR"],
			).toBe(configDir);
		expect(result.providerStateUpdates).toContainEqual({
			key: "claudeConfigDir",
			value: configDir,
		});
		env.register(project, {
			overrides: { CLAUDE_CONFIG_DIR: join(home, "refreshed-profile") },
		});
		await env.refresh(project);
		const resumed = makeTestClaudeProviderInstance({
			workspaceRoot: project,
			shellEnv: (directory) => env.get(directory),
			queryFactory,
		});
		await Effect.runPromise(
			resumed.sendTurnEffect({
				...input,
				providerState: Object.fromEntries(
					result.providerStateUpdates.map(({ key, value }) => [key, value]),
				),
			}),
		);
		expect(queryFactory.mock.calls[1]?.[0]?.options).toMatchObject({
			resume: "sdk-session-1",
			env: { CLAUDE_CONFIG_DIR: configDir },
		});
		const namedConfigDir = join(home, "explicit-instance");
		const namedInstance = makeTestClaudeProviderInstance({
			workspaceRoot: project,
			shellEnv: (directory) => env.get(directory),
			queryFactory,
		});
		const namedResult = await Effect.runPromise(
			namedInstance.sendTurnEffect({
				...input,
				configDir: namedConfigDir,
				providerState: {
					resumeSessionId: "sdk-session-1",
					claudeConfigDir: configDir,
				},
			}),
		);
		expect(
			queryFactory.mock.calls[2]?.[0]?.options?.env?.["CLAUDE_CONFIG_DIR"],
		).toBe(namedConfigDir);
		expect(namedResult.providerStateUpdates).toContainEqual({
			key: "claudeConfigDir",
			value: namedConfigDir,
		});
	});

	it("applies real mise.toml removals and values before explicit overrides", async (ctx) => {
		const mise = findExecutable("mise", process.env, process.cwd());
		if (!mise) {
			ctx.skip(
				"mise is unavailable on PATH; real mise environment cannot be exercised",
			);
			return;
		}
		writeFileSync(
			join(home, ".zprofile"),
			`export PATH="${dirname(mise)}:/usr/bin:/bin"\nexport PROJECT_MISE_VALUE="login"\nexport CLAUDE_CODE_OAUTH_TOKEN="login-token"\nexport PROJECT_MISE_OVERRIDE="login"\n`,
		);
		writeFileSync(
			join(project, "mise.toml"),
			'[env]\nPROJECT_MISE_VALUE = "mise"\nPROJECT_MISE_OVERRIDE = false\nCLAUDE_CODE_OAUTH_TOKEN = false\n',
		);
		const miseEnv = {
			HOME: home,
			ZDOTDIR: home,
			SHELL: "/bin/zsh",
			PATH: "/usr/bin:/bin",
			MISE_TRUSTED_CONFIG_PATHS: project,
			MISE_CONFIG_DIR: join(home, "mise-config"),
			MISE_DATA_DIR: join(home, "mise-data"),
			MISE_CACHE_DIR: join(home, "mise-cache"),
		};
		const shellOutput = execFileSync(mise, ["env", "-s", "bash"], {
			cwd: project,
			env: miseEnv,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		if (!shellOutput.includes("unset CLAUDE_CODE_OAUTH_TOKEN")) {
			ctx.skip(
				"installed mise predates inherited-variable removal support (fixed in 2026.9.1, jdx/mise#12664); deterministic removal coverage still runs",
			);
			return;
		}
		const env = resolver({ env: miseEnv });
		env.register(project, { overrides: { PROJECT_MISE_OVERRIDE: "explicit" } });
		await env.refresh(project);
		expect(env.get(project)).toMatchObject({
			PROJECT_MISE_VALUE: "mise",
			PROJECT_MISE_OVERRIDE: "explicit",
		});
		expect(env.get(project)).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
		expect(makeClaudeSdkEnv({ baseEnv: env.get(project) })).not.toHaveProperty(
			"CLAUDE_CODE_OAUTH_TOKEN",
		);
		expect(env.snapshot(project).sources).toEqual([
			"login",
			"mise",
			"overrides",
		]);
		expect(env.snapshot(project).warnings).toEqual([]);
		writeFileSync(
			join(project, "mise.toml"),
			'[env]\nPROJECT_MISE_VALUE = "changed"\n',
		);
		await vi.waitFor(() =>
			expect(env.get(project)["PROJECT_MISE_VALUE"]).toBe("changed"),
		);
	});

	it("applies mise unsets before explicit overrides without losing inherited values", async () => {
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(home, ".zprofile"),
			[
				`export PATH="${bin}:/usr/bin:/bin"`,
				'export CLAUDE_CODE_OAUTH_TOKEN="login-token"',
				'export PROJECT_KEEP="login"',
				'export PROJECT_OVERRIDE="login"',
			].join("\n"),
		);
		writeFileSync(
			join(bin, "mise"),
			[
				"#!/bin/sh",
				"cat <<'ENV'",
				"unset CLAUDE_CODE_OAUTH_TOKEN",
				"unset PROJECT_OVERRIDE",
				"export PROJECT_ADDED='mise=value",
				"line two'",
				"ENV",
			].join("\n"),
		);
		chmodSync(join(bin, "mise"), 0o755);
		const env = resolver();
		env.register(project, { overrides: { PROJECT_OVERRIDE: "explicit" } });
		await env.refresh(project);
		expect(env.snapshot(project).warnings).toEqual([]);
		expect(makeClaudeSdkEnv({ baseEnv: env.get(project) })).not.toHaveProperty(
			"CLAUDE_CODE_OAUTH_TOKEN",
		);
		expect(env.get(project)).toMatchObject({
			PROJECT_KEEP: "login",
			PROJECT_ADDED: "mise=value\nline two",
			PROJECT_OVERRIDE: "explicit",
		});
	});

	it("captures login and interactive env without POSIX-only status expansion", async () => {
		const shell = join(home, "fish-syntax-guard");
		writeFileSync(
			shell,
			[
				"#!/bin/sh",
				"for command do :; done",
				"case \"$command\" in *'$?'*) exit 2 ;; esac",
				'exec /bin/zsh "$@"',
			].join("\n"),
		);
		chmodSync(shell, 0o755);
		writeFileSync(
			join(home, ".zprofile"),
			'export PATH="/usr/bin:/bin"\nexport LOGIN_CAPTURE="yes"\n',
		);
		writeFileSync(join(home, ".zshrc"), 'export INTERACTIVE_CAPTURE="yes"\n');
		const env = resolver({ shell });
		env.register(project);
		await env.refresh(project);
		expect(env.get(project)["LOGIN_CAPTURE"]).toBe("yes");
		expect(env.snapshot(project).warnings).toEqual([]);
		env.register(project, { interactive: true });
		await env.refresh(project);
		expect(env.get(project)["INTERACTIVE_CAPTURE"]).toBe("yes");
		expect(env.snapshot(project).sources).toEqual(["login", "interactive"]);
		expect(env.snapshot(project).warnings).toEqual([]);
	});

	it("captures a real fish login and opt-in interactive environment", async (ctx) => {
		const fish = findExecutable("fish", process.env, process.cwd());
		if (!fish) {
			ctx.skip(
				"fish is unavailable on PATH; the portable capture command is covered by the syntax-guard test",
			);
			return;
		}
		const config = join(home, "fish-config");
		mkdirSync(join(config, "fish"), { recursive: true });
		writeFileSync(
			join(config, "fish", "config.fish"),
			[
				"set -gx PATH /usr/bin /bin",
				"if status is-login; set -gx FISH_LOGIN yes; end",
				"if status is-interactive; set -gx FISH_INTERACTIVE yes; end",
			].join("\n"),
		);
		const env = resolver({
			shell: fish,
			env: {
				HOME: home,
				XDG_CONFIG_HOME: config,
				SHELL: fish,
				PATH: "/usr/bin:/bin",
			},
		});
		env.register(project);
		await env.refresh(project);
		expect(env.get(project)["FISH_LOGIN"]).toBe("yes");
		expect(env.get(project)).not.toHaveProperty("FISH_INTERACTIVE");
		env.register(project, { interactive: true });
		await env.refresh(project);
		expect(env.get(project)).toMatchObject({
			FISH_LOGIN: "yes",
			FISH_INTERACTIVE: "yes",
		});
		expect(env.snapshot(project).warnings).toEqual([]);
	});

	it("runs an interactive shell only when opted in and applies overrides last", async () => {
		writeFileSync(
			join(home, ".zprofile"),
			'export PATH="/usr/bin:/bin"\nexport PROJECT_ORDER="login"\n',
		);
		writeFileSync(
			join(home, ".zshrc"),
			'export PROJECT_ORDER="interactive"\nexport INTERACTIVE_ONLY="on"\n',
		);
		const env = resolver();
		env.register(project, {
			interactive: true,
			overrides: { PROJECT_ORDER: "explicit" },
		});
		await env.refresh(project);
		expect(env.get(project)).toMatchObject({
			PROJECT_ORDER: "explicit",
			INTERACTIVE_ONLY: "on",
		});
		expect(env.snapshot(project).sources).toEqual([
			"login",
			"interactive",
			"overrides",
		]);
	});

	it("does not hold up first or stale Claude session creation behind a sleeping shell", async () => {
		const shell = join(home, "slow-shell");
		writeFileSync(shell, '#!/bin/sh\nsleep 2\nexec /bin/zsh "$@"\n');
		chmodSync(shell, 0o755);
		const env = resolver({ shell, timeoutMs: 1500, ttlMs: 5000 });
		env.register(project);
		const queryFactory = vi.fn<
			NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
		>(() => createMockQuery([makeSuccessResult()]));
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: project,
			shellEnv: (directory) => env.get(directory),
			queryFactory,
		});
		const send = async (sessionId: string) => {
			const started = performance.now();
			await Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						workspaceRoot: project,
						sessionId,
						model: { providerId: "claude", modelId: "claude-sonnet-4-5" },
					}),
				),
			);
			expect(performance.now() - started).toBeLessThan(500);
		};
		await send("cold-env");
		expect(env.snapshot(project).resolving).toBe(true);
		expect(queryFactory.mock.calls[0]?.[0]?.options?.env?.["HOME"]).toBe(home);
		expect(env.snapshot(project).resolvedAt).toBeNull();
		await env.refresh(project);
		expect(env.snapshot(project).warnings.join(" ")).toMatch(/timeout/i);
		writeFileSync(shell, '#!/bin/sh\nexec /bin/zsh "$@"\n');
		writeFileSync(
			join(home, ".zprofile"),
			'export PATH="/usr/bin:/bin"\nexport LAST_GOOD="kept"\n',
		);
		await env.refresh(project);
		writeFileSync(shell, '#!/bin/sh\nsleep 2\nexec /bin/zsh "$@"\n');
		const pending = env.refresh(project);
		await send("stale-env");
		expect(queryFactory.mock.calls[1]?.[0]?.options?.env?.["LAST_GOOD"]).toBe(
			"kept",
		);
		await pending;
		expect(env.get(project)["LAST_GOOD"]).toBe("kept");
	});

	it("keeps the last good env and timestamp on malformed output or failed mise", async () => {
		const shell = join(home, "shell");
		writeFileSync(shell, '#!/bin/sh\nexec /bin/zsh "$@"\n');
		chmodSync(shell, 0o755);
		const env = resolver({ shell });
		env.register(project);
		await env.refresh(project);
		const before = env.snapshot(project).resolvedAt;
		writeFileSync(shell, "#!/bin/sh\necho no-markers\n");
		await env.refresh(project);
		expect(env.snapshot(project).resolvedAt).toBe(before);
		expect(env.snapshot(project).warnings.join(" ")).toMatch(/marker/i);
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "mise"),
			'#!/bin/sh\necho "do not leak secrets" >&2\nexit 9\n',
		);
		chmodSync(join(bin, "mise"), 0o755);
		writeFileSync(shell, '#!/bin/sh\nexec /bin/zsh "$@"\n');
		writeFileSync(
			join(home, ".zprofile"),
			`export PATH="${bin}:/usr/bin:/bin"\n`,
		);
		await env.refresh(project);
		expect(env.snapshot(project).resolvedAt).toBe(before);
		expect(env.snapshot(project).warnings.join(" ")).toMatch(/mise/);
		expect(env.snapshot(project).warnings.join(" ")).not.toContain(
			"do not leak secrets",
		);
		writeFileSync(join(bin, "mise"), '#!/bin/sh\necho "{bad json}"\n');
		await env.refresh(project);
		expect(env.snapshot(project).resolvedAt).toBe(before);
		expect(env.snapshot(project).warnings.join(" ")).toMatch(/mise/);
	});

	it("refreshes on file creation, atomic rc replacement and TTL without cross-project leakage", async () => {
		const other = join(home, "other");
		mkdirSync(other);
		const env = resolver({ ttlMs: 80 });
		env.register(project, { overrides: { PROJECT_ID: "first" } });
		env.register(other, { overrides: { PROJECT_ID: "second" } });
		await Promise.all([env.refresh(project), env.refresh(other)]);
		writeFileSync(join(home, ".zshenv"), 'export CREATED_RC="yes"\n');
		await vi.waitFor(() => expect(env.get(project)["CREATED_RC"]).toBe("yes"));
		writeFileSync(
			join(home, "replacement"),
			'export PATH="/usr/bin:/bin"\nexport REPLACED_RC="yes"\n',
		);
		renameSync(join(home, "replacement"), join(home, ".zprofile"));
		await vi.waitFor(() => expect(env.get(project)["REPLACED_RC"]).toBe("yes"));
		const resolvedAt = env.snapshot(project).resolvedAt;
		await vi.waitFor(() =>
			expect(env.snapshot(project).resolvedAt).not.toBe(resolvedAt),
		);
		expect(env.get(project)["PROJECT_ID"]).toBe("first");
		expect(env.get(other)["PROJECT_ID"]).toBe("second");
	});

	it("resolves tools on the effective PATH, including relative entries", () => {
		writeFileSync(join(project, "node"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(project, "node"), 0o755);
		writeFileSync(join(project, "claude"), "not executable");
		expect(findExecutable("node", { PATH: "." }, project)).toBe(
			join(project, "node"),
		);
		expect(findExecutable("claude", { PATH: "." }, project)).toBeUndefined();
		expect(findExecutable("opencode", {}, project)).toBeUndefined();
	});

	it("coalesces concurrent refreshes and cancels a removed project's pending work", async () => {
		const shell = join(home, "slow-shell");
		const launches = join(home, "launches");
		writeFileSync(
			shell,
			`#!/bin/sh\necho run >> "${launches}"\nsleep 0.2\nexec /bin/zsh "$@"\n`,
		);
		chmodSync(shell, 0o755);
		const env = resolver({ shell, timeoutMs: 1000 });
		env.register(project);
		const first = env.refresh(project);
		expect(env.refresh(project)).toBe(first);
		env.remove(project);
		await first;
		expect(env.directories()).toEqual([]);
		env.register(project, { overrides: { NEW_ENTRY: "yes" } });
		await env.refresh(project);
		expect(env.get(project)["NEW_ENTRY"]).toBe("yes");
	});

	it("sanitises direct Anthropic keys from a supplied base without mutating it", () => {
		const base = {
			ANTHROPIC_API_KEY: "key",
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_BASE_URL: "url",
			ANTHROPIC_CUSTOM_HEADERS: "headers",
			ANTHROPIC_MODEL: "model",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
			ANTHROPIC_SMALL_FAST_MODEL: "fast",
			PATH: "/project/bin",
		};
		const env = makeClaudeSdkEnv({ baseEnv: base });
		for (const key of Object.keys(base).filter((key) =>
			key.startsWith("ANTHROPIC_"),
		))
			expect(env).not.toHaveProperty(key);
		expect(base.ANTHROPIC_API_KEY).toBe("key");
		expect(env["PATH"]).toBe("/project/bin");
	});
});
