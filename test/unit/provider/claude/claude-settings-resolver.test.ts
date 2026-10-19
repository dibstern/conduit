// Failure modes: settings read stale on-disk accounts or the inherited login;
// a directory update while resolving the workspace changes the selected login;
// unknown and non-Claude accounts reach the settings child.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountsStateFromConfig } from "../../../../src/lib/account-directory.js";
import { CLAUDE_DISPLAYABLE_SETTINGS_KEYS } from "../../../../src/lib/contracts/claude-settings.js";
import { defaultDaemonConfig } from "../../../../src/lib/daemon/config-persistence.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigTag } from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../../../src/lib/domain/relay/Services/session-workspace.js";
import { resolveClaudeSettingsForInstance } from "../../../../src/lib/handlers/claude-settings.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	type ClaudeSettingsChildRunner,
	resolveClaudeSettingsFromDisk,
} from "../../../../src/lib/provider/claude/claude-settings-resolver.js";
import { makeMockConfig } from "../../../helpers/mock-factories.js";

let isolatedRoot: string;
beforeEach(() => {
	isolatedRoot = mkdtempSync(join(tmpdir(), "conduit-settings-login-"));
	vi.stubEnv("HOME", isolatedRoot);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolatedRoot, "inherited-login"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedRoot, { recursive: true, force: true });
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
}));

/** Every displayable key, unset — the shape the child always emits. */
const unsetDisplaySettings = (): Record<string, unknown> =>
	Object.fromEntries(CLAUDE_DISPLAYABLE_SETTINGS_KEYS.map((key) => [key, {}]));

const successResult = {
	stdout: JSON.stringify({
		...unsetDisplaySettings(),
		autoCompactEnabled: {
			value: false,
			source: "user",
			path: "/profiles/work/settings.json",
		},
	}),
	stderr: "",
	exitCode: 0,
	timedOut: false,
	outputTooLarge: false,
} as const;

