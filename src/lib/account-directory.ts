import { Option, Record as Records, Result, Schema, SchemaIssue } from "effect";
import {
	type Account,
	AccountAddInputSchema,
	type AccountChange,
	AccountChangeRejected,
	type AccountListItem,
	type AccountRef,
} from "./contracts/account.js";
import { ACCOUNT_COLOR_SLOT_COUNT } from "./contracts/account-color.js";
import type { ClaudeConfigDir } from "./contracts/claude-config-dir.js";
import { AccountUnroutable } from "./contracts/limit-recovery.js";
import {
	type AccountId,
	AccountIdSchema,
	getProviderDriver,
	isKnownDriverKind,
	type KnownProviderDriverKind,
	MANAGED_OPENCODE_ACCOUNT_ID,
	PROVIDER_DRIVERS,
} from "./contracts/provider-instance.js";
import type { DaemonConfig } from "./daemon/config-persistence.js";
import { assertNever } from "./utils.js";

export { MANAGED_OPENCODE_ACCOUNT_ID };
export type { AccountChange } from "./contracts/account.js";

const LEGACY_ACCOUNT_DRIVERS: Readonly<
	Record<string, KnownProviderDriverKind | undefined>
> = {
	"claude-sdk": "claude",
};

const accountDriverAlias = (
	value: string,
): KnownProviderDriverKind | undefined =>
	isKnownDriverKind(value)
		? value
		: Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, value)
			? LEGACY_ACCOUNT_DRIVERS[value]
			: undefined;

export function nextAccountColorSlot(
	accounts: readonly { readonly colorSlot?: number | undefined }[],
): number {
	const counts = Array<number>(ACCOUNT_COLOR_SLOT_COUNT).fill(0);
	for (const account of accounts) {
		if (account.colorSlot !== undefined)
			counts[account.colorSlot] = (counts[account.colorSlot] ?? 0) + 1;
	}
	return counts.indexOf(Math.min(...counts));
}

export function assignAccountColorSlots<
	T extends { readonly id: string; readonly colorSlot?: number | undefined },
>(
	accounts: readonly T[],
	reserved: readonly { readonly colorSlot?: number | undefined }[] = [],
): (T & { colorSlot: number })[] {
	// Reserve every stored slot before filling gaps, including later config rows.
	const assigned = [
		...reserved,
		...accounts.filter((account) => account.colorSlot !== undefined),
	];
	return accounts.map((account) => {
		const colorSlot = account.colorSlot ?? nextAccountColorSlot(assigned);
		const result = { ...account, colorSlot };
		if (account.colorSlot === undefined) assigned.push(result);
		return result;
	});
}

/** Classify wire selections without looking up the current default pointer. */
export function accountRefFromSelection(selection: {
	readonly instanceId?: string | undefined;
	readonly providerId?: string | undefined;
	readonly provider?: string | undefined;
	readonly model?: { readonly providerID: string } | string | undefined;
}): AccountRef {
	if (selection.instanceId !== undefined)
		return { _tag: "Id", id: selection.instanceId };
	const providerId = selection.providerId ?? selection.provider;
	if (providerId !== undefined) {
		const driver = accountDriverAlias(providerId);
		return driver === undefined
			? { _tag: "Id", id: providerId }
			: { _tag: "DriverDefault", driver };
	}
	const provider =
		typeof selection.model === "object"
			? selection.model.providerID
			: undefined;
	const driver =
		provider === undefined ? undefined : accountDriverAlias(provider);
	return {
		_tag: "DriverDefault",
		driver: provider === undefined ? "claude" : (driver ?? "opencode"),
	};
}

export interface AccountsState {
	readonly launchLogin: ClaudeConfigDir;
	readonly maxAccounts: number;
	readonly accounts: ReadonlyArray<Account>;
	readonly defaults: Readonly<
		Record<KnownProviderDriverKind, Option.Option<AccountId>>
	>;
	readonly deleted: ReadonlyArray<{
		readonly id: AccountId;
		readonly driver: KnownProviderDriverKind;
	}>;
}

