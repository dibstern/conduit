/* Failure modes, through config decoding and the account directory interface:
 * - Legacy synthesized/stored Claude loses its id, name, folder or default.
 * - Account folders lose precedence to the retired server-wide folder.
 * - Migration changes projects/session counts or rewrites a current file twice.
 * - Fresh installs lack an ordinary default account or persist the launch override.
 * - Current configs with missing/dangling pointers resurrect a deleted account.
 * - Legacy driver-only selections choose the live claude id over Personal.
 * Every file and launch login belongs to this fixture; no ambient config is read.
 */
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	accountRefFromSelection,
	accountsStateFromConfig,
	defaultFor,
	list,
	resolve,
} from "../../../src/lib/account-directory.js";
import {
	CURRENT_CONFIG_VERSION,
	DaemonConfigSchema,
	defaultDaemonConfig,
	loadAccountsState,
	loadDaemonConfigStartupResult,
	migrateDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	configuredClaudeConfigDir,
	sdkDefaultClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "g4zp-7-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const launch = sdkDefaultClaudeConfigDir("/isolated-home/.claude");
const decode = Schema.decodeUnknownSync(DaemonConfigSchema);
const legacy = () => {
	const {
		configVersion: _version,
		instances: _instances,
		accountDefaults: _defaults,
		...config
	} = defaultDaemonConfig();
	return {
		...config,
		projects: [
			{
				path: "/isolated-project",
				folders: ["/isolated-project"],
				slug: "saved",
				addedAt: 1,
				sessionCount: 7,
			},
		],
	};
};

describe("account config migration", () => {
	it.each([
		{
			name: "synthesized",
			instances: [],
			folder: "/stored-login",
			expectedName: "Claude",
		},
		{
			name: "stored",
			instances: [
				{
					id: "claude",
					name: "My login",
					driver: "claude",
					port: 0,
					managed: false,
				},
			],
			folder: "/stored-login",
			expectedName: "My login",
		},
		{
			name: "account-folder",
			instances: [
				{
					id: "claude",
					name: "My login",
					driver: "claude",
					port: 0,
					managed: false,
					configDir: "/account-login",
					env: { ACCOUNT_MARKER: "saved" },
				},
			],
			folder: "/account-login",
			expectedName: "My login",
		},
	])("upgrades the $name built-in without changing projects or its login", ({
		instances,
		folder,
		expectedName,
	}) => {
		const input = { ...legacy(), claudeConfigDir: "/stored-login", instances };
		const config = decode(input);
		const accounts = accountsStateFromConfig(config, launch);
		expect(config).not.toHaveProperty("claudeConfigDir");
		expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
		expect(config.projects).toEqual(input.projects);
		expect(
			list(accounts).filter((account) => account.driver === "claude"),
		).toEqual([
			expect.objectContaining({
				id: "claude",
				name: expectedName,
				folder: configuredClaudeConfigDir(folder),
				configuredFolder: folder,
				isDefault: true,
			}),
		]);
		expect(
			config.instances?.find((account) => account.id === "claude"),
		).toMatchObject({ configDir: folder });
		expect(defaultFor(accounts, "claude")).toEqual(
			Option.some(
				Either.getOrThrow(resolve(accounts, { _tag: "Id", id: "claude" })),
			),
		);
		expect(decode(config)).toEqual(config);
	});

	it("keeps the legacy built-in default even when usage order starts with Personal", () => {
		const config = decode({
			...legacy(),
			usageLimits: {
				autoResume: false,
				autoSwitch: false,
				warnAt: 80,
				order: ["personal"],
			},
			instances: [
				{
					id: "personal",
					name: "Personal",
					driver: "claude",
					configDir: "/personal",
					port: 0,
					managed: false,
				},
			],
		});
		expect(config.accountDefaults).toEqual({ claude: "claude" });
	});

	it("saves a migrated snapshot once and decodes the saved config identically", async () => {
		const path = join(dir, "daemon.json");
		writeFileSync(
			path,
			JSON.stringify({ ...legacy(), claudeConfigDir: "/saved-login" }),
		);
		const first = Either.getOrThrow(loadDaemonConfigStartupResult(dir));
		expect(first.needsMigration).toBe(true);
		await Effect.runPromise(
			migrateDaemonConfig(first.config, dir, first.needsMigration),
		);
		const bytes = readFileSync(path);
		const identity = statSync(path);
		const second = Either.getOrThrow(loadDaemonConfigStartupResult(dir));
		expect(second.config).toEqual(first.config);
		expect(second.needsMigration).toBe(false);
		await Effect.runPromise(
			migrateDaemonConfig(second.config, dir, second.needsMigration),
		);
		expect(readFileSync(path)).toEqual(bytes);
		expect(statSync(path).ino).toBe(identity.ino);
		expect(statSync(path).mtimeMs).toBe(identity.mtimeMs);
	});

	it("creates exactly one ordinary Claude default on a fresh install without saving the launch login", async () => {
		for (const login of [
			launch,
			configuredClaudeConfigDir("/explicit-launch-login"),
		]) {
			const accounts = Either.getOrThrow(loadAccountsState(dir, login));
			expect(
				list(accounts).filter((account) => account.driver === "claude"),
			).toEqual([
				expect.objectContaining({
					id: "claude",
					name: "Claude",
					folder: login,
					isDefault: true,
				}),
			]);
			expect(
				Either.getOrThrow(resolve(accounts, { _tag: "Id", id: "claude" })),
			).not.toHaveProperty("configuredFolder");
		}
		await saveDaemonConfig(defaultDaemonConfig(), dir);
		const saved = Either.getOrThrow(loadDaemonConfigStartupResult(dir));
		expect(saved.needsMigration).toBe(false);
		expect(
			saved.config.instances?.filter((account) => account.driver === "claude"),
		).toEqual([
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				port: 0,
				managed: false,
			},
		]);
	});

	it.each([
		{},
		{ claude: "removed" },
	])("keeps a current-version empty Claude directory empty with pointer %j", async (accountDefaults) => {
		const config = decode({
			...defaultDaemonConfig(),
			instances: [],
			claudeConfigDir: "/retired-login",
			accountDefaults,
		});
		expect(config.accountDefaults).toEqual({});
		await saveDaemonConfig(config, dir);
		const restarted = Either.getOrThrow(loadAccountsState(dir, launch));
		expect(
			list(restarted).filter((account) => account.driver === "claude"),
		).toEqual([]);
		expect(defaultFor(restarted, "claude")).toEqual(Option.none());
		expect(
			Either.isLeft(resolve(restarted, { _tag: "Id", id: "claude" })),
		).toBe(true);
		expect(decode(config)).toEqual(config);
	});

	it("routes legacy driver-only selections to Personal while the ordinary claude account remains live", () => {
		const config = decode({
			...defaultDaemonConfig(),
			accountDefaults: { claude: "personal" },
			instances: [
				{
					id: "claude",
					name: "Claude",
					driver: "claude",
					port: 0,
					managed: false,
					configDir: "/original",
				},
				{
					id: "personal",
					name: "Personal",
					driver: "claude",
					port: 0,
					managed: false,
					configDir: "/personal",
				},
			],
		});
		const accounts = accountsStateFromConfig(config, launch);
		for (const selection of [
			{ provider: "claude", model: "sonnet" },
			{ provider: "claude-sdk", model: "sonnet" },
			{ model: { providerID: "claude" } },
		]) {
			expect(
				Either.getOrThrow(
					resolve(accounts, accountRefFromSelection(selection)),
				),
			).toMatchObject({
				id: "personal",
				folder: configuredClaudeConfigDir("/personal"),
			});
		}
		expect(
			Either.getOrThrow(resolve(accounts, { _tag: "Id", id: "claude" })),
		).toMatchObject({
			id: "claude",
			folder: configuredClaudeConfigDir("/original"),
		});
	});
});
