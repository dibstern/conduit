import { Effect, type Scope } from "effect";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../persistence/effect/read-query-effect.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { makeRunnerCommandRecovery } from "../runner/runner-command-recovery.js";
import { connectRunner } from "../runner/runner-connection.js";
import { runnerFailure } from "../runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { CursorAccountResources } from "./cursor-account-resources.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";
import { cursorRunnerWire } from "./cursor-runner-wire.js";

export function makeCursorProviderRuntime(
	deps: RunnerProviderInstanceDeps,
	persistence: {
		readonly read: ReadQueryEffect;
		readonly state: Omit<ProviderStateEffect, "projectId">;
	},
): Effect.Effect<
	RunnerProviderInstance,
	never,
	Scope.Scope | CursorAccountResources
> {
	return Effect.gen(function* () {
		const { read, state } = persistence;
		const resources = yield* CursorAccountResources;
		const driver = makeCursorRunnerDriver(
			resources,
			{ read, state },
			deps.daemonConfigDir,
		);
		return yield* makeRunnerProviderInstance(deps, driver, (emit) =>
			makeProcessSessionRunner(
				{
					...deps,
					projectRootForSession:
						deps.projectRootForSession ?? (() => Effect.succeed(undefined)),
				},
				emit,
				{
					driverKind: "cursor",
					admitsRecoveredSends: true,
					withAccountScope: (accountId: string, work: Effect.Effect<void>) =>
						Effect.gen(function* () {
							const accounts = yield* deps.accounts;
							if (
								!accounts.accounts.some(
									(account) =>
										account.id === accountId && account.driver === "cursor",
								)
							)
								return yield* Effect.fail({
									operation: "retain account",
									message: `Cursor account "${accountId}" is unavailable`,
									code: "account_unavailable",
									retryable: false,
								});
							return yield* resources.use(accountId, () => work);
						}).pipe(
							Effect.mapError((cause) =>
								"operation" in cause
									? cause
									: runnerFailure("retain account", cause),
							),
						),
					coldUpgrade: true,
					spawnEnvironment: { CURSOR_BACKEND_URL: resources.backendUrl },
					connect: (options) =>
						connectRunner({
							...options,
							cursorBackendUrl: resources.backendUrl,
							wire: cursorRunnerWire,
						}),
					settingsDeferredCode: "cursor_settings_deferred",
					snapshotCommandSettings: () => ({}),
					warmCommand: (sessionId, _state, snapshot) => ({
						type: "pre-warm",
						sessionId,
						input: snapshot.input,
					}),
					loginChange: () => "None",
					recoverCommands: makeRunnerCommandRecovery({
						driverKind: "cursor",
						accounts: deps.accounts,
						...(deps.autoSettleAfterDays
							? { autoSettleAfterDays: deps.autoSettleAfterDays }
							: {}),
						prepareTurnEffect: driver.prepareTurnEffect,
					}),
				},
			),
		);
	});
}
