import { Either, Option, ParseResult, Schema } from "effect";
import {
	type Account,
	AccountAddInputSchema,
	type AccountChange,
	AccountChangeRejected,
	type AccountListItem,
	type AccountRef,
} from "./contracts/account.js";
import type { ClaudeConfigDir } from "./contracts/claude-config-dir.js";
import { AccountUnroutable } from "./contracts/limit-recovery.js";
import {
	type AccountId,
	AccountIdSchema,
	isKnownDriverKind,
	type KnownProviderDriverKind,
	KnownProviderDriverKindSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "./contracts/provider-instance.js";
import type { DaemonConfig } from "./daemon/config-persistence.js";

export { MANAGED_OPENCODE_ACCOUNT_ID };
export type { AccountChange } from "./contracts/account.js";

const LEGACY_ACCOUNT_DRIVERS: Readonly<
	Record<string, KnownProviderDriverKind | undefined>
> = {
	claude: "claude",
	"claude-sdk": "claude",
	opencode: "opencode",
};

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
		const driver = Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, providerId)
			? LEGACY_ACCOUNT_DRIVERS[providerId]
			: undefined;
		return driver === undefined
			? { _tag: "Id", id: providerId }
			: { _tag: "DriverDefault", driver };
	}
	const provider =
		typeof selection.model === "object"
			? selection.model.providerID
			: undefined;
	const driver =
		provider !== undefined && Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, provider)
			? LEGACY_ACCOUNT_DRIVERS[provider]
			: undefined;
	return {
		_tag: "DriverDefault",
		driver: provider === undefined ? "claude" : (driver ?? "opencode"),
	};
}

