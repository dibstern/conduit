import { Effect, Result } from "effect";
import { resolve } from "../../account-directory.js";
import { ProviderStateEffectTag } from "../../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { connectRunner } from "../runner/runner-connection.js";
import { runnerFailure } from "../runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { recoverRunnerCommands } from "../runner/runner-recovery.js";
import type { SessionTurn } from "../runner/session-runner.js";
import { CursorAccountResources } from "./cursor-account-resources.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

export const makeCursorProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	Effect.gen(function* () {
		const read = yield* ReadQueryEffectTag;
		const state = yield* ProviderStateEffectTag;
		const resources = yield* Effect.serviceOption(CursorAccountResources);
		return yield* makeRunnerProviderInstance(
			deps,
			makeCursorRunnerDriver(
				deps.workspaceRoot,
				undefined,
				{ read, state },
				deps.daemonConfigDir,
				resources._tag === "Some" ? resources.value : undefined,
			),
			(emit) =>
				makeProcessSessionRunner(deps, emit, {
					driverKind: "cursor",
					...(resources._tag === "Some"
						? {
								withAccountScope: (
									accountId: string,
									work: Effect.Effect<void>,
								) =>
									Effect.gen(function* () {
										const accounts = yield* deps.accounts;
										if (
											!accounts.accounts.some(
												(account) =>
													account.id === accountId &&
													account.driver === "cursor",
											)
										)
											return yield* Effect.fail({
												operation: "retain account",
												message: `Cursor account "${accountId}" is unavailable`,
												code: "account_unavailable",
												retryable: false,
											});
										return yield* resources.value.use(accountId, () => work);
									}).pipe(
										Effect.mapError((cause) =>
											"operation" in cause
												? cause
												: runnerFailure("retain account", cause),
										),
									),
							}
						: {}),
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
						replayTurn,
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
								replay: (row, input) => {
									const sinkId = resolveSinkId(
										row.command_id,
										input.inputId,
										row.attempt_count,
										input.nativeResumeFallback,
									);
									return replayTurn(
										row.provider_id,
										input,
										sinkId,
										(dispatch) =>
											Effect.gen(function* () {
												const credential =
													resources._tag === "Some"
														? yield* resources.value
																.use(
																	row.provider_id,
																	({ credential }) => credential,
																)
																.pipe(
																	Effect.mapError((cause) =>
																		runnerFailure(
																			"recover Cursor credentials",
																			cause,
																		),
																	),
																)
														: undefined;
												if (resources._tag === "Some" && !credential)
													return yield* Effect.fail({
														operation: "recover Cursor credentials",
														message: "Cursor authentication required",
														code: "auth_required",
													});
												return yield* dispatch(
													connection.commandEffect(
														row.command_id,
														{
															type: "send-turn",
															sinkId,
															aborted: false,
															input,
															...(credential
																? {
																		cursorCredential: {
																			...credential,
																			apiKey: credential.apiKey,
																		},
																	}
																: {}),
														},
														row.attempt_count,
													),
												);
											}),
									);
								},
							});
						}),
				}),
		);
	});
