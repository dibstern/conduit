import { it as effectIt } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";
import { accountsStateFromInstances } from "../../../../src/lib/account-directory.js";
import { AccountUnroutable } from "../../../../src/lib/contracts/limit-recovery.js";
import { getConfigDir } from "../../../../src/lib/daemon/config-persistence.js";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeSessionRunner,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { claudeLaunchConfigFromAccounts } from "../../../../src/lib/provider/claude/claude-runner-wire.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { claudeSubagentSessionId } from "../../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	PermissionResult,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";
import { makeRunnerIdleExit } from "../../../../src/lib/provider/runner/runner-idle.js";
import type {
	SessionCommand,
	SessionOutput,
} from "../../../../src/lib/provider/runner/session-runner.js";
import { provisionalRejectedLimit } from "../../../fixtures/claude-sdk-traces/provisional-usage-limit-turn.js";
import {
	createMockQuery,
	makeErrorResult,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

function roundTrip<T>(message: T): T {
	return JSON.parse(JSON.stringify(message));
}

const send = (
	inputId: string,
): Extract<SessionCommand, { type: "send-turn" }> => ({
	type: "send-turn",
	sinkId: inputId,
	aborted: false,
	input: {
		sessionId: "session-1",
		inputId,
		prompt: inputId,
		history: [],
		providerState: {},
		workspaceRoot: "/tmp/ws",
		configDir: configuredClaudeConfigDir("/tmp/claude-account"),
		folderSource: "account",
		extraFolders: [],
		model: { providerId: "claude", modelId: "sonnet" },
	},
});

const capabilitiesService = {
	get: () =>
		Effect.fail(
			new ClaudeBoundaryError({
				operation: "probeCapabilities",
				cause: new Error("No live SDK in runner tests"),
			}),
		),
};

it("rejects an account snapshot without a routable Claude default", () => {
	const accounts = accountsStateFromInstances(
		[],
		configuredClaudeConfigDir("/tmp/claude-launch-login"),
	);
	expect(() => claudeLaunchConfigFromAccounts(accounts)).toThrow(
		AccountUnroutable,
	);
});

describe("Claude runner idle exit", () => {
	it("excludes only the current send from rebind quiescence", () => {
		let heldWork = false;
		const idle = makeRunnerIdleExit(
			vi.fn(),
			null,
			undefined,
			null,
			() => heldWork,
		);
		try {
			idle.beginTurn();
			expect(idle.quiescent).toBe(false);
			expect(idle.isQuiescent(1)).toBe(true);
			idle.beginTurn();
			expect(idle.isQuiescent(1)).toBe(false);
			idle.endTurn();
			idle.setTurnInFlight(true);
			expect(idle.isQuiescent(1)).toBe(false);
			idle.setTurnInFlight(false);
			idle.activity({
				type: "background-task",
				transition: {
					sessionId: "session-1",
					kind: "snapshot",
					tasks: [{ id: "task-1", type: "local_bash", description: "Task" }],
				},
			});
			expect(idle.isQuiescent(1)).toBe(false);
			idle.activity({
				type: "background-task",
				transition: { sessionId: "session-1", kind: "snapshot", tasks: [] },
			});
			heldWork = true;
			expect(idle.isQuiescent(1)).toBe(false);
			heldWork = false;
			expect(idle.isQuiescent(1)).toBe(true);
			idle.endTurn();
			expect(idle.quiescent).toBe(true);
		} finally {
			idle.close();
		}
	});

	it("keeps its admitted policy until the next turn receives a new memory snapshot", () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const idle = makeRunnerIdleExit(onIdle, undefined, 100, null);
		try {
			idle.beginTurn(null);
			vi.advanceTimersByTime(300);
			idle.endTurn();
			vi.advanceTimersByTime(300);
			expect(onIdle).not.toHaveBeenCalled();
			idle.beginTurn(1);
			idle.endTurn();
			vi.advanceTimersByTime(100);
			expect(onIdle).toHaveBeenCalledOnce();
		} finally {
			idle.close();
			vi.useRealTimers();
		}
	});

	it.each([
		"local_bash",
		"local_agent",
	])("stays alive for %s tasks and starts the idle window when they finish", (type) => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const idle = makeRunnerIdleExit(onIdle, 100);
		try {
			idle.activity({
				type: "background-task",
				transition: {
					sessionId: "session-1",
					kind: "snapshot",
					tasks: [{ id: "task-1", type, description: "Task" }],
				},
			});
			vi.advanceTimersByTime(300);
			expect(onIdle).not.toHaveBeenCalled();
			expect(idle.quiescent).toBe(false);
			idle.activity({
				type: "background-task",
				transition: { sessionId: "session-1", kind: "snapshot", tasks: [] },
			});
			expect(idle.quiescent).toBe(true);
			vi.advanceTimersByTime(99);
			expect(onIdle).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(onIdle).toHaveBeenCalledOnce();
		} finally {
			idle.close();
			vi.useRealTimers();
		}
	});

	it("does not extend the idle window for empty snapshots", () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const idle = makeRunnerIdleExit(onIdle, 100);
		try {
			vi.advanceTimersByTime(99);
			idle.activity({
				type: "background-task",
				transition: { sessionId: "session-1", kind: "snapshot", tasks: [] },
			});
			vi.advanceTimersByTime(1);
			expect(onIdle).toHaveBeenCalledOnce();
		} finally {
			idle.close();
			vi.useRealTimers();
		}
	});
});