export interface AccountsState {
	readonly launchLogin: ClaudeConfigDir;
	readonly maxAccounts: number;
	readonly accounts: ReadonlyArray<Account>;
	readonly defaults: { readonly claude: Option.Option<AccountId> };
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
		readonly deleted?: AccountsState["deleted"] | undefined;
		readonly usageOrder?: ReadonlyArray<string> | undefined;
	} = {},
): AccountsState {
	const accounts = instances.map((instance): Account => {
		const id = AccountIdSchema.make(instance.id);
		if (instance.driver === "opencode")
			return {
				driver: "opencode",
				id,
				name: instance.name,
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
		const configuredFolder = instance.configDir?.trim() || undefined;
		return {
			driver: "claude",
			id,
			name: instance.name,
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
	});
	return {
		launchLogin,
		maxAccounts,
		accounts,
		defaults: {
			claude: materializeClaudeDefault(
				accounts,
				settings.defaultClaudeId,
				settings.usageOrder ?? [],
			),
		},
		deleted: settings.deleted ?? [],
	};
}

function materializeClaudeDefault(
	accounts: ReadonlyArray<{
		readonly id: string;
		readonly driver: KnownProviderDriverKind;
	}>,
	storedId: string | undefined,
	usageOrder: ReadonlyArray<string>,
): Option.Option<AccountId> {
	const stored = accounts.find(
		(account) => account.id === storedId && account.driver === "claude",
	);
	if (stored !== undefined) return Option.some(AccountIdSchema.make(stored.id));
	for (const id of usageOrder) {
		const account = accounts.find(
			(account) => account.id === id && account.driver === "claude",
		);
		if (account !== undefined)
			return Option.some(AccountIdSchema.make(account.id));
	}
	return Option.map(
		Option.fromNullable(
			accounts.find((account) => account.driver === "claude"),
		),
		(account) => AccountIdSchema.make(account.id),
	);
}

/** All account invariants commit together. */
export function apply(
	state: AccountsState,
	change: AccountChange,
	usageOrder: ReadonlyArray<string>,
): Either.Either<AccountsState, AccountChangeRejected> {
	const id = change.id ?? (change._tag === "Add" ? change.name : "");
	const reject = (reason: string) =>
		Either.left(new AccountChangeRejected({ id, reason }));
	if (change._tag === "Add") {
		const name = change.name.trim();
		if (!name) return reject("AddInstance failed: name is required");
		if (!isKnownDriverKind(change.driver ?? "opencode"))
			return reject(
				`Unknown account driver "${change.driver}"; expected ${KnownProviderDriverKindSchema.literals.join(" or ")}`,
			);
		const decoded = Schema.decodeUnknownEither(AccountAddInputSchema)({
			...change,
			name,
			driver: change.driver ?? "opencode",
		});
		if (Either.isLeft(decoded))
			return reject(
				ParseResult.ArrayFormatter.formatErrorSync(decoded.left)
					.filter((issue) => !issue.message.startsWith("Expected undefined"))
					.map((issue) =>
						issue.path.length === 0
							? issue.message
							: `${issue.path.map(String).join(".")}: ${issue.message}`,
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
			(Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, allocated) ||
				state.accounts.some((account) => account.id === allocated) ||
				state.deleted.some((account) => account.id === allocated))
		)
			return reject(
				`Instance "${allocated}" already exists, is a reserved driver id, or was deleted`,
			);
		let counter = 2;
		while (
			Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, allocated) ||
			state.accounts.some((account) => account.id === allocated) ||
			state.deleted.some((account) => account.id === allocated)
		)
			allocated = `${base}-${counter++}`;
		const input = decoded.right;
		const account = accountsStateFromInstances(
			[
				{
					...input,
					id: allocated,
					managed:
						input.managed ??
						(input.driver === "opencode" && input.url === undefined),
				},
			],
			state.launchLogin,
		).accounts[0];
		if (account === undefined) return reject("Account allocation failed");
		return Either.right({
			...state,
			accounts: [...state.accounts, account],
			defaults:
				account.driver === "claude" && Option.isNone(state.defaults.claude)
					? { claude: Option.some(account.id) }
					: state.defaults,
		});
	}
	const current = state.accounts.find((account) => account.id === change.id);
	if (current === undefined) return reject(`Instance "${change.id}" not found`);
	const isDefaultClaude =
		current.driver === "claude" &&
		Option.contains(state.defaults.claude, current.id);
	if (change._tag === "SetDefault") {
		if (current.driver !== "claude")
			return reject("Only Claude accounts can be made default");
		return Either.right({
			...state,
			defaults: { claude: Option.some(current.id) },
		});
	}
	if (change._tag === "Remove") {
		const accounts = state.accounts.filter(
			(account) => account.id !== change.id,
		);
		return Either.right({
			...state,
			accounts,
			defaults: isDefaultClaude
				? { claude: materializeClaudeDefault(accounts, undefined, usageOrder) }
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
			`Unknown account driver "${driver}"; expected ${KnownProviderDriverKindSchema.literals.join(" or ")}`,
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
	const env = updates.env ?? current.env;
	const updated = accountsStateFromInstances(
		[
			{
				id: current.id,
				name,
				driver,
				...(configuredFolder === undefined
					? {}
					: { configDir: configuredFolder }),
				...(env === undefined ? {} : { env }),
				...(driver === "opencode"
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
	return Either.right({
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
	const claude = materializeClaudeDefault(
		accountInstancesFromConfig(config),
		config.accountDefaults?.claude,
		config.usageLimits?.order ?? [],
	);
	return {
		...config,
		accountDefaults: Option.match(claude, {
			onNone: () => ({}),
			onSome: (id) => ({ claude: id }),
		}),
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
			defaultClaudeId: config.accountDefaults?.claude,
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
		driver === "claude"
			? state.defaults.claude
			: Option.some(MANAGED_OPENCODE_ACCOUNT_ID);
	return Option.flatMap(id, (accountId) =>
		Option.fromNullable(
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
): Either.Either<Account, AccountUnroutable> {
	if (ref._tag === "Id") {
		const live = state.accounts.find((account) => account.id === ref.id);
		if (live !== undefined) return Either.right(live);
		const driver =
			state.deleted.find((account) => account.id === ref.id)?.driver ??
			(Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, ref.id)
				? LEGACY_ACCOUNT_DRIVERS[ref.id]
				: undefined);
		if (driver !== undefined)
			return Option.match(defaultFor(state, driver), {
				onNone: () => Either.left(new AccountUnroutable({ ref })),
				onSome: Either.right,
			});
	} else {
		return Option.match(defaultFor(state, ref.driver), {
			onNone: () => Either.left(new AccountUnroutable({ ref })),
			onSome: Either.right,
		});
	}
	return Either.left(new AccountUnroutable({ ref }));
}
