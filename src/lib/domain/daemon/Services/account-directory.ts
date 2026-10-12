import { Context, Effect, Either, Layer, Ref } from "effect";
import type {
	Account,
	AccountListItem,
	AccountRef,
} from "../../../contracts/account.js";
import { AccountChangeRejected } from "../../../contracts/account.js";
import type { AccountUnroutable } from "../../../contracts/limit-recovery.js";
import type { KnownProviderDriverKind } from "../../../contracts/provider-instance.js";
import {
	type AccountChange,
	type AccountsState,
	accountsStateFromInstances,
	apply,
	defaultFor,
	list,
	loadAccountsState,
	resolve,
} from "../../../daemon/account-directory.js";
import type { ClaudeConfigDir } from "../../../provider/claude/claude-sdk-env.js";
import type { DaemonInstanceConfig } from "./daemon-state.js";

export class AccountDirectory extends Context.Tag("AccountDirectory")<
	AccountDirectory,
	{
		readonly list: Effect.Effect<ReadonlyArray<AccountListItem>>;
		readonly defaultFor: (
			driver: KnownProviderDriverKind,
		) => Effect.Effect<import("effect").Option.Option<Account>>;
		readonly resolve: (
			ref: AccountRef,
		) => Effect.Effect<Account, AccountUnroutable>;
		readonly apply: <E = never, R = never>(
			change: AccountChange,
			usageOrder?: ReadonlyArray<string>,
			afterCommit?: (state: AccountsState) => Effect.Effect<void, E, R>,
		) => Effect.Effect<AccountsState, AccountChangeRejected | E, R>;
	}
>() {}

export function makeAccountDirectory(
	read: Effect.Effect<AccountsState>,
	commit?: AccountDirectory["Type"]["apply"],
): AccountDirectory["Type"] {
	return {
		list: Effect.map(read, list),
		defaultFor: (driver) =>
			Effect.map(read, (state) => defaultFor(state, driver)),
		resolve: (ref) => Effect.flatMap(read, (state) => resolve(state, ref)),
		apply:
			commit ??
			((change) =>
				Effect.fail(
					new AccountChangeRejected({
						id: change.id ?? "",
						reason: "Account directory is read-only",
					}),
				)),
	};
}

const makeWritableAccountDirectory = (initial: AccountsState) =>
	Effect.gen(function* () {
		const state = yield* Ref.make(initial);
		const changes = yield* Effect.makeSemaphore(1);
		return makeAccountDirectory(
			changes.withPermits(1)(Ref.get(state)),
			<E, R>(
				change: AccountChange,
				usageOrder: ReadonlyArray<string> = [],
				afterCommit?: (state: AccountsState) => Effect.Effect<void, E, R>,
			) =>
				changes.withPermits(1)(
					Effect.gen(function* () {
						const committed = yield* Ref.modify(state, (current) => {
							const result = apply(current, change, usageOrder);
							return [
								{ previous: current, result },
								Either.isRight(result) ? result.right : current,
							] as const;
						});
						const next = yield* committed.result;
						// A failed process stop must retain the account and its recovery identity.
						// Serialize readers and changes until the post-commit work has settled.
						if (afterCommit !== undefined)
							yield* afterCommit(next).pipe(
								Effect.onError(() => Ref.set(state, committed.previous)),
							);
						return next;
					}).pipe(Effect.uninterruptible),
				),
		);
	});

/** Account metadata has its own atomic state, independent of process runtime. */
export const AccountDirectoryStateLive = (initial: AccountsState) =>
	Layer.effect(AccountDirectory, makeWritableAccountDirectory(initial));

export const AccountDirectoryLive = (
	launchLogin: ClaudeConfigDir,
	initialInstances: ReadonlyArray<DaemonInstanceConfig> = [],
	maxAccounts = 5,
) =>
	AccountDirectoryStateLive(
		accountsStateFromInstances(
			initialInstances.map((instance) => ({
				...instance,
				driver: instance.driver ?? "opencode",
			})),
			launchLogin,
			maxAccounts,
		),
	);

export const AccountDirectoryFromConfigLive = (
	configDir: string,
	launchLogin: ClaudeConfigDir,
) =>
	Layer.effect(
		AccountDirectory,
		Effect.flatMap(
			Effect.suspend(() => loadAccountsState(configDir, launchLogin)),
			makeWritableAccountDirectory,
		),
	);