describe("resolveClaudeSettingsFromDisk", () => {
	it("projects secrets out inside the real child before stdout reaches the daemon", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "conduit-claude-workspace-"),
		);
		const configDir = mkdtempSync(join(tmpdir(), "conduit-claude-profile-"));
		writeFileSync(
			join(configDir, "settings.json"),
			JSON.stringify({
				autoCompactEnabled: false,
				env: { SECRET_TOKEN: "child-secret-canary" },
			}),
		);
		const spawn = childProcess.spawn;
		let stdout = "";
		const spy = vi
			.spyOn(childProcess, "spawn")
			.mockImplementation((...args) => {
				const child = spawn(...args);
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
				});
				return child;
			});

		try {
			const result = await Effect.runPromise(
				resolveClaudeSettingsFromDisk({
					workspaceRoot,
					configDir: configuredClaudeConfigDir(configDir),
				}),
			);

			expect(result.autoCompactEnabled).toEqual({
				value: false,
				source: "user",
				path: join(configDir, "settings.json"),
			});
			expect(Object.keys(JSON.parse(stdout)).sort()).toEqual(
				[...CLAUDE_DISPLAYABLE_SETTINGS_KEYS].sort(),
			);
			expect(stdout).not.toContain("child-secret-canary");
			expect(stdout).not.toContain('"env"');
		} finally {
			spy.mockRestore();
			rmSync(workspaceRoot, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("uses the project cwd and instance config dir, then validates the result", async () => {
		const runner = vi.fn<ClaudeSettingsChildRunner>(async () => successResult);

		const result = await Effect.runPromise(
			resolveClaudeSettingsFromDisk(
				{
					workspaceRoot: "/workspace/project",
					configDir: configuredClaudeConfigDir("/profiles/work"),
				},
				runner,
			),
		);

		expect(result).toEqual(JSON.parse(successResult.stdout));
		expect(runner).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/workspace/project",
				timeoutMs: 5_000,
				env: expect.objectContaining({
					CLAUDE_CONFIG_DIR: "/profiles/work",
					CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
				}),
			}),
		);
	});

	it("keeps the resolved account folder when the directory changes during workspace resolution", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-claude-resolver-"));
		writeFileSync(join(configDir, "daemon.json"), "not valid JSON");
		const accountFolder = join(isolatedRoot, "work-login");
		const launchLogin = configuredClaudeConfigDir(
			join(isolatedRoot, "launch-login"),
		);
		const stateForFolder = (folder: string) =>
			accountsStateFromConfig(
				{
					pid: 123,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
					instances: [
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
							configDir: folder,
						},
					],
				},
				launchLogin,
			);
		let accounts = stateForFolder(accountFolder);
		const runner = vi.fn<ClaudeSettingsChildRunner>(async () => successResult);

		await Effect.runPromise(
			resolveClaudeSettingsForInstance(
				{
					instanceId: "work-claude",
					accountRef: { _tag: "Id", id: "work-claude" },
					sessionId: "session-1",
				},
				runner,
			).pipe(
				Effect.provideService(SessionWorkspaceTag, {
					renameBranch: () => Effect.die("unused"),
					get: () =>
						Effect.sync(() => {
							accounts = stateForFolder(join(isolatedRoot, "changed-login"));
							return "/workspace/project";
						}),
					move: () => Effect.succeed("/workspace/project"),
					inherit: () => Effect.die("unused"),
					resolve: () => Effect.die("unused"),
					preview: () => Effect.die("unused"),
					record: () => Effect.die("unused"),
					claudeWorktreeState: () => Effect.die("unused"),
					withLaunch: (effect) => effect,
				}),
				Effect.provideService(
					AccountDirectory,
					makeAccountDirectory(Effect.sync(() => accounts)),
				),
				Effect.provideService(
					ConfigTag,
					makeMockConfig({
						configDir,
						projectDir: "/workspace/project",
					}),
				),
			),
		);

		expect(runner).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/workspace/project",
				env: expect.objectContaining({ CLAUDE_CONFIG_DIR: accountFolder }),
			}),
		);
		rmSync(configDir, { recursive: true, force: true });
	});

	it.each([
		{ instanceId: "unknown-account", tag: "AccountUnroutable" },
		{ instanceId: "opencode", tag: "ClaudeSettingsInstanceError" },
	])("rejects $instanceId before starting the settings child", async ({
		instanceId,
		tag,
	}) => {
		const runner = vi.fn<ClaudeSettingsChildRunner>(async () => successResult);
		const failure = await Effect.runPromise(
			resolveClaudeSettingsForInstance(
				{
					instanceId,
					accountRef: { _tag: "Id", id: instanceId },
				},
				runner,
			).pipe(
				Effect.provideService(SessionWorkspaceTag, {
					renameBranch: () =>
						Effect.die("Account refusal must not change workspace"),
					get: () => Effect.die("Account refusal must not read workspace"),
					move: () => Effect.die("Account refusal must not change workspace"),
					inherit: () => Effect.die("unused"),
					resolve: () => Effect.die("unused"),
					preview: () => Effect.die("unused"),
					record: () => Effect.die("unused"),
					claudeWorktreeState: () => Effect.die("unused"),
					withLaunch: (effect) => effect,
				}),
				Effect.provideService(
					AccountDirectory,
					makeAccountDirectory(
						Effect.succeed(
							accountsStateFromConfig(
								defaultDaemonConfig(),
								configuredClaudeConfigDir(join(isolatedRoot, "launch-login")),
							),
						),
					),
				),
				Effect.provideService(
					ConfigTag,
					makeMockConfig({ configDir: isolatedRoot }),
				),
				Effect.flip,
			),
		);
		expect(failure._tag).toBe(tag);
		expect(failure.message).toContain(instanceId);
		expect(runner).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "timeout",
			result: { ...successResult, exitCode: null, timedOut: true },
			reason: "timeout",
		},
		{
			name: "non-zero exit",
			result: { ...successResult, exitCode: 2, stderr: "sdk failed" },
			reason: "non-zero-exit",
		},
		{
			name: "bad JSON",
			result: { ...successResult, stdout: "not-json" },
			reason: "invalid-json",
		},
		{
			name: "invalid result",
			result: { ...successResult, stdout: JSON.stringify({ effective: {} }) },
			reason: "invalid-result",
		},
	])("returns a typed failure for $name", async ({ result, reason }) => {
		const failure = await Effect.runPromise(
			Effect.flip(
				resolveClaudeSettingsFromDisk(
					{
						workspaceRoot: "/workspace/project",
						configDir: configuredClaudeConfigDir("/profiles/work"),
					},
					async () => result,
				),
			),
		);

		expect(failure._tag).toBe("ClaudeSettingsResolveError");
		expect(failure.reason).toBe(reason);
	});
});

import * as childProcess from "node:child_process";
