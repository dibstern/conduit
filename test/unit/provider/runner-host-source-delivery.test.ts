import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	type ClaudeAccount,
} from "../../../src/lib/contracts/account.js";
import {
	claudeLoginChange,
	configuredClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	type RunnerLaunch,
	type RunnerLaunchCallbacks,
	runSessionRunner,
} from "../../../src/lib/provider/runner/runner-host.js";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
	runnerBuildId,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { RunnerSpool } from "../../../src/lib/provider/runner/runner-spool.js";
import type {
	RunnerSourceDelivery,
	RunnerUpgradeState,
} from "../../../src/lib/provider/runner/runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionRunner,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

// The payload supplies output and a no-op Stop; the real host owns all wire state.
function makePayload(emit: Parameters<RunnerLaunch["makeRunner"]>[1]) {
	const result: TurnResult = {
		status: "completed",
		cost: 0,
		tokens: { input: 0, output: 0 },
		durationMs: 0,
		providerStateUpdates: [],
	};
	const interrupt =
		vi.fn<(command: Extract<SessionCommand, { type: "interrupt" }>) => void>();
	const admittedInputs: string[] = [];
	function executeEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, SessionFailure>;
	function executeEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, SessionFailure>;
	function executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
	function executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		if (command.type !== "send-turn") {
			if (command.type === "interrupt") interrupt(command);
			return Effect.succeed(undefined);
		}
		admittedInputs.push(command.input.inputId);
		return emit({
			type: "event",
			sinkId: command.sinkId,
			event: {
				eventId: "source-started",
				providerId: "claude",
				sessionId: command.input.sessionId,
				runId: "source-run",
				type: "run.started",
				providerRefs: {},
				rawSource: { kind: "claude.sdk" },
				createdAt: 0,
				data: { inputId: command.input.inputId, requestedRunId: "source-run" },
			},
		}).pipe(
			Effect.andThen(
				emit({
					type: "event",
					sinkId: command.sinkId,
					event: {
						eventId: "source-completed",
						providerId: "claude",
						sessionId: command.input.sessionId,
						runId: "source-run",
						type: "turn.completed",
						providerRefs: {},
						rawSource: { kind: "claude.sdk" },
						createdAt: 1,
						data: { messageId: "", userMessageId: command.input.inputId },
					},
				}),
			),
			Effect.as(result),
		);
	}
	const runner: SessionRunner = {
		hasLiveProcessEffect: () => Effect.succeed(true),
		executeEffect,
	};
	return { runner, result, interrupt, admittedInputs };
}

