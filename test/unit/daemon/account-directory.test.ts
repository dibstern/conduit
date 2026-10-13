// Failure modes: live ids lose to aliases/deleted records; defaults are missing,
// dangling or cross-driver; unknown refs silently use OpenCode; empty drivers
// appear routable; list/default/resolve disagree; configured and launch logins
// lose their SDK login kind; account env leaks usage credentials; only missing
// config may use defaults (unreadable/invalid config must preserve typed errors).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Either, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountsState,
	accountRefFromSelection,
	accountsStateFromConfig,
	defaultFor,
	list,
	resolve,
} from "../../../src/lib/account-directory.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	defaultDaemonConfig,
	loadAccountsState,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	configuredClaudeConfigDir,
	sdkDefaultClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";

const launch = sdkDefaultClaudeConfigDir("/isolated-home/.claude");
const configured = configuredClaudeConfigDir("/accounts/work");
const state = (): AccountsState =>
	accountsStateFromConfig(
		{
			...defaultDaemonConfig(),
			instances: [
				{
					id: "claude",
					name: "Claude",
					driver: "claude",
					port: 0,
					managed: false,
				},
				{
					id: "work",
					name: "Work",
					driver: "claude",
					configDir: configured.path,
					port: 0,
					managed: false,
				},
				{
					id: "external",
					name: "External",
					driver: "opencode",
					url: "http://localhost:4599",
					port: 4599,
					managed: false,
				},
			],
		},
		launch,
	);