/** Decode initial account metadata without reading configuration or the environment. */
export function accountsStateFromInstances(
	instances: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly colorSlot?: number | undefined;
		readonly driver: KnownProviderDriverKind;
		readonly configDir?: string | undefined;
		readonly env?: Readonly<Record<string, string>> | undefined;
		readonly url?: string | undefined;
		readonly port?: number | undefined;
		readonly managed?: boolean | undefined;
	}>,
	launchLogin: ClaudeConfigDir,
	maxAccounts = 5,
	settings: {
		readonly defaultClaudeId?: string | undefined;
		readonly defaultAccountIds?:
			| Readonly<Partial<Record<KnownProviderDriverKind, string | undefined>>>
			| undefined;
		readonly deleted?: AccountsState["deleted"] | undefined;
		readonly usageOrder?: ReadonlyArray<string> | undefined;
	} = {},
): AccountsState {
	const accounts = assignAccountColorSlots(instances).map(
		(instance): Account => {
			const id = AccountIdSchema.make(instance.id);
			const configuredFolder = instance.configDir?.trim() || undefined;
			switch (instance.driver) {
				case "opencode":
					return {
						driver: "opencode",
						usageEligible: false,
						id,
						name: instance.name,
						colorSlot: instance.colorSlot,
						...(instance.managed && instance.id !== MANAGED_OPENCODE_ACCOUNT_ID
							? { url: `http://localhost:${instance.port ?? 0}` }
							: instance.url === undefined
								? {}
								: { url: instance.url }),
						port: instance.port ?? 0,
						managed: instance.managed ?? false,
						...(instance.env === undefined ? {} : { env: instance.env }),
						...(instance.configDir === undefined
							? {}
							: { configuredFolder: instance.configDir }),
					};
				case "cursor":
					return {
						driver: instance.driver,
						id,
						name: instance.name,
						colorSlot: instance.colorSlot,
						...(configuredFolder === undefined ? {} : { configuredFolder }),
						...(instance.env === undefined ? {} : { env: instance.env }),
						usageEligible: Boolean(instance.env?.["CURSOR_AUTH_TOKEN"]?.trim()),
					};
				case "codex":
					return {
						driver: "codex",
						id,
						name: instance.name,
						colorSlot: instance.colorSlot,
						...(configuredFolder === undefined ? {} : { configuredFolder }),
						...(instance.env === undefined ? {} : { env: instance.env }),
						usageEligible: true,
					};
				case "claude":
					return {
						driver: "claude",
						id,
						name: instance.name,
						colorSlot: instance.colorSlot,
						folder:
							configuredFolder === undefined
								? launchLogin
								: { _tag: "Configured", path: configuredFolder },
						...(configuredFolder === undefined ? {} : { configuredFolder }),
						...(instance.env === undefined ? {} : { env: instance.env }),
						usageEligible:
							!instance.env?.["ANTHROPIC_API_KEY"] &&
							!instance.env?.["ANTHROPIC_AUTH_TOKEN"],
					};
				default:
					return assertNever(instance.driver);
			}
		},
	);
	return {
		launchLogin,
		maxAccounts,
		accounts,
		defaults: Records.map(PROVIDER_DRIVERS, (traits, driver) =>
			traits.defaultAccountSource === "selection"
				? materializeDefault(
						accounts,
						driver,
						settings.defaultAccountIds?.[driver] ??
							(driver === "claude" ? settings.defaultClaudeId : undefined),
						settings.usageOrder ?? [],
					)
				: Option.none(),
		),
		deleted: settings.deleted ?? [],
	};
}

function materializeDefault(
	accounts: ReadonlyArray<{
		readonly id: string;
		readonly driver: KnownProviderDriverKind;
	}>,
	driver: KnownProviderDriverKind,
	storedId: string | undefined,
	usageOrder: ReadonlyArray<string>,
): Option.Option<AccountId> {
	const stored = accounts.find(
		(account) => account.id === storedId && account.driver === driver,
	);
	if (stored !== undefined) return Option.some(AccountIdSchema.make(stored.id));
	for (const id of usageOrder) {
		const account = accounts.find(
			(account) => account.id === id && account.driver === driver,
		);
		if (account !== undefined)
			return Option.some(AccountIdSchema.make(account.id));
	}
	return Option.map(
		Option.fromNullishOr(accounts.find((account) => account.driver === driver)),
		(account) => AccountIdSchema.make(account.id),
	);
}