for (const { name, mode } of [
	{
		name: "retains the exact source-delivery token through a stale interrupt reply",
		mode: "stale-interrupt",
	},
	{
		name: "refuses a late fenced send before an acknowledged abort can be lost",
		mode: "late-abort",
	},
	{
		name: "admits a same-account send while source delivery is pending",
		mode: "same-account",
	},
	{
		name: "refuses a config-directory replacement during pending delivery",
		mode: "late-abort-config",
	},
]) {
	it(name, async () => {
		const directory = mkdtempSync(join(tmpdir(), "stale-host-"));
		const socketPath = join(directory, "r.sock");
		const sourceConfig = configuredClaudeConfigDir(
			join(directory, "account-a"),
		);
		const sourceAccount: ClaudeAccount = {
			driver: "claude",
			id: AccountIdSchema.make("account-a"),
			name: "Account A",
			folder: sourceConfig,
			usageEligible: true,
		};
		const sourceInput = {
			sessionId: "session-1",
			workspaceRoot: directory,
			extraFolders: [],
			providerState: {},
			account: sourceAccount,
			configDir: sourceConfig,
			folderSource: "account" as const,
		};
		const argvDescriptor = Object.getOwnPropertyDescriptor(process, "argv");
		const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Host fixture must never exit the test process");
		});
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("Host fixture must never signal a PID");
		});
		try {
			for (const key of Object.keys(process.env)) {
				if (
					key.startsWith("CONDUIT_TEST_RUNNER_") ||
					key === "CONDUIT_TEST_PROCESS_PROOF"
				)
					vi.stubEnv(key, undefined);
			}
			vi.stubEnv("NODE_ENV", "test");
			vi.stubEnv("CONDUIT_CONFIG_DIR", directory);
			vi.stubEnv("CONDUIT_TEST_RUNNER_IDLE_MS", "null");
			Object.defineProperty(process, "argv", {
				...argvDescriptor,
				value: [
					process.execPath,
					"runner-host",
					socketPath,
					"session-1",
					"runner-1",
				],
			});
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const listening = yield* Deferred.make<void>();
						const launched = yield* Deferred.make<RunnerLaunchCallbacks>();
						const payloadReady =
							yield* Deferred.make<ReturnType<typeof makePayload>>();
						const hello = yield* Deferred.make<void, SessionFailure>();
						const replayed = yield* Deferred.make<void>();
						const published = yield* Deferred.make<RunnerSourceDelivery>();
						const released = yield* Deferred.make<void>();
						const targetAccepted = yield* Deferred.make<void>();
						const clientClosed = yield* Deferred.make<void>();
						const serverDisconnected = yield* Deferred.make<void>();
						const disconnect = RunnerSpool.prototype.disconnect;
						const disconnected = vi
							.spyOn(RunnerSpool.prototype, "disconnect")
							.mockImplementation(function (this: RunnerSpool, peer) {
								disconnect.call(this, peer);
								Deferred.doneUnsafe(serverDisconnected, Effect.void);
							});
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => disconnected.mockRestore()),
						);
						const states: RunnerUpgradeState[] = [];
						let producerReleased = false;
						Object.defineProperty(process, "send", {
							configurable: true,
							writable: true,
							value: (
								message: Parameters<NonNullable<typeof process.send>>[0],
							) => {
								if (
									typeof message === "object" &&
									message !== null &&
									"channel" in message &&
									message.channel === "conduit-claude-runner" &&
									"type" in message &&
									message.type === "listening"
								)
									Deferred.doneUnsafe(listening, Effect.void);
								return true;
							},
						});
						const host = yield* Effect.forkChild(
							Effect.scoped(
								runSessionRunner("claude", (callbacks) =>
									Deferred.succeed(launched, callbacks).pipe(
										Effect.as({
											makeRunner: (_config, emit) => {
												const payload = makePayload(emit);
												Deferred.doneUnsafe(
													payloadReady,
													Effect.succeed(payload),
												);
												return Effect.succeed(payload.runner);
											},
											upgradeState: () => ({
												snapshot: { input: sourceInput, options: {} },
											}),
											changesAccount: (command) =>
												claudeLoginChange(
													{ ...sourceInput, root: directory },
													{
														...command.input,
														configDir: command.input.configDir ?? sourceConfig,
														root: command.input.workspaceRoot,
													},
												) === "Account",
											acceptCommand: () => {},
											executeEffect: (runner, command) =>
												runner.executeEffect(command),
										} satisfies RunnerLaunch),
									),
								),
							),
						);
						yield* Effect.addFinalizer(() => Fiber.interrupt(host));
						yield* Effect.raceFirst(
							Deferred.await(listening),
							Fiber.join(host),
						);
						const callbacks = yield* Deferred.await(launched);
						const socket = new Socket();
						let connected = false;
						socket.once("close", () =>
							Deferred.doneUnsafe(clientClosed, Effect.void),
						);
						const client = new RunnerSocket(
							socket,
							(message) => {
								if (
									message.type === "command-accepted" &&
									message.commandId === "target-command" &&
									message.sinkId === "target-sink"
								)
									Deferred.doneUnsafe(targetAccepted, Effect.void);
								if (message.type === "hello")
									Deferred.doneUnsafe(hello, Effect.void);
								if (message.type === "refused")
									Deferred.doneUnsafe(hello, Effect.fail(message.failure));
								if (message.type === "upgrade-state") {
									states.push(message.state);
									Deferred.doneUnsafe(replayed, Effect.void);
									if (message.state.sourceDelivery)
										Deferred.doneUnsafe(
											published,
											Effect.succeed(message.state.sourceDelivery),
										);
									else if (producerReleased)
										Deferred.doneUnsafe(released, Effect.void);
								}
								if (message.type === "output")
									client.write({
										type: "output-reply",
										outputId: message.outputId,
										sequence: message.sequence,
										result: {},
									});
							},
							(failure) => Deferred.doneUnsafe(hello, Effect.fail(failure)),
						);
						// Scope finalizers run in reverse order: close the client, then cancel host.
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => client.destroy()).pipe(
								Effect.andThen(Deferred.await(clientClosed)),
								Effect.andThen(() =>
									connected ? Deferred.await(serverDisconnected) : Effect.void,
								),
							),
						);
						yield* Effect.tryPromise(
							() =>
								new Promise<void>((done, fail) => {
									socket.once("error", fail);
									socket.connect(socketPath, done);
								}),
						);
						connected = true;
						client.write({
							type: "hello",
							driverKind: "claude",
							protocolVersion: RUNNER_PROTOCOL_VERSION,
							buildId: runnerBuildId(),
							config: { workspaceRoot: directory, daemonConfigDir: directory },
						});
						yield* Deferred.await(hello);
						const payload = yield* Deferred.await(payloadReady);
						client.write({ type: "replay", acknowledgedSequence: 0 });
						yield* Deferred.await(replayed);
						expect(
							yield* client.commandEffect("source-command", {
								type: "send-turn",
								sinkId: "source-sink",
								aborted: false,
								input: {
									...sourceInput,
									inputId: "source-input",
									runId: "source-run",
									prompt: "source",
									history: [],
								},
							}),
						).toEqual(payload.result);
						const finish = callbacks.sourceDelivery?.({
							sessionId: "session-1",
							inputId: "source-input",
							runId: "source-run",
						});
						if (!finish)
							throw new Error("Completed source send has no delivery owner");
						yield* Effect.gen(function* () {
							const token = yield* Deferred.await(published);
							expect(states.at(-1)?.quiescent).toBe(true);
							expect(token).toEqual({
								sessionId: "session-1",
								runnerId: "runner-1",
								commandId: "source-command",
								sinkId: "source-sink",
								inputId: "source-input",
								runId: "source-run",
								generation: 1,
							});
							if (mode === "stale-interrupt") {
								const beforeStop = states.length;
								const stop: Extract<SessionCommand, { type: "interrupt" }> = {
									type: "interrupt",
									sessionId: "session-1",
									turnIds: ["obsolete-input"],
								};
								expect(
									yield* client.commandEffect("stale-stop", stop),
								).toBeUndefined();
								expect(payload.interrupt).toHaveBeenCalledExactlyOnceWith(stop);
								const throughReply = states.slice(beforeStop);
								expect(throughReply.length).toBeGreaterThan(0);
								for (const state of throughReply)
									expect(state.sourceDelivery).toEqual(token);
							} else if (mode === "same-account") {
								expect(
									yield* client.commandEffect("same-account-command", {
										type: "send-turn",
										sinkId: "same-account-sink",
										aborted: false,
										input: {
											...sourceInput,
											inputId: "same-account-input",
											runId: "same-account-run",
											prompt: "same account",
											history: [],
										},
									}),
								).toEqual(payload.result);
								expect(payload.admittedInputs).toEqual([
									"source-input",
									"same-account-input",
								]);
								expect(states.at(-1)?.sourceDelivery).toEqual(token);
							} else {
								const targetConfig = configuredClaudeConfigDir(
									join(directory, "replacement-account"),
								);
								const beforeAbort = states.length;
								const target = yield* Effect.forkChild(
									client.commandEffect("target-command", {
										type: "send-turn",
										sinkId: "target-sink",
										aborted: false,
										input: {
											...sourceInput,
											account: {
												...sourceAccount,
												id:
													mode === "late-abort-config"
														? sourceAccount.id
														: AccountIdSchema.make("account-b"),
												folder: targetConfig,
											},
											configDir: targetConfig,
											inputId: "target-input",
											runId: "target-run",
											prompt: "target",
											history: [],
										},
									}),
								);
								yield* Deferred.await(targetAccepted);
								expect(
									yield* client.commandEffect("target-abort", {
										type: "abort",
										sinkId: "target-sink",
									}),
								).toBeUndefined();
								const throughReply = states.slice(beforeAbort);
								expect(throughReply.length).toBeGreaterThan(0);
								for (const state of throughReply)
									expect(state.sourceDelivery).toEqual(token);
								expect(payload.admittedInputs).toEqual(["source-input"]);
								const targetExit = target.pollUnsafe();
								if (!targetExit || !Exit.isFailure(targetExit))
									throw new Error(
										JSON.stringify({
											accepted: "target-command",
											reply: "target-abort",
											pending: targetExit === undefined,
											exit: targetExit?._tag,
											admitted: payload.admittedInputs,
										}),
									);
								expect(targetExit.cause.reasons).toHaveLength(1);
								for (const reason of targetExit.cause.reasons) {
									expect(Cause.isFailReason(reason)).toBe(true);
									if (Cause.isFailReason(reason))
										expect(reason.error).toMatchObject({
											operation: "send-turn",
											code: "account_switch_busy",
											retryable: true,
										});
								}
							}
							const beforeFinish = states.length;
							producerReleased = true;
							finish();
							yield* Deferred.await(released);
							const finishingStates = states
								.slice(beforeFinish)
								.map((state) => state.sourceDelivery);
							if (mode === "same-account") {
								for (const state of finishingStates.slice(0, -1))
									expect(state).toEqual(token);
								expect(finishingStates.at(-1)).toBeUndefined();
							} else expect(finishingStates).toEqual([undefined]);
							if (mode === "late-abort" || mode === "late-abort-config")
								expect(payload.admittedInputs).toEqual(["source-input"]);
						}).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									producerReleased = true;
									finish();
								}).pipe(Effect.andThen(Deferred.await(released))),
							),
						);
					}),
				),
			);
			expect(exit).not.toHaveBeenCalled();
			expect(kill).not.toHaveBeenCalled();
		} finally {
			if (argvDescriptor)
				Object.defineProperty(process, "argv", argvDescriptor);
			else Reflect.deleteProperty(process, "argv");
			if (sendDescriptor)
				Object.defineProperty(process, "send", sendDescriptor);
			else Reflect.deleteProperty(process, "send");
			vi.unstubAllEnvs();
			exit.mockRestore();
			kill.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