describe("in-process Claude session runner", () => {
	it("delivers a deferred same-account settings change on the live query and rebinds when quiet", async () => {
		let backgroundBusy = false;
		const launches: Array<{
			configDir: ReturnType<typeof configuredClaudeConfigDir>;
			prompts: string[];
		}> = [];
		const queryFactory: NonNullable<
			ClaudeProviderInstanceDeps["queryFactory"]
		> = ({ prompt, configDir }) => {
			const launch: (typeof launches)[number] = { configDir, prompts: [] };
			launches.push(launch);
			const stream = (async function* () {
				for await (const message of prompt) {
					const content = message.message.content;
					launch.prompts.push(
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join(""),
					);
					yield makeSuccessResult();
				}
			})();
			return Object.assign(createMockQuery([]), {
				[Symbol.asyncIterator]: () => stream,
			});
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							daemonConfigDir: getConfigDir(),
							queryFactory,
							capabilitiesService,
							isBackgroundBusy: () => backgroundBusy,
						},
						() => Effect.succeed({}),
					);
					if (!runner.getNativeSessionEffect)
						throw new Error("Missing native session lookup");
					const first = send("turn-1");
					yield* runner.executeEffect({
						...first,
						input: { ...first.input, shellConfig: { interactive: false } },
					});
					const deferred = send("turn-2");
					const configDir = deferred.input.configDir;
					const input = {
						...deferred.input,
						shellConfig: { interactive: true },
					};
					backgroundBusy = true;
					expect(
						(yield* runner.executeEffect({ ...deferred, input })).status,
					).toBe("completed");
					expect(launches).toEqual([
						{
							configDir: send("turn-1").input.configDir,
							prompts: ["turn-1", "turn-2"],
						},
					]);
					expect(
						yield* runner.getNativeSessionEffect("session-1"),
					).toMatchObject({
						configDir: send("turn-1").input.configDir,
						instanceId: "claude",
					});
					backgroundBusy = false;
					expect(
						(yield* runner.executeEffect({
							...send("turn-3"),
							input: { ...input, inputId: "turn-3", prompt: "turn-3" },
						})).status,
					).toBe("completed");
					expect(launches).toHaveLength(2);
					expect(launches[1]).toEqual({ configDir, prompts: ["turn-3"] });
				}),
			),
		);
	});

	it("refuses a busy account switch before prompt admission and rebinds on quiet retry", async () => {
		let backgroundBusy = false;
		const launches: Array<{
			configDir: ReturnType<typeof configuredClaudeConfigDir>;
			prompts: string[];
		}> = [];
		const queryFactory: NonNullable<
			ClaudeProviderInstanceDeps["queryFactory"]
		> = ({ prompt, configDir }) => {
			const launch: (typeof launches)[number] = { configDir, prompts: [] };
			launches.push(launch);
			const stream = (async function* () {
				for await (const message of prompt) {
					const content = message.message.content;
					launch.prompts.push(
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join(""),
					);
					yield makeSuccessResult();
				}
			})();
			return Object.assign(createMockQuery([]), {
				[Symbol.asyncIterator]: () => stream,
			});
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							daemonConfigDir: getConfigDir(),
							queryFactory,
							capabilitiesService,
							isBackgroundBusy: () => backgroundBusy,
						},
						() => Effect.succeed({}),
					);
					const source = send("account-a");
					expect((yield* runner.executeEffect(source)).status).toBe(
						"completed",
					);
					const next = send("account-b");
					const target = {
						...next,
						input: {
							...next.input,
							instanceId: "account-b",
							configDir: configuredClaudeConfigDir("/tmp/claude-account-b"),
						},
					};
					backgroundBusy = true;
					const busyExit = yield* Effect.exit(runner.executeEffect(target));
					expect(launches).toEqual([
						{ configDir: source.input.configDir, prompts: ["account-a"] },
					]);
					expect(Exit.isFailure(busyExit)).toBe(true);
					if (Exit.isFailure(busyExit)) {
						expect(busyExit.cause.reasons).toHaveLength(1);
						expect(
							busyExit.cause.reasons
								.filter(Cause.isFailReason)
								.map((reason) => reason.error.retryable),
						).toEqual([true]);
					}
					backgroundBusy = false;
					expect((yield* runner.executeEffect(target)).status).toBe(
						"completed",
					);
					expect(launches).toEqual([
						{ configDir: source.input.configDir, prompts: ["account-a"] },
						{ configDir: target.input.configDir, prompts: ["account-b"] },
					]);
				}),
			),
		);
	});

	it("routes subagent persistence and background bookkeeping through JSON messages", async () => {
		const outputs: SessionOutput[] = [];
		const onBackgroundTask = vi.fn();
		const ensureClaudeSubagentSession = vi.fn(() => Effect.void);
		const childSessionId = claudeSubagentSessionId({
			parentConduitSessionId: "session-1",
			parentClaudeSessionId: "sdk-parent",
			sdkSubagentId: "agent-1",
		});
		const query = createMockQuery([
			{
				type: "stream_event",
				session_id: "sdk-parent",
				uuid: "00000000-0000-0000-0000-000000000499",
				parent_tool_use_id: null,
				event: {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "tool-1",
						name: "Agent",
						input: {},
						caller: { type: "direct" },
					},
				},
			},
			{
				type: "system",
				subtype: "task_started",
				session_id: "sdk-parent",
				uuid: "00000000-0000-0000-0000-000000000500",
				task_id: "agent-1",
				tool_use_id: "tool-1",
				description: "Audit auth",
				task_type: "explore",
			},
			{
				type: "system",
				subtype: "background_tasks_changed",
				session_id: "sdk-parent",
				uuid: "00000000-0000-0000-0000-000000000501",
				tasks: [
					{
						task_id: "background-1",
						task_type: "local_bash",
						description: "Watch tests",
					},
				],
			} as unknown as SDKMessage,
			makeSuccessResult({ session_id: "sdk-parent" }),
		]);
		const deps = {
			workspaceRoot: "/tmp/ws",
			daemonConfigDir: getConfigDir(),
			queryFactory: () => query,
			capabilitiesService,
			subagentSdk: {
				listSubagents: async () => [],
				getSubagentMessages: async () => [],
			},
			// Host callbacks must not be read, even if supplied as extra properties.
			onBackgroundTask,
			ensureClaudeSubagentSession,
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(deps, (output) =>
						Effect.sync(() => {
							const message = roundTrip(output);
							outputs.push(message);
							if (message.type === "ensure-subagent-session") {
								expect(message.input).toMatchObject({
									parentSessionId: "session-1",
									providerSessionId: "agent-1",
									title: "Audit auth",
								});
							}
							return {};
						}),
					);
					expect(
						(yield* runner.executeEffect(roundTrip(send("turn-1")))).status,
					).toBe("completed");
					yield* Effect.promise(() =>
						vi.waitFor(() => {
							expect(outputs).toContainEqual(
								expect.objectContaining({
									type: "event",
									event: expect.objectContaining({
										type: "tool.running",
										data: expect.objectContaining({
											metadata: expect.objectContaining({
												childSessionId,
											}),
										}),
									}),
								}),
							);
						}),
					);
					expect(outputs).toContainEqual({
						type: "background-task",
						transition: {
							sessionId: "session-1",
							kind: "snapshot",
							tasks: [
								{
									id: "background-1",
									type: "local_bash",
									description: "Watch tests",
									firstSeenAt: expect.any(Number),
								},
							],
						},
					});
					yield* runner.executeEffect({
						type: "end-session",
						sessionId: "session-1",
					});
					expect(outputs).toContainEqual({
						type: "background-task",
						transition: { sessionId: "session-1", kind: "session-ended" },
					});
					expect(onBackgroundTask).not.toHaveBeenCalled();
					expect(ensureClaudeSubagentSession).not.toHaveBeenCalled();
				}),
			),
		);
	});

	it("sends turns, answers an approval and interrupts using only messages", async () => {
		const outputs: SessionOutput[] = [];
		const prompts: string[] = [];
		const permissions: Array<PermissionResult | null> = [];
		const approval = await Effect.runPromise(
			Deferred.make<Extract<SessionOutput, { type: "permission-request" }>>(),
		);
		const question = await Effect.runPromise(
			Deferred.make<Extract<SessionOutput, { type: "question-request" }>>(),
		);
		const secondTurn = await Effect.runPromise(Deferred.make<void>());
		const stop = await Effect.runPromise(Deferred.make<void>());
		const queryFactory = vi.fn(
			({
				prompt,
				options,
			}: Parameters<
				NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
			>[0]) => {
				const canUseTool = options?.canUseTool;
				const signal = options?.abortController?.signal;
				if (!canUseTool || !signal)
					throw new Error("Missing SDK permission bridge");
				const stream = (async function* () {
					for await (const message of prompt) {
						const content = message.message.content;
						prompts.push(
							typeof content === "string"
								? content
								: content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join(""),
						);
						if (prompts.length === 1) {
							permissions.push(
								await canUseTool(
									"Bash",
									{ command: "pwd" },
									{
										signal,
										toolUseID: "tool-1",
										requestId: "sdk-request-1",
									},
								),
							);
							permissions.push(
								await canUseTool(
									"AskUserQuestion",
									{
										questions: [
											{
												question: "Continue?",
												header: "Next",
												options: [{ label: "Yes", description: "Continue" }],
											},
										],
									},
									{
										signal,
										toolUseID: "question-1",
										requestId: "sdk-question-1",
									},
								),
							);
							yield makeSuccessResult();
						} else {
							await Effect.runPromise(Deferred.succeed(secondTurn, undefined));
							await Effect.runPromise(Deferred.await(stop));
							yield makeErrorResult({ errors: ["Interrupted"] });
						}
					}
				})();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () => stream,
					interrupt: vi.fn(async () => {
						await Effect.runPromise(Deferred.succeed(stop, undefined));
					}),
				});
			},
		);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							daemonConfigDir: getConfigDir(),
							queryFactory,
							capabilitiesService,
						},
						(output) =>
							Effect.gen(function* () {
								const message = roundTrip(output);
								outputs.push(message);
								if (message.type === "permission-request") {
									yield* Deferred.succeed(approval, message);
								}
								if (message.type === "question-request") {
									yield* Deferred.succeed(question, message);
								}
								return {};
							}),
					);
					const first = yield* Effect.forkChild(
						runner.executeEffect(roundTrip(send("turn-1"))),
					);
					const request = yield* Deferred.await(approval);
					expect(request.request.toolName).toBe("Bash");
					yield* runner.executeEffect(
						roundTrip({
							type: "answer-permission",
							sinkId: request.sinkId,
							requestId: request.request.requestId,
							response: { decision: "once" },
						} satisfies SessionCommand),
					);
					const questionRequest = yield* Deferred.await(question);
					yield* runner.executeEffect(
						roundTrip({
							type: "answer-question",
							sinkId: questionRequest.sinkId,
							requestId: questionRequest.request.requestId,
							answers: { "0": "Yes" },
						} satisfies SessionCommand),
					);
					expect(roundTrip(yield* Fiber.join(first)).status).toBe("completed");
					expect(permissions[0]).toEqual({
						behavior: "allow",
						updatedInput: { command: "pwd" },
					});
					expect(permissions[1]).toMatchObject({
						behavior: "allow",
						updatedInput: { answers: { "Continue?": "Yes" } },
					});

					const second = yield* Effect.forkChild(
						runner.executeEffect(roundTrip(send("turn-2"))),
					);
					yield* Deferred.await(secondTurn);
					yield* runner.executeEffect(
						roundTrip({
							type: "interrupt",
							sessionId: "session-1",
						} satisfies SessionCommand),
					);
					expect(roundTrip(yield* Fiber.join(second)).status).toBe(
						"interrupted",
					);
					expect(prompts).toEqual(["turn-1", "turn-2"]);
					expect(queryFactory).toHaveBeenCalledTimes(1);
					expect(
						outputs
							.filter((output) => output.type === "event")
							.map((output) => output.event.type),
					).toContain("turn.interrupted");
				}),
			),
		);
	});

	it("finishes the active turn before shutdown-after-turn closes the query", async () => {
		const started = await Effect.runPromise(Deferred.make<void>());
		const finish = await Effect.runPromise(Deferred.make<void>());
		const shutdown = await Effect.runPromise(Deferred.make<void>());
		const closed = vi.fn();
		const queryFactory = vi.fn(
			({
				prompt,
			}: Parameters<
				NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>
			>[0]) => {
				const stream = (async function* () {
					for await (const _message of prompt) {
						await Effect.runPromise(Deferred.succeed(started, undefined));
						await Effect.runPromise(Deferred.await(finish));
						yield makeSuccessResult();
					}
				})();
				return Object.assign(createMockQuery([]), {
					[Symbol.asyncIterator]: () => stream,
					close: closed,
				});
			},
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							daemonConfigDir: getConfigDir(),
							queryFactory,
							capabilitiesService,
						},
						(output) =>
							output.type === "release-sink"
								? Deferred.succeed(shutdown, undefined).pipe(Effect.as({}))
								: Effect.succeed({}),
					);
					const turn = yield* Effect.forkChild(
						runner.executeEffect(send("turn-1")),
					);
					yield* Deferred.await(started);
					yield* runner.executeEffect({
						type: "shutdown-after-turn",
						sessionId: "session-1",
					});
					expect(closed).not.toHaveBeenCalled();
					yield* Deferred.succeed(finish, undefined);
					expect((yield* Fiber.join(turn)).status).toBe("completed");
					yield* Deferred.await(shutdown);
					expect(closed).toHaveBeenCalledTimes(1);
				}),
			),
		);
	});
});

