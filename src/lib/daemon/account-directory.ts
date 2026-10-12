import { Either, Option } from "effect";
import {
	type Account,
	type AccountListItem,
	type AccountRef,
	LEGACY_ACCOUNT_DRIVERS,
} from "../contracts/account.js";
import { AccountUnroutable } from "../contracts/limit-recovery.js";
import {
	type AccountId,
	AccountIdSchema,
	type KnownProviderDriverKind,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../contracts/provider-instance.js";
import {
	type ClaudeConfigDir,
	configuredClaudeConfigDir,
} from "../provider/claude/claude-sdk-env.js";
import {
	type DaemonConfig,
	type DaemonConfigLoadError,
	defaultDaemonConfig,
	loadDaemonConfigResult,
} from "./config-persistence.js";

export { MANAGED_OPENCODE_ACCOUNT_ID };

export interface AccountsState {
	readonly accounts: ReadonlyArray<Account>;
	readonly defaults: { readonly claude: Option.Option<AccountId> };
	readonly deleted: ReadonlyArray<{
		readonly id: AccountId;
		readonly driver: KnownProviderDriverKind;
	}>;
}

/** Project a registry snapshot without reading configuration or the environment. */
export function accountsStateFromInstances(
	instances: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly driver: KnownProviderDriverKind;
		readonly configDir?: string;
		readonly env?: Readonly<Record<string, string>>;
		readonly url?: string;
	}>,
	launchLogin: ClaudeConfigDir,
): AccountsState {
	const accounts = instances.map((instance): Account => {
		const id = AccountIdSchema.make(instance.id);
		if (instance.driver === "opencode")
			return {
				driver: "opencode",
				id,
				name: instance.name,
				...(instance.url === undefined ? {} : { url: instance.url }),
			};
		const configuredFolder = instance.configDir?.trim() || undefined;
		return {
			driver: "claude",
			id,
			name: instance.name,
			folder:
				configuredFolder === undefined
					? launchLogin
					: configuredClaudeConfigDir(configuredFolder),
			...(configuredFolder === undefined ? {} : { configuredFolder }),
			...(instance.env === undefined ? {} : { env: instance.env }),
			usageEligible:
				!instance.env?.["ANTHROPIC_API_KEY"] &&
				!instance.env?.["ANTHROPIC_AUTH_TOKEN"],
		};
	});
	const claude =
		accounts.find(
			(account) => account.driver === "claude" && account.id === "claude",
		) ?? accounts.find((account) => account.driver === "claude");
	return {
		accounts,
		defaults: { claude: Option.fromNullable(claude?.id) },
		deleted: [],
	};
}

/** Legacy config still synthesizes its built-ins until ticket 15 migrates it. */
export function accountsStateFromConfig(
	config: DaemonConfig,
	launchLogin: ClaudeConfigDir,
): AccountsState {
	const explicit = (config.instances ?? []).map((instance) => ({
		...instance,
		driver: instance.driver ?? ("opencode" as const),
		...(instance.id === "claude" &&
		instance.configDir === undefined &&
		config.claudeConfigDir !== undefined
			? { configDir: config.claudeConfigDir }
			: {}),
	}));
	const instances = [
		...explicit,
		...(!explicit.some(({ id }) => id === "opencode")
			? [{ id: "opencode", name: "OpenCode", driver: "opencode" as const }]
			: []),
		...(!explicit.some(({ id }) => id === "claude")
			? [
					{
						id: "claude",
						name: "Claude",
						driver: "claude" as const,
						...(config.claudeConfigDir === undefined
							? {}
							: { configDir: config.claudeConfigDir }),
					},
				]
			: []),
	];
	return accountsStateFromInstances(instances, launchLogin);
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

/** Daemonless relays use this once; only absence permits install defaults. */
export function loadAccountsState(
	configDir: string,
	launchLogin: ClaudeConfigDir,
): Either.Either<AccountsState, DaemonConfigLoadError> {
	const loaded = loadDaemonConfigResult(configDir);
	if (Either.isLeft(loaded))
		return loaded.left._tag === "NotFound"
			? Either.right(
					accountsStateFromConfig(defaultDaemonConfig(), launchLogin),
				)
			: Either.left(loaded.left);
	return Either.right(accountsStateFromConfig(loaded.right, launchLogin));
}
