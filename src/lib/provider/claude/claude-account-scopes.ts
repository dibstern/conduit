import { Context, Effect, Layer, Option, type Scope } from "effect";
import { type AccountsState, defaultFor } from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import type { DaemonConfigLoadError } from "../../daemon/config-persistence.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import {
	type AccountResourceScopeOwner,
	AccountResourceScopesTag,
} from "../../domain/daemon/Services/account-resource-scopes.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import {
	type ClaudeCapabilitiesService,
	makeClaudeCapabilitiesService,
} from "./claude-capabilities-service.js";

type ClaudeAccount = Extract<Account, { driver: "claude" }>;

export class ClaudeAccountScopes extends Context.Service<
	ClaudeAccountScopes,
	{
		readonly defaultAccount: Effect.Effect<Account, ClaudeBoundaryError>;
		readonly use: <A, E, R>(
			account: Account,
			work: (resource: {
				readonly account: ClaudeAccount;
				readonly capabilities: ClaudeCapabilitiesService;
			}) => Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | ClaudeBoundaryError, R>;
	}
>()("ClaudeAccountScopes") {}

/** Account lifetime belongs to 9.9; only Claude's resources are constructed here. */
export const makeClaudeAccountScopes = (deps: {
	readonly accounts: Effect.Effect<AccountsState, DaemonConfigLoadError>;
	/** Legacy direct adapters have no authoritative directory to re-resolve. */
	readonly trustAdmission?: true;
	readonly cacheDir?: string;
	readonly capabilitiesService?: ClaudeCapabilitiesService;
	readonly openCapabilities?: (
		accountId: string,
	) => Effect.Effect<
		ClaudeCapabilitiesService,
		ClaudeBoundaryError,
		Scope.Scope
	>;
}) =>
	Effect.gen(function* () {
		const scopes = yield* AccountResourceScopesTag;
		const owner: AccountResourceScopeOwner<
			ClaudeCapabilitiesService,
			ClaudeBoundaryError
		> = yield* scopes.make(
			(id) =>
				deps.openCapabilities?.(id) ??
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					return yield* makeClaudeCapabilitiesService({
						...(deps.cacheDir !== undefined ? { cacheDir: deps.cacheDir } : {}),
						launchConfig: () => {
							throw new ClaudeBoundaryError({
								operation: "probeCapabilities",
								cause: "Claude account capabilities require an admitted call",
							});
						},
						forkRefresh: (effect) =>
							owner
								.use(id, () => effect)
								.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
					});
				}),
		);
		return ClaudeAccountScopes.of({
			defaultAccount: deps.accounts.pipe(
				Effect.flatMap((state) =>
					Option.match(defaultFor(state, "claude"), {
						onSome: Effect.succeed,
						onNone: () =>
							Effect.fail(
								new ClaudeBoundaryError({
									operation: "accountScope",
									cause: new Error("No Claude account"),
								}),
							),
					}),
				),
				Effect.mapError((cause) =>
					cause instanceof ClaudeBoundaryError
						? cause
						: new ClaudeBoundaryError({ operation: "accountScope", cause }),
				),
			),
			use: (admitted, work) =>
				owner.use(admitted.id, (capabilities) =>
					Effect.gen(function* () {
						if (!("folder" in admitted))
							return yield* new ClaudeBoundaryError({
								operation: "accountScope",
								cause: new Error("Claude requires a Claude account"),
							});
						const current = deps.trustAdmission
							? admitted
							: (yield* deps.accounts.pipe(
									Effect.mapError(
										(cause) =>
											new ClaudeBoundaryError({
												operation: "accountScope",
												cause,
											}),
									),
								)).accounts.find(
									(account) =>
										account.id === admitted.id && account.driver === "claude",
								);
						const { env: _env, ...identity } = admitted;
						const account = {
							...identity,
							...(current?.env !== undefined ? { env: current.env } : {}),
						};
						return yield* work({
							account,
							capabilities: deps.capabilitiesService ?? capabilities,
						});
					}),
				),
		});
	});

export const ClaudeAccountScopesLive = (configDir?: string) =>
	Layer.effect(
		ClaudeAccountScopes,
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			return yield* makeClaudeAccountScopes({
				accounts: directory.snapshot,
				...(configDir !== undefined
					? { cacheDir: `${configDir}/cache/claude-capabilities` }
					: {}),
			});
		}),
	);