effectIt.effect(
	"retains a late-notice producer while a stale Stop waits for message ownership",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const inputId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
				const runId = "source-run";
				const resultFinished = yield* Deferred.make<void>();
				const allowNotice = yield* Deferred.make<void>();
				const noticeHeld = yield* Deferred.make<SessionOutput>();
				const releaseNotice = yield* Deferred.make<void>();
				const noticeFinished = yield* Deferred.make<void>();
				const stopStarted = yield* Deferred.make<void>();
				const finishResult = vi.fn(() =>
					Deferred.doneUnsafe(resultFinished, Effect.void),
				);
				const finishNotice = vi.fn(() =>
					Deferred.doneUnsafe(noticeFinished, Effect.void),
				);
				let producers = 0;
				const onSourceDelivery = vi.fn<
					NonNullable<
						Parameters<typeof makeClaudeSessionRunner>[0]["onSourceDelivery"]
					>
				>(() => (++producers === 1 ? finishResult : finishNotice));
				const query = createMockQuery([]);
				const queryFactory: NonNullable<
					ClaudeProviderInstanceDeps["queryFactory"]
				> = ({ prompt }) => {
					const stream = (async function* (): AsyncGenerator<SDKMessage> {
						for await (const _message of prompt) {
							yield {
								type: "command_lifecycle",
								state: "started",
								command_uuid: inputId,
								uuid: inputId,
								session_id: "sdk-session-1",
							};
							yield makeSuccessResult({ user_message_uuid: inputId });
							await Effect.runPromise(Deferred.await(allowNotice));
							yield provisionalRejectedLimit("sdk-session-1");
						}
					})();
					return Object.assign(query, { [Symbol.asyncIterator]: () => stream });
				};
				const runner = yield* makeClaudeSessionRunner(
					{
						daemonConfigDir: getConfigDir(),
						queryFactory,
						capabilitiesService,
						onSourceDelivery,
					},
					(output) =>
						Effect.gen(function* () {
							if (
								output.type === "event" &&
								output.event.type === "session.usage_limited"
							) {
								yield* Deferred.succeed(noticeHeld, output);
								yield* Deferred.await(releaseNotice);
								return {};
							}
							return {};
						}),
				);
				yield* Effect.gen(function* () {
					const command = send(inputId);
					expect(
						(yield* runner.executeEffect({
							...command,
							input: { ...command.input, runId },
						})).status,
					).toBe("accepted");
					yield* Deferred.await(resultFinished);
					expect(finishResult).toHaveBeenCalledOnce();
					yield* Deferred.succeed(allowNotice, undefined);
					expect(yield* Deferred.await(noticeHeld)).toMatchObject({
						type: "event",
						sinkId: inputId,
						event: {
							type: "session.usage_limited",
							sessionId: "session-1",
							data: { cutOffMessageId: inputId },
						},
					});
					expect(onSourceDelivery.mock.calls).toEqual([
						[{ sessionId: "session-1", inputId, runId }],
						[{ sessionId: "session-1", inputId, runId }],
					]);
					expect(finishNotice).not.toHaveBeenCalled();
					const stopping = yield* Effect.forkChild(
						Deferred.succeed(stopStarted, undefined).pipe(
							Effect.andThen(
								runner.executeEffect({
									type: "interrupt",
									sessionId: "session-1",
									turnIds: ["obsolete-input"],
								}),
							),
						),
					);
					yield* Deferred.await(stopStarted);
					// Drain runnable effects without releasing the producer or advancing time.
					yield* TestClock.adjust("0 millis");
					expect(stopping.pollUnsafe()).toBeUndefined();
					expect(query.interrupt).not.toHaveBeenCalled();
					expect(query.close).not.toHaveBeenCalled();
					expect(finishNotice).not.toHaveBeenCalled();
					yield* Deferred.succeed(releaseNotice, undefined);
					yield* Fiber.join(stopping);
					yield* Deferred.await(noticeFinished);
					expect(finishNotice).toHaveBeenCalledOnce();
					expect(finishResult).toHaveBeenCalledOnce();
					expect(query.interrupt).not.toHaveBeenCalled();
					expect(query.close).not.toHaveBeenCalled();
				}).pipe(
					Effect.ensuring(
						Deferred.succeed(allowNotice, undefined).pipe(
							Effect.andThen(Deferred.succeed(releaseNotice, undefined)),
							Effect.asVoid,
						),
					),
				);
			}),
		),
);
