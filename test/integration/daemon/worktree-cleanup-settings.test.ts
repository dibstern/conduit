/*
 * Failure modes: settings fields disappear on restart, partial current settings
 * decode with wrong defaults, legacy rules choose the wrong policy or age, or
 * a second startup changes already-migrated settings. Use real daemon RPC and
 * inspect daemon.json only while stopped, except the second-start stability check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeCleanup } from "../../../src/lib/contracts/worktree.js";
import { createInProcessDaemon } from "../../helpers/in-process-daemon.js";

type CleanupSetting = WorktreeCleanup;
const defaults: CleanupSetting = {
	onSettle: "nothing-missing",
	onDelete: false,
	settledAfterDays: null,
	keepWhen: "uncommitted-changes",
};

describe("Worktree cleanup settings through the in-process daemon", () => {
	let harness: ReturnType<typeof createInProcessDaemon> | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	async function start(legacy?: {
		version: 1 | undefined;
		rules: Record<string, unknown> | undefined;
	}) {
		const fixture = createInProcessDaemon();
		harness = fixture;
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				...(legacy
					? legacy.version === undefined
						? {}
						: { configVersion: legacy.version }
					: { configVersion: 2 }),
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				autoSettleAfterDays: null,
				projects: [],
				instances: [
					{
						id: "claude",
						name: "Test Claude",
						driver: "claude",
						port: 0,
						managed: false,
						configDir: join(fixture.root, "claude"),
					},
				],
				accountDefaults: { claude: "claude" },
				...(legacy?.rules === undefined
					? {}
					: { worktreeCleanup: legacy.rules }),
			}),
		);
		await fixture.restart();
		await fixture.rpc({ _tag: "SaveProject", folders: [fixture.projectDir] });
		const setting = () => fixture.rpc({ _tag: "GetWorktreeCleanupSetting" });
		const set = async (value: Partial<CleanupSetting>) => {
			const worktreeCleanup = { ...defaults, ...value };
			expect(
				await fixture.rpc({
					_tag: "SetWorktreeCleanupSetting",
					scope: "global",
					rules: worktreeCleanup,
				}),
			).toEqual({ global: worktreeCleanup });
			return worktreeCleanup;
		};
		return { fixture, setting, set };
	}

	it("persists all setting fields across daemon restart and decodes missing fields to defaults", async () => {
		const { fixture, setting, set } = await start();
		expect(await setting()).toEqual({ global: defaults });
		const saved = await set({
			onSettle: "keep",
			onDelete: true,
			settledAfterDays: 42,
			keepWhen: "tracked-changes",
		});
		await fixture.stop();
		await fixture.restart();
		expect(await setting()).toEqual({ global: saved });
		await fixture.stop();
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		expect(config["worktreeCleanup"]).toEqual(saved);
		writeFileSync(
			configPath,
			JSON.stringify({ ...config, worktreeCleanup: { onDelete: true } }),
		);
		await fixture.restart();
		expect(await setting()).toEqual({
			global: { ...defaults, onDelete: true },
		});
	});

	it.each(
		(
			[
				{ name: "missing cleanup", rules: undefined, expected: {} },
				{ name: "empty cleanup", rules: {}, expected: {} },
				{ name: "old merged", rules: { onSettle: "merged" }, expected: {} },
				{
					name: "old off",
					rules: { onSettle: "off" },
					expected: { onSettle: "keep" },
				},
				{
					name: "old any",
					rules: { onSettle: "any" },
					expected: { settledAfterDays: 0 },
				},
				{
					name: "idle only",
					rules: { onSettle: "off", afterInactiveDays: 42 },
					expected: { onSettle: "keep", settledAfterDays: 42 },
				},
				{
					name: "idle with default settle",
					rules: { afterInactiveDays: 3650 },
					expected: { settledAfterDays: 3650 },
				},
				{
					name: "merged switch",
					rules: { onSettle: "off", whenMerged: true },
					expected: {},
				},
				{
					name: "zero-commit switch",
					rules: { onSettle: "off", noCommitsBeyondDefault: true },
					expected: {},
				},
				{
					name: "only delete",
					rules: { onDelete: true },
					expected: { onDelete: true },
				},
				{
					name: "all local files",
					rules: { keepWhen: "any-local-files" },
					expected: { keepWhen: "any-local-files" },
				},
				{
					name: "all old fields",
					rules: {
						onSettle: "any",
						onDelete: true,
						afterInactiveDays: 42,
						whenMerged: true,
						noCommitsBeyondDefault: true,
						keepWhen: "tracked-changes",
					},
					expected: {
						settledAfterDays: 0,
						onDelete: true,
						keepWhen: "tracked-changes",
					},
				},
				{
					name: "version chooses old defaults",
					rules: { onSettle: "off", settledAfterDays: 0 },
					expected: { onSettle: "keep" },
				},
			] satisfies Array<{
				name: string;
				rules: Record<string, unknown> | undefined;
				expected: Partial<CleanupSetting>;
			}>
		).flatMap((scenario) =>
			([undefined, 1] as const).map((version) => ({
				...scenario,
				version,
				versionName: version === undefined ? "legacy" : "version 1",
			})),
		),
	)("migrates $versionName $name once across daemon restart", async ({
		rules,
		expected,
		version,
	}) => {
		const { fixture, setting } = await start({ rules, version });
		const migrated = { ...defaults, ...expected };
		expect(await setting()).toEqual({ global: migrated });
		const configPath = join(fixture.configDir, "daemon.json");
		await fixture.stop();
		const persisted = readFileSync(configPath, "utf8");
		const config = JSON.parse(persisted) as Record<string, unknown>;
		expect(config["configVersion"]).toBe(2);
		expect(config["worktreeCleanup"]).toEqual(migrated);
		await fixture.restart();
		expect(await setting()).toEqual({ global: migrated });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			...config,
			pid: process.pid,
			port: fixture.port,
		});
	});
});
