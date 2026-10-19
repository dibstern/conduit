import { Effect, Result } from "effect";
import { resolve } from "../../account-directory.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { recoverRunnerCommands } from "../runner/runner-recovery.js";
import type { SessionTurn } from "../runner/session-runner.js";
import { makeCursorRunnerDriver } from "./cursor-runner-driver.js";

export const makeCursorProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	makeRunnerProviderInstance(
		deps,
		makeCursorRunnerDriver(deps.workspaceRoot),
		(emit) =>
			makeProcessSessionRunner(deps, emit, {
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
						return yield* recoverRunnerCommands(sql, sessionId, "cursor", {
							driverForAccount: (id) =>
								Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))
									?.driver,
							decodeInput: (row) => ({
								...(JSON.parse(row.payload_json) as SessionTurn),
								commandAttempt: row.attempt_count,
							}),
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
			}),
	);