/** All account invariants commit together. */
export function apply(
	state: AccountsState,
	change: AccountChange,
	usageOrder: ReadonlyArray<string>,
): Result.Result<AccountsState, AccountChangeRejected> {
	const id = change.id ?? (change._tag === "Add" ? change.name : "");
	const reject = (reason: string) =>
		Result.fail(new AccountChangeRejected({ id, reason }));
	if (change._tag === "Add") {
		const name = change.name.trim();
		if (!name) return reject("AddInstance failed: name is required");
		if (!isKnownDriverKind(change.driver ?? "opencode"))
			return reject(
				`Unknown account driver "${change.driver}"; expected ${Object.keys(PROVIDER_DRIVERS).join(" or ")}`,
			);
		const decoded = Schema.decodeUnknownResult(AccountAddInputSchema)({
			...change,
			name,
			driver: change.driver ?? "opencode",
		});
		if (Result.isFailure(decoded))
			return reject(
				SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue)
					.issues.filter(
						(issue) => !issue.message.startsWith("Expected undefined"),
					)
					.map((issue) =>
						(issue.path?.length ?? 0) === 0
							? issue.message
							: `${issue.path?.map(String).join(".")}: ${issue.message}`,
					)
					.join("; "),
			);
		if (state.accounts.length >= state.maxAccounts)
			return reject(
				`Max instances reached (${state.maxAccounts}). Remove an instance first.`,
			);
		const base =
			name
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "") || "instance";
		let allocated = change.id ?? base;
		if (
			change.id !== undefined &&
			(accountDriverAlias(allocated) !== undefined ||
				state.accounts.some((account) => account.id === allocated) ||
				state.deleted.some((account) => account.id === allocated))
		)
			return reject(
				`Instance "${allocated}" already exists, is a reserved driver id, or was deleted`,
			);
		let counter = 2;
		while (
			accountDriverAlias(allocated) !== undefined ||
			state.accounts.some((account) => account.id === allocated) ||
			state.deleted.some((account) => account.id === allocated)
		)
			allocated = `${base}-${counter++}`;
		const input = decoded.success;
		const account = accountsStateFromInstances(
			[
				{
					...input,
					id: allocated,
					colorSlot: nextAccountColorSlot(state.accounts),
					managed:
						input.managed ??
						(PROVIDER_DRIVERS[input.driver].runsOpenCodeServer &&
							input.url === undefined),
				},
			],
			state.launchLogin,
		).accounts[0];
		if (account === undefined) return reject("Account allocation failed");
		return Result.succeed({
			...state,
			accounts: [...state.accounts, account],
			defaults:
				PROVIDER_DRIVERS[account.driver].defaultAccountSource === "selection" &&
				Option.isNone(state.defaults[account.driver])
					? { ...state.defaults, [account.driver]: Option.some(account.id) }
					: state.defaults,
		});
	}
	const current = state.accounts.find((account) => account.id === change.id);
	if (current === undefined) return reject(`Instance "${change.id}" not found`);
	const isDefault =
		PROVIDER_DRIVERS[current.driver].defaultAccountSource === "selection" &&
		Option.contains(state.defaults[current.driver], current.id);
	if (change._tag === "SetDefault") {
		if (PROVIDER_DRIVERS[current.driver].defaultAccountSource !== "selection")
			return reject("This account type does not support a selected default");
		return Result.succeed({
			...state,
			defaults: {
				...state.defaults,
				[current.driver]: Option.some(current.id),
			},
		});
	}
	if (change._tag === "Remove") {
		const accounts = state.accounts.filter(
			(account) => account.id !== change.id,
		);
		return Result.succeed({
			...state,
			accounts,
			defaults: isDefault
				? {
						...state.defaults,
						[current.driver]: materializeDefault(
							accounts,
							current.driver,
							undefined,
							usageOrder,
						),
					}
				: state.defaults,
			deleted: [
				...state.deleted.filter((account) => account.id !== current.id),
				{ id: current.id, driver: current.driver },
			],
		});
	}
	const updates = change.updates;
	const driver = updates.driver ?? current.driver;
	if (!isKnownDriverKind(driver))
		return reject(
			`Unknown account driver "${driver}"; expected ${Object.keys(PROVIDER_DRIVERS).join(" or ")}`,
		);
	if (driver !== current.driver)
		return reject(
			"An account's type can't be changed. Delete it and add a new account.",
		);
	const name = updates.name?.trim() ?? current.name;
	if (!name) return reject("RenameInstance failed: name is required");
	const configuredFolder =
		updates.configDir === undefined
			? current.configuredFolder
			: updates.configDir.trim() || undefined;
	const env =
		updates.env === undefined
			? current.env
			: current.driver === "cursor" &&
					!Object.hasOwn(updates.env, "CURSOR_AUTH_TOKEN") &&
					current.env?.["CURSOR_AUTH_TOKEN"] !== undefined
				? {
						...updates.env,
						CURSOR_AUTH_TOKEN: current.env["CURSOR_AUTH_TOKEN"],
					}
				: updates.env;
	const updated = accountsStateFromInstances(
		[
			{
				id: current.id,
				colorSlot: current.colorSlot,
				name,
				driver,
				...(configuredFolder === undefined
					? {}
					: { configDir: configuredFolder }),
				...(env === undefined ? {} : { env }),
				...(PROVIDER_DRIVERS[driver].runsOpenCodeServer
					? {
							port:
								updates.port ??
								(current.driver === "opencode" ? (current.port ?? 0) : 0),
							managed:
								current.driver === "opencode" && (current.managed ?? false),
							...(current.driver === "opencode" && current.url !== undefined
								? { url: current.url }
								: {}),
						}
					: {}),
			},
		],
		state.launchLogin,
	).accounts[0];
	if (updated === undefined) return reject("Account update failed");
	return Result.succeed({
		...state,
		accounts: state.accounts.map((account) =>
			account.id === current.id ? updated : account,
		),
	});
}