const route = (input: AccountsState, id: string) =>
	resolve(input, { _tag: "Id", id });
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("account directory reads", () => {
	it("lists live accounts and materialises the Claude default before lookup", () => {
		const input = state();
		expect(
			list(input)
				.filter((account) => account.isDefault)
				.map((account) => account.id),
		).toEqual(["claude", "opencode"]);
		expect(defaultFor(input, "claude")).toEqual(
			Option.some(Either.getOrThrow(route(input, "claude"))),
		);
		expect(Either.getOrThrow(route(input, "work"))).toMatchObject({
			driver: "claude",
			folder: configured,
			configuredFolder: configured.path,
			usageEligible: true,
		});
		expect(Either.getOrThrow(route(input, "external"))).toMatchObject({
			driver: "opencode",
			url: "http://localhost:4599",
		});
		expect("isDefault" in Either.getOrThrow(route(input, "work"))).toBe(false);
	});

	it("keeps live-first resolution even when the id is a legacy alias or deleted", () => {
		const input = state();
		const alias = {
			driver: "opencode" as const,
			id: AccountIdSchema.make("claude-sdk"),
			name: "Alias account",
		};
		const withAlias = {
			...input,
			accounts: [alias, ...input.accounts],
			deleted: [{ id: alias.id, driver: "claude" as const }],
		};
		expect(route(withAlias, "claude-sdk")).toEqual(Either.right(alias));
		expect(route(input, "claude-sdk")).toEqual(route(input, "claude"));
	});

	it("routes deleted and legacy ids through their driver pointer", () => {
		const input = state();
		const work = Either.getOrThrow(route(input, "work"));
		const moved = {
			...input,
			accounts: input.accounts.filter((account) => account.id !== "claude"),
			defaults: { claude: Option.some(work.id) },
			deleted: [
				{ id: AccountIdSchema.make("removed"), driver: "claude" as const },
			],
		};
		for (const id of ["claude", "claude-sdk", "removed"])
			expect(route(moved, id)).toEqual(Either.right(work));
		expect(resolve(moved, { _tag: "DriverDefault", driver: "claude" })).toEqual(
			Either.right(work),
		);
	});

	it("rejects unknown ids and defaults of drivers with no accounts, naming the ref", () => {
		const empty: AccountsState = {
			launchLogin: launch,
			maxAccounts: 5,
			accounts: [],
			defaults: { claude: Option.none() },
			deleted: [],
		};
		for (const ref of [
			{ _tag: "Id", id: "unknown" },
			{ _tag: "Id", id: "claude-sdk" },
			{ _tag: "DriverDefault", driver: "claude" },
			{ _tag: "DriverDefault", driver: "opencode" },
		] as const) {
			const result = resolve(empty, ref);
			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left.ref).toEqual(ref);
				expect(result.left.message).toContain(
					ref._tag === "Id" ? ref.id : ref.driver,
				);
			}
		}
		expect(defaultFor(empty, "claude")).toEqual(Option.none());
		expect(defaultFor(empty, "opencode")).toEqual(Option.none());
		expect(list(empty)).toEqual([]);
	});

	it("looks up stored defaults without recomputing or crossing drivers", () => {
		const input = state();
		for (const id of ["absent", "external"]) {
			const dangling = {
				...input,
				defaults: { claude: Option.some(AccountIdSchema.make(id)) },
			};
			expect(defaultFor(dangling, "claude")).toEqual(Option.none());
			expect(
				Either.isLeft(
					resolve(dangling, { _tag: "DriverDefault", driver: "claude" }),
				),
			).toBe(true);
		}
	});

	it("resolves configured folders and both launch login kinds explicitly", () => {
		for (const login of [launch, configuredClaudeConfigDir("/launch-login")]) {
			const input = accountsStateFromConfig(
				{
					...defaultDaemonConfig(),
					instances: [
						{
							id: "claude",
							name: "Claude",
							driver: "claude",
							port: 0,
							managed: false,
							configDir: "/stored-login",
						},
						{
							id: "no-folder",
							name: "Launch",
							driver: "claude",
							port: 0,
							managed: false,
						},
					],
				},
				login,
			);
			expect(Either.getOrThrow(route(input, "no-folder"))).toMatchObject({
				folder: login,
			});
			expect(Either.getOrThrow(route(input, "claude"))).toMatchObject({
				folder: configuredClaudeConfigDir("/stored-login"),
				configuredFolder: "/stored-login",
			});
		}
	});

	it("derives usage eligibility from per-account credentials", () => {
		for (const env of [
			{ ANTHROPIC_API_KEY: "key" },
			{ ANTHROPIC_AUTH_TOKEN: "token" },
			{ ANTHROPIC_API_KEY: "" },
			{ CUSTOM_ENV: "value" },
		]) {
			const input = accountsStateFromConfig(
				{
					...defaultDaemonConfig(),
					instances: [
						{
							id: "key",
							name: "Key",
							driver: "claude",
							port: 0,
							managed: false,
							env,
						},
					],
				},
				launch,
			);
			expect(Either.getOrThrow(route(input, "key"))).toMatchObject({
				env,
				usageEligible: !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN,
			});
		}
	});

	it("classifies wire picks without applying a fallback", () => {
		expect(
			accountRefFromSelection({ provider: "opencode", model: "gpt" }),
		).toEqual({ _tag: "DriverDefault", driver: "opencode" });
		expect(
			accountRefFromSelection({ provider: "missing-account", model: "m" }),
		).toEqual({ _tag: "Id", id: "missing-account" });
		expect(
			accountRefFromSelection({ provider: "claude-sdk", model: "sonnet" }),
		).toEqual({ _tag: "DriverDefault", driver: "claude" });
		expect(
			accountRefFromSelection({ instanceId: "work", providerId: "opencode" }),
		).toEqual({ _tag: "Id", id: "work" });
		for (const providerId of ["claude", "claude-sdk"])
			expect(accountRefFromSelection({ providerId })).toEqual({
				_tag: "DriverDefault",
				driver: "claude",
			});
		expect(
			accountRefFromSelection({ model: { providerID: "claude" } }),
		).toEqual({ _tag: "DriverDefault", driver: "claude" });
		expect(
			accountRefFromSelection({ model: { providerID: "openai" } }),
		).toEqual({ _tag: "DriverDefault", driver: "opencode" });
		expect(accountRefFromSelection({ providerId: "unknown" })).toEqual({
			_tag: "Id",
			id: "unknown",
		});
	});

	it("only uses install defaults for a missing daemon.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "g4zp-directory-"));
		tempDirs.push(dir);
		const missing = loadAccountsState(dir, launch);
		expect(Either.isRight(missing)).toBe(true);
		if (Either.isRight(missing))
			expect(Either.getOrThrow(route(missing.right, "claude"))).toMatchObject({
				folder: launch,
			});
		writeFileSync(join(dir, "daemon.json"), "{invalid");
		const invalid = loadAccountsState(dir, launch);
		expect(Either.isLeft(invalid) && invalid.left._tag).toBe("Invalid");
		rmSync(join(dir, "daemon.json"));
		mkdirSync(join(dir, "daemon.json"));
		const unreadable = loadAccountsState(dir, launch);
		expect(Either.isLeft(unreadable) && unreadable.left._tag).toBe(
			"Unreadable",
		);
	});
});
