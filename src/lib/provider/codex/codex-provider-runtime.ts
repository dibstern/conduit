import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	CanonicalEvents,
	SessionUsageLimitedPayloadSchema,
} from "../../contracts/stored-event.js";
import { Usage } from "../../domain/daemon/Services/usage.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { makeProcessSessionRunner } from "../runner/process-session-runner.js";
import { makeRunnerCommandRecovery } from "../runner/runner-command-recovery.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import { invalidateCodexAuth } from "./codex-discovery.js";
import { codexAccountHome } from "./codex-home.js";
import { makeCodexRunnerDriver } from "./codex-runner-driver.js";

const isUsageLimit = Schema.is(SessionUsageLimitedPayloadSchema);
const isTurnError = Schema.is(CanonicalEvents["turn.error"].payload);

export const makeCodexProviderRuntime = (deps: RunnerProviderInstanceDeps) =>
	Effect.gen(function* () {
		const read = yield* ReadQueryEffectTag;
		const state = yield* ProviderStateEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const persist = yield* ClaudeEventPersistEffectTag;
		const usage = Option.getOrUndefined(yield* Effect.serviceOption(Usage));
		return yield* makeRunnerProviderInstance(
			deps,
			makeCodexRunnerDriver(
				deps.workspaceRoot,
				{ read, state, sql },
				deps.daemonConfigDir,
			),
			(emit) =>
				makeProcessSessionRunner(
					deps,
					(output, sessionId) =>
						Effect.gen(function* () {
							if (
								output.type === "event" &&
								output.event.type === "turn.error" &&
								isTurnError(output.event.data) &&
								output.event.data.code === "auth_required"
							) {
								const failedSessionId = output.event.sessionId;
								yield* Effect.gen(function* () {
									const session = yield* read.getSession(failedSessionId);
									const accounts = yield* deps.accounts;
									const account = accounts.accounts.find(
										(candidate) =>
											candidate.driver === "codex" &&
											candidate.id === session?.provider,
									);
									if (account)
										invalidateCodexAuth(
											codexAccountHome(account, deps.daemonConfigDir),
										);
								}).pipe(
									Effect.catch((failure) =>
										Effect.logWarning(
											"Codex authentication cache could not be invalidated",
											failure,
										),
									),
								);
							}
							if (
								output.type === "event" &&
								output.event.type === "session.usage_limited" &&
								isUsageLimit(output.event.data) &&
								output.event.data.resetsAt === undefined
							) {
								const data = output.event.data;
								// A footer probe may have observed the reset while this turn was
								// running. Read it at failure, not from the turn's intake snapshot.
								const reading = yield* usage?.latest(data.instanceId) ??
									Effect.succeed(undefined);
								const modelId = output.event.metadata?.["modelId"];
								const limitId =
									reading?.windows.find(
										(window) => modelId && window.modelId === modelId,
									)?.limitId ?? data.rateLimitType;
								const resets =
									reading?.windows.flatMap((window) =>
										window.limitId === limitId &&
										window.utilization >= 100 &&
										window.resetsAt
											? [Date.parse(window.resetsAt) / 1000]
											: [],
									) ?? [];
								if (resets.length)
									return yield* emit(
										{
											...output,
											event: {
												...output.event,
												data: {
													...data,
													rateLimitType: limitId,
													resetsAt: Math.max(...resets),
												},
											},
										},
										sessionId,
									);
							}
							return yield* emit(output, sessionId);
						}),
					{
						driverKind: "codex",
						coldUpgrade: true,
						connect: connectRunner,
						settingsDeferredCode: "codex_settings_deferred",
						snapshotCommandSettings: () => ({}),
						warmCommand: (sessionId, _state, snapshot) => ({
							type: "pre-warm",
							sessionId,
							input: snapshot.input,
						}),
						sameAccountLogin: () => true,
						recoverCommands: makeRunnerCommandRecovery({
							driverKind: "codex",
							accounts: deps.accounts,
							state,
							providerStateKeys: ["codex.forkDigest"],
							onCompleted: (commandId, input, result) =>
								result.handoff
									? persist.persistHandoffDelivered(
											input.sessionId,
											{
												...result.handoff,
												instanceId: input.instanceId ?? "codex",
											},
											commandId,
											"codex",
										)
									: Effect.void,
						}),
					},
				),
		);
	});
