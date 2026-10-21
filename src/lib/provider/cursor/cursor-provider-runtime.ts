import { Effect, Result, type Scope } from "effect";
import { resolve } from "../../account-directory.js";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../persistence/effect/read-query-effect.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { recoverRunnerCommands } from "../runner/runner-recovery.js";
import type { SessionTurn } from "../runner/session-runner.js";
import { CursorAccountResources } from "./cursor-account-resources.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

export function makeCursorProviderRuntime(
	deps: RunnerProviderInstanceDeps,
	persistence: {
		readonly read: ReadQueryEffect;
		readonly state: Omit<ProviderStateEffect, "projectId">;
	},
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> {
	return Effect.gen(function* () {
		const { read, state } = persistence;
		const resources = yield* Effect.serviceOption(CursorAccountResources);
		return yield* makeRunnerProviderInstance(
			deps,
			makeCursorRunnerDriver(
				undefined,
				{ read, state },
				deps.daemonConfigDir,
				resources._tag === "Some" ? resources.value : undefined,
			),
			(emit) =>
				makeProcessSessionRunner(
					{
						...deps,
						projectRootForSession:
							deps.projectRootForSession ?? (() => Effect.succeed(undefined)),
					},
					emit,
					{
						driverKind: "cursor",
						coldUpgrade: true,
						connect: connectRunner,
						settingsDeferredCode: "cursor_settings_deferred",
						snapshotCommandSettings: () => ({}),
						warmCommand: (sessionId, _state, snapshot) => ({
							type: "pre-warm",
							sessionId,
							input: snapshot.input,
						}),
						sameAccountLogin: () => true,
						recoverCommands: (
							sql,
							sessionId,
							connection,
							failTurn,
							closing,
							_liveSession,
							resolveSinkId,
						) =>
							Effect.gen(function* () {
								const accounts = yield* deps.accounts;
								// The outbox was admitted before first-turn preparation saved
								// the digest. Recovery must restore that snapshot as well.
								const digest = (yield* state.getState(sessionId))[
									"cursor.forkDigest"
								];
								return yield* recoverRunnerCommands(sql, sessionId, "cursor", {
									driverForAccount: (id) =>
										Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))
											?.driver,
									decodeInput: (row) => {
										const input = JSON.parse(row.payload_json) as SessionTurn;
										return {
											...input,
											commandAttempt: row.attempt_count,
											providerState: {
												...input.providerState,
												...(digest !== undefined &&
												typeof input.providerState["cursor.forkDigest"] !==
													"string"
													? { "cursor.forkDigest": digest }
													: {}),
											},
										};
									},
									resolveSinkId,
									closing,
									failTurn,
									replay: (row, input) =>
										connection.commandEffect(
											row.command_id,
											{
												type: "send-turn",
												sinkId: resolveSinkId(
													row.command_id,
													input.inputId,
													row.attempt_count,
													input.nativeResumeFallback,
												),
												aborted: false,
												input,
											},
											row.attempt_count,
										),
								});
							}),
					},
				),
		);
	});
}