/** Claude accounts are explicit; the managed OpenCode default keeps its runtime semantics. */
function accountInstancesFromConfig(config: DaemonConfig) {
	const explicit = (config.instances ?? []).map((instance) => ({
		...instance,
		driver: instance.driver ?? ("opencode" as const),
	}));
	return [
		...explicit,
		...(!explicit.some(({ id }) => id === "opencode") &&
		!config.deletedAccounts?.some(({ id }) => id === "opencode")
			? [{ id: "opencode", name: "OpenCode", driver: "opencode" as const }]
			: []),
	];
}

/** Preserve the pre-pointer account once, including its retired server-wide folder. */
export function migrateLegacyClaudeAccount(
	config: DaemonConfig,
	claudeConfigDir?: string,
): DaemonConfig {
	if (config.configVersion !== undefined) return config;
	const instances = config.instances ?? [];
	const builtIn = instances.find(({ id }) => id === "claude");
	if (
		builtIn === undefined &&
		!config.deletedAccounts?.some(({ id }) => id === "claude")
	) {
		return {
			...config,
			instances: [
				...instances,
				{
					id: "claude",
					name: "Claude",
					driver: "claude",
					port: 0,
					managed: false,
					...(claudeConfigDir === undefined
						? {}
						: { configDir: claudeConfigDir }),
				},
			],
			accountDefaults: { claude: AccountIdSchema.make("claude") },
		};
	}
	// driver-dispatch-ok: migrates the legacy built-in Claude account by identity.
	if (builtIn === undefined || (builtIn.driver ?? "claude") !== "claude")
		return config;
	const folder = builtIn.configDir ?? claudeConfigDir;
	return {
		...config,
		instances: instances.map((instance) =>
			instance === builtIn
				? {
						...instance,
						driver: "claude",
						...(folder === undefined ? {} : { configDir: folder }),
					}
				: instance,
		),
		accountDefaults: { claude: AccountIdSchema.make("claude") },
	};
}

/** Decode and save use the same pointer rules as runtime account changes. */
export function normalizeAccountConfig(config: DaemonConfig): DaemonConfig {
	const accounts = accountInstancesFromConfig(config);
	return {
		...config,
		...(config.instances === undefined
			? {}
			: { instances: assignAccountColorSlots(config.instances) }),
		accountDefaults: Records.filterMap(PROVIDER_DRIVERS, (traits, driver) =>
			traits.defaultAccountSource === "selection"
				? Result.fromOption(
						materializeDefault(
							accounts,
							driver,
							config.accountDefaults?.[driver],
							config.usageLimits?.order ?? [],
						),
						() => undefined,
					)
				: Result.failVoid,
		),
		deletedAccounts: config.deletedAccounts ?? [],
	};
}

export function accountsStateFromConfig(
	config: DaemonConfig,
	launchLogin: ClaudeConfigDir,
): AccountsState {
	return accountsStateFromInstances(
		accountInstancesFromConfig(config),
		launchLogin,
		5,
		{
			defaultAccountIds: config.accountDefaults,
			deleted: config.deletedAccounts,
			usageOrder: config.usageLimits?.order,
		},
	);
}

export function defaultFor(
	state: AccountsState,
	driver: KnownProviderDriverKind,
): Option.Option<Account> {
	const id =
		getProviderDriver(driver)?.defaultAccountSource === "selection"
			? state.defaults[driver]
			: Option.some(MANAGED_OPENCODE_ACCOUNT_ID);
	return Option.flatMap(id, (accountId) =>
		Option.fromNullishOr(
			state.accounts.find(
				(account) => account.id === accountId && account.driver === driver,
			),
		),
	);
}

export function list(state: AccountsState): ReadonlyArray<AccountListItem> {
	return state.accounts.map((account) => ({
		...account,
		isDefault: Option.exists(
			defaultFor(state, account.driver),
			(selected) => selected.id === account.id,
		),
	}));
}

export function resolve(
	state: AccountsState,
	ref: AccountRef,
): Result.Result<Account, AccountUnroutable> {
	if (ref._tag === "Id") {
		const live = state.accounts.find((account) => account.id === ref.id);
		if (live !== undefined) return Result.succeed(live);
		const driver =
			state.deleted.find((account) => account.id === ref.id)?.driver ??
			accountDriverAlias(ref.id);
		if (driver !== undefined)
			return Option.match(defaultFor(state, driver), {
				onNone: () => Result.fail(new AccountUnroutable({ ref })),
				onSome: Result.succeed,
			});
	} else {
		return Option.match(defaultFor(state, ref.driver), {
			onNone: () => Result.fail(new AccountUnroutable({ ref })),
			onSome: Result.succeed,
		});
	}
	return Result.fail(new AccountUnroutable({ ref }));
}
