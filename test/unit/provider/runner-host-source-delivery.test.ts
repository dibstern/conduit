import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber, Scheduler } from "effect";
import { expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	type ClaudeAccount,
} from "../../../src/lib/contracts/account.js";
import {
	claudeLoginChange,
	configuredClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SendToken } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	type RunnerLaunch,
	type RunnerLaunchCallbacks,
	runSessionRunner,
} from "../../../src/lib/provider/runner/runner-host.js";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
	runnerBuildId,
	sendToken,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { runnerProcessTable } from "../../../src/lib/provider/runner/runner-registry.js";
import { readRunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import { RunnerSpool } from "../../../src/lib/provider/runner/runner-spool.js";
import type {
	RunnerSourceDelivery,
	RunnerUpgradeState,
} from "../../../src/lib/provider/runner/runner-upgrade.js";
import type {
	NativeSessionRunner,
	SessionCommand,
	SessionFailure,
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
	const runner: NativeSessionRunner = {
		hasLiveProcessEffect: () => Effect.succeed(true),
		executeEffect,
		executeNativeEffect: executeEffect,
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
	{
		name: "reserves only a quiescent runner and clears its reservation on command or hello",
		mode: "role-reservation",
	},
	{
		name: "activates a candidate on a command, not on hello or cancel",
		mode: "role-candidate",
	},
	{
		name: "35/45: remembers interrupted run ids while admitting a continuation with the same input id",
		mode: "interrupted-runs",
	},
	{
		name: "a session-wide interrupt does not fence later sends",
		mode: "legacy-interrupt",
	},
	{
		name: "refuses a retiring send before command acceptance",
		mode: "refusal-retiring",
	},
	{
		name: "refuses an exiting send before command acceptance",
		mode: "refusal-exiting",
	},
	{
		name: "hello waits for the preceding connection to drain to EOF",
		mode: "hello-drain",
	},
	{
		name: "a drained reconnect sees a received command before its execution fiber starts",
		mode: "status-before-execution",
	},
	{
		name: "fallback status distinguishes a finished primary from a never-received fallback",
		mode: "fallback-status",
	},
	{
		name: "stamps the host's query count on every frame and keeps it across a reconnect",
		mode: "query-seq",
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
		const inspect = vi
			.spyOn(runnerProcessTable, "inspect")
			.mockReturnValue({ state: "running", startTime: "host-fixture" });
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
					...(mode === "role-candidate" ? ["upgrade"] : []),
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
						let disconnectSignal = serverDisconnected;
						const disconnect = RunnerSpool.prototype.disconnect;
						const disconnected = vi
							.spyOn(RunnerSpool.prototype, "disconnect")
							.mockImplementation(function (this: RunnerSpool, peer) {
								disconnect.call(this, peer);
								Deferred.doneUnsafe(disconnectSignal, Effect.void);
							});
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => disconnected.mockRestore()),
						);
						const states: RunnerUpgradeState[] = [];
						const receivedFrames: import("../../../src/lib/provider/runner/runner-protocol.js").RunnerMessage[] =
							[];
						const wireFrames: import("../../../src/lib/provider/runner/runner-protocol.js").RunnerMessage[] =
							[];
						const rawRefusal =
							yield* Deferred.make<
								Extract<
									import("../../../src/lib/provider/runner/runner-protocol.js").RunnerMessage,
									{ type: "command-reply" }
								>
							>();
						let producerReleased = false;
						let pauseCommand = false;
						let resumeCommand: (() => void) | undefined;
						const scheduler = new Scheduler.MixedScheduler();
						const pausedScheduler: Scheduler.Scheduler = {
							executionMode: "async",
							shouldYield: (fiber) =>
								pauseCommand || scheduler.shouldYield(fiber),
							makeDispatcher: () => {
								const dispatcher = scheduler.makeDispatcher();
								if (!pauseCommand) return dispatcher;
								pauseCommand = false;
								const pending: Array<() => void> = [];
								let resumed = false;
								resumeCommand = () => {
									resumed = true;
									for (const task of pending.splice(0)) task();
								};
								return {
									scheduleTask: (task, priority) =>
										resumed
											? dispatcher.scheduleTask(task, priority)
											: pending.push(() =>
													dispatcher.scheduleTask(task, priority),
												),
									flush: () => dispatcher.flush(),
								};
							},
						};
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
											...(mode === "status-before-execution"
												? {
														wire: {
															decode: (message) => message,
															encode: (message) => {
																if (message.type === "command-accepted")
																	pauseCommand = true;
																return `${JSON.stringify(message)}\n`;
															},
														} satisfies import("../../../src/lib/provider/runner/runner-protocol.js").RunnerWireCodec,
													}
												: {}),
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
												mode === "status-before-execution"
													? Effect.succeed({
															status: "completed" as const,
															cost: 0,
															tokens: { input: 0, output: 0 },
															durationMs: 0,
															providerStateUpdates: [],
														})
													: mode === "fallback-status" &&
															command.type === "send-turn" &&
															!command.input.nativeResumeFallback
														? Effect.succeed({
																status: "error" as const,
																cost: 0,
																tokens: { input: 0, output: 0 },
																durationMs: 0,
																providerStateUpdates: [],
																nativeResumeRejected: true,
																error: {
																	code: "claude_resume_refused",
																	message: "rejected before native input",
																},
															})
														: runner.executeNativeEffect(command),
										} satisfies RunnerLaunch),
									),
								).pipe(
									Effect.provideService(Scheduler.Scheduler, pausedScheduler),
								),
							),
						);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => resumeCommand?.()).pipe(
								Effect.andThen(Fiber.interrupt(host)),
							),
						);
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
								receivedFrames.push(message);
								if (
									message.type === "command-reply" &&
									message.commandId === "covered-send"
								)
									Deferred.doneUnsafe(rawRefusal, Effect.succeed(message));
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
								if (message.type === "output" && !socket.writableEnded)
									client.write({
										type: "output-reply",
										outputId: message.outputId,
										sequence: message.sequence,
										result: {},
									});
							},
							(failure) => Deferred.doneUnsafe(hello, Effect.fail(failure)),
							undefined,
							{
								decode: (message) => {
									wireFrames.push(message);
									return message;
								},
								encode: (message) => `${JSON.stringify(message)}\n`,
							},
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
						if (mode === "fallback-status") {
							const primary: Extract<SessionCommand, { type: "send-turn" }> = {
								type: "send-turn",
								sinkId: "resume-sink",
								aborted: false,
								input: {
									...sourceInput,
									inputId: "resume-input",
									runId: "resume-run",
									prompt: "resume",
									history: [],
								},
							};
							// A fresh fallback is a new transmission with its own token (4.8).
							const resume = sendToken("hold", "resume", 1);
							const fallback = sendToken("hold", "resume", 2);
							yield* client.commandEffect(resume, primary);
							expect(yield* client.commandStatusEffect(resume)).toBe(
								"completed",
							);
							expect(yield* client.commandStatusEffect(fallback)).toBe(
								"not_received",
							);
							yield* client.commandEffect(fallback, {
								...primary,
								input: { ...primary.input, nativeResumeFallback: true },
							});
							expect(yield* client.commandStatusEffect(fallback)).toBe(
								"completed",
							);
							expect(yield* client.commandStatusEffect(resume)).toBe(
								"completed",
							);
							// The host records each transmission's mode from its frame, so a
							// later reader never takes it from the payload's marker (4.8).
							const read = (token: SendToken) =>
								readRunnerSendJournal({
									directory,
									sessionId: "session-1",
									driverKind: "claude",
									token,
									commandId: "resume",
								});
							expect(read(resume)).toMatchObject({ _tag: "Present" });
							expect(read(resume)).not.toHaveProperty("state.fresh");
							expect(read(fallback)).toMatchObject({
								_tag: "Present",
								state: { status: "finished", fresh: true },
							});
							expect(payload.admittedInputs).toEqual(["resume-input"]);
							return;
						}
						if (
							mode === "interrupted-runs" ||
							mode === "legacy-interrupt" ||
							mode === "refusal-retiring" ||
							mode === "refusal-exiting"
						) {
							if (mode === "refusal-retiring" || mode === "refusal-exiting") {
								callbacks.retireAfterCommand?.("finishing-input");
								if (mode === "refusal-exiting")
									callbacks.turnStateChanged(false);
							} else
								yield* client.commandEffect("stop-before-send", {
									type: "interrupt",
									sessionId: "session-1",
									...(mode === "interrupted-runs"
										? { runIds: ["covered-run"] }
										: {}),
								});
							const coveredSend: Extract<
								SessionCommand,
								{ type: "send-turn" }
							> = {
								type: "send-turn",
								sinkId: "covered-sink",
								aborted: false,
								input: {
									...sourceInput,
									inputId: "shared-cut-off",
									runId: "covered-run",
									prompt: "covered",
									history: [],
								},
							};
							const first = yield* Effect.result(
								mode === "refusal-exiting"
									? Effect.gen(function* () {
											// Bypass the daemon's pre-write idle guard to exercise the host wire branch.
											client.write({
												type: "command",
												commandId: "covered-send",
												command: coveredSend,
											});
											const reply = yield* Deferred.await(rawRefusal);
											return reply.failure
												? yield* Effect.fail(reply.failure)
												: reply.result;
										})
									: client.commandEffect("covered-send", coveredSend),
							);
							if (mode === "legacy-interrupt") {
								expect(first._tag).toBe("Success");
								expect(payload.admittedInputs).toEqual(["shared-cut-off"]);
							} else {
								expect(first._tag).toBe("Failure");
								const reason =
									mode === "refusal-retiring"
										? "retiring"
										: mode === "refusal-exiting"
											? "exiting"
											: "interrupted";
								if (first._tag === "Failure")
									expect(first.failure).toMatchObject({
										delivery: { _tag: "Refused", reason },
									});
								expect(
									wireFrames.filter(
										(frame) => frame.type === "command-refused",
									),
								).toEqual([
									{
										type: "command-refused",
										commandId: "covered-send",
										reason,
										querySeq: 0,
									},
								]);
								expect(payload.admittedInputs).toEqual([]);
								expect(
									receivedFrames.filter(
										(frame) =>
											frame.type === "command-accepted" &&
											frame.commandId === "covered-send",
									),
								).toEqual([]);
							}
							if (mode === "interrupted-runs") {
								expect(
									yield* client.commandEffect("uncovered-send", {
										type: "send-turn",
										sinkId: "uncovered-sink",
										aborted: false,
										input: {
											...sourceInput,
											inputId: "shared-cut-off",
											runId: "uncovered-run",
											prompt: "after Stop",
											history: [],
										},
									}),
								).toEqual(payload.result);
								expect(payload.admittedInputs).toEqual(["shared-cut-off"]);
							}
							return;
						}
						if (mode === "query-seq") {
							const send = (inputId: string) =>
								client.commandEffect(inputId, {
									type: "send-turn",
									sinkId: `${inputId}-sink`,
									aborted: false,
									input: {
										...sourceInput,
										inputId,
										runId: `${inputId}-run`,
										prompt: inputId,
										history: [],
									},
								});
							const stamps = () =>
								receivedFrames.splice(0).map((frame) => frame.querySeq);
							expect(
								receivedFrames.find((frame) => frame.type === "hello")
									?.querySeq,
							).toBe(0);
							yield* send("first-query");
							// The first query is no replacement: the hello and its frames read 0.
							callbacks.queryStarted({});
							yield* send("first-query-again");
							const first = stamps();
							expect(first.length).toBeGreaterThan(4);
							expect(new Set(first)).toEqual(new Set([0]));
							callbacks.queryStarted({});
							yield* send("replacement-query");
							// A late notice of the earlier send keeps the count it was emitted under.
							const replaced = receivedFrames
								.filter((frame) =>
									JSON.stringify(frame).includes("replacement-query"),
								)
								.map((frame) => frame.querySeq);
							expect(replaced.length).toBeGreaterThan(2);
							expect(new Set(replaced)).toEqual(new Set([1]));
							client.destroy();
							yield* Deferred.await(clientClosed);
							yield* Deferred.await(serverDisconnected);
							const rehello = yield* Deferred.make<
								number | undefined,
								SessionFailure
							>();
							const reconnectClosed = yield* Deferred.make<void>();
							const reconnectDisconnected = yield* Deferred.make<void>();
							disconnectSignal = reconnectDisconnected;
							const reconnectSocket = new Socket();
							reconnectSocket.once("close", () =>
								Deferred.doneUnsafe(reconnectClosed, Effect.void),
							);
							const reconnect = new RunnerSocket(
								reconnectSocket,
								(message) => {
									if (message.type === "hello")
										Deferred.doneUnsafe(
											rehello,
											Effect.succeed(message.querySeq),
										);
									if (message.type === "refused")
										Deferred.doneUnsafe(rehello, Effect.fail(message.failure));
								},
								(failure) => Deferred.doneUnsafe(rehello, Effect.fail(failure)),
							);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => reconnect.destroy()).pipe(
									Effect.andThen(Deferred.await(reconnectClosed)),
									Effect.andThen(Deferred.await(reconnectDisconnected)),
								),
							);
							yield* Effect.tryPromise(
								() =>
									new Promise<void>((done, fail) => {
										reconnectSocket.once("error", fail);
										reconnectSocket.connect(socketPath, done);
									}),
							);
							reconnect.write({
								type: "hello",
								driverKind: "claude",
								protocolVersion: RUNNER_PROTOCOL_VERSION,
								buildId: runnerBuildId(),
								config: {
									workspaceRoot: directory,
									daemonConfigDir: directory,
								},
							});
							// A surviving host keeps its count across a daemon reconnect (6.1).
							expect(yield* Deferred.await(rehello)).toBe(1);
							return;
						}
						if (mode === "hello-drain" || mode === "status-before-execution") {
							const nextSocket = new Socket();
							const nextClosed = yield* Deferred.make<void>();
							const nextDisconnected = yield* Deferred.make<void>();
							let nextConnected = false;
							nextSocket.once("close", () =>
								Deferred.doneUnsafe(nextClosed, Effect.void),
							);
							const nextHello =
								yield* Deferred.make<
									import("../../../src/lib/provider/runner/runner-protocol.js").RunnerHello
								>();
							const nextReply = yield* Deferred.make<void>();
							const lastOld = sendToken("tx", "last-old-command", 0);
							const next = new RunnerSocket(
								nextSocket,
								(message) => {
									if (message.type === "hello")
										Deferred.doneUnsafe(nextHello, Effect.succeed(message));
									if (
										message.type === "command-reply" &&
										message.commandId === lastOld
									)
										Deferred.doneUnsafe(nextReply, Effect.void);
								},
								() => {},
							);
							yield* Effect.addFinalizer(() =>
								Effect.gen(function* () {
									client.destroy();
									yield* Deferred.await(clientClosed);
									yield* Deferred.await(serverDisconnected);
									disconnectSignal = nextDisconnected;
									next.destroy();
									yield* Deferred.await(nextClosed);
									if (nextConnected) yield* Deferred.await(nextDisconnected);
								}),
							);
							yield* Effect.tryPromise(
								() =>
									new Promise<void>((resolve, reject) => {
										nextSocket.once("error", reject);
										nextSocket.connect(socketPath, resolve);
									}),
							);
							nextConnected = true;
							next.write({
								type: "hello",
								protocolVersion: RUNNER_PROTOCOL_VERSION,
								buildId: runnerBuildId(),
								config: {
									workspaceRoot: directory,
									daemonConfigDir: directory,
								},
							});
							// The old stream remains writable, so the new hello cannot answer absence yet.
							expect(yield* Deferred.isDone(nextHello)).toBe(false);
							client.write({
								type: "command",
								commandId: lastOld,
								command: {
									type: "send-turn",
									sinkId: "last-old-sink",
									aborted: false,
									input: {
										...sourceInput,
										inputId: "last-old-input",
										runId: "last-old-run",
										prompt: "last",
										history: [],
									},
								},
							});
							socket.end();
							const answered = yield* Deferred.await(nextHello);
							if (mode === "status-before-execution") {
								expect(resumeCommand).toBeDefined();
								expect(yield* next.commandStatusEffect(lastOld)).toBe(
									"running",
								);
								resumeCommand?.();
								yield* Deferred.await(nextReply);
								expect(yield* next.commandStatusEffect(lastOld)).toBe(
									"completed",
								);
								return;
							}
							expect(answered.sendTokens).toEqual([lastOld]);
							expect(payload.admittedInputs).toEqual(["last-old-input"]);
							return;
						}
						if (mode === "role-candidate") {
							expect(callbacks.isCandidate()).toBe(true);
							client.write({ type: "upgrade-cancel" });
							yield* client.commandStatusEffect("candidate-barrier");
							expect(callbacks.isCandidate()).toBe(true);
							// Any command but a shutdown or the swap's pre-warm means the
							// swap committed, so it activates the Candidate (CONTRACT 2507-2511).
							yield* client.commandEffect("activation-barrier", {
								type: "apply-live-settings",
								sessionId: "session-1",
								settings: {},
							});
							expect(callbacks.isCandidate()).toBe(false);
							return;
						}
						if (mode === "role-reservation") {
							callbacks.turnStateChanged(true);
							yield* Effect.tryPromise(() =>
								vi.waitFor(() =>
									expect(states.at(-1)?.turnInFlight).toBe(true),
								),
							);
							expect(
								yield* client.retireEffect(states.at(-1)?.revision ?? -1),
							).toBe(false);
							callbacks.turnStateChanged(false);
							yield* Effect.tryPromise(() =>
								vi.waitFor(() =>
									expect(states.at(-1)?.turnInFlight).toBe(false),
								),
							);
							expect(
								yield* client.retireEffect(states.at(-1)?.revision ?? -1),
							).toBe(true);
							yield* client.commandEffect("reservation-command", {
								type: "apply-live-settings",
								sessionId: "session-1",
								settings: {},
							});
							expect(states.at(-1)?.quiescent).toBe(true);
							expect(
								yield* client.retireEffect(states.at(-1)?.revision ?? -1),
							).toBe(true);
							client.destroy();
							yield* Deferred.await(clientClosed);
							yield* Deferred.await(serverDisconnected);
							const reconnected = yield* Deferred.make<
								RunnerUpgradeState,
								SessionFailure
							>();
							const reconnectClosed = yield* Deferred.make<void>();
							const reconnectDisconnected = yield* Deferred.make<void>();
							disconnectSignal = reconnectDisconnected;
							const reconnectSocket = new Socket();
							reconnectSocket.once("close", () =>
								Deferred.doneUnsafe(reconnectClosed, Effect.void),
							);
							const reconnect = new RunnerSocket(
								reconnectSocket,
								(message) => {
									if (message.type === "hello" && message.upgradeState)
										Deferred.doneUnsafe(
											reconnected,
											Effect.succeed(message.upgradeState),
										);
									if (message.type === "refused")
										Deferred.doneUnsafe(
											reconnected,
											Effect.fail(message.failure),
										);
								},
								(failure) =>
									Deferred.doneUnsafe(reconnected, Effect.fail(failure)),
							);
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => reconnect.destroy()).pipe(
									Effect.andThen(Deferred.await(reconnectClosed)),
									Effect.andThen(Deferred.await(reconnectDisconnected)),
								),
							);
							yield* Effect.tryPromise(
								() =>
									new Promise<void>((done, fail) => {
										reconnectSocket.once("error", fail);
										reconnectSocket.connect(socketPath, done);
									}),
							);
							reconnect.write({
								type: "hello",
								driverKind: "claude",
								protocolVersion: RUNNER_PROTOCOL_VERSION,
								buildId: runnerBuildId(),
								config: {
									workspaceRoot: directory,
									daemonConfigDir: directory,
								},
							});
							// Hello clears Reserved before replay is sent, including legacy replay flags.
							expect((yield* Deferred.await(reconnected)).quiescent).toBe(true);
							return;
						}
						const source = sendToken("tx", "source-command", 1);
						expect(
							yield* client.commandEffect(source, {
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
								token: source,
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
									runIds: ["obsolete-run"],
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
			inspect.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
