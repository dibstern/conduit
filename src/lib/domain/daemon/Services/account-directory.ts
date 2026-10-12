import { Context, Effect, HashMap, Layer, Ref } from "effect";
import type {
	Account,
	AccountListItem,
	AccountRef,
} from "../../../contracts/account.js";
import type { AccountUnroutable } from "../../../contracts/limit-recovery.js";
import {
	isKnownDriverKind,
	type KnownProviderDriverKind,
} from "../../../contracts/provider-instance.js";
import {
	type AccountsState,
	accountsStateFromInstances,
	defaultFor,
	list,
	loadAccountsState,
	resolve,
} from "../../../daemon/account-directory.js";
import type { ClaudeConfigDir } from "../../../provider/claude/claude-sdk-env.js";
import { InstanceManagerStateTag } from "./instance-manager-service.js";

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
	}
>() {}

export function makeAccountDirectory(
	read: Effect.Effect<AccountsState>,
): AccountDirectory["Type"] {
	return {
		list: Effect.map(read, list),
		defaultFor: (driver) =>
			Effect.map(read, (state) => defaultFor(state, driver)),
		resolve: (ref) => Effect.flatMap(read, (state) => resolve(state, ref)),
	};
}

/** One registry Ref.get per read; mutations become visible before disk flush. */
export const AccountDirectoryLive = (launchLogin: ClaudeConfigDir) =>
	Layer.effect(
		AccountDirectory,
		Effect.gen(function* () {
			const registry = yield* InstanceManagerStateTag;
			return makeAccountDirectory(
				Effect.map(Ref.get(registry), (state) =>
					accountsStateFromInstances(
						Array.from(HashMap.values(state.instances)).flatMap((instance) => {
							const driver = instance.driver ?? "opencode";
							return isKnownDriverKind(driver)
								? [
										{
											...instance,
											driver,
											...(driver === "opencode" &&
											instance.id !== "opencode" &&
											instance.managed
												? { url: `http://localhost:${instance.port}` }
												: {}),
										},
									]
								: [];
						}),
						launchLogin,
					),
				),
			);
		}),
	);

export const AccountDirectoryFromConfigLive = (
	configDir: string,
	launchLogin: ClaudeConfigDir,
) =>
	Layer.effect(
		AccountDirectory,
		Effect.map(
			Effect.suspend(() => loadAccountsState(configDir, launchLogin)),
			(state) => makeAccountDirectory(Effect.succeed(state)),
		),
	);
