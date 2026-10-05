import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeSessionRunner,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeRunnerIdleExit } from "../../../../src/lib/provider/claude/claude-runner-idle.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionOutput,
} from "../../../../src/lib/provider/claude/claude-session-runner.js";
import type {
	PermissionResult,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";
import {
	createMockQuery,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

function roundTrip<T>(message: T): T {
	return JSON.parse(JSON.stringify(message));
}

const send = (
	turnId: string,
): Extract<ClaudeSessionCommand, { type: "send-turn" }> => ({
	type: "send-turn",
	sinkId: turnId,
	aborted: false,
	input: {
		sessionId: "session-1",
		turnId,
		prompt: turnId,
		history: [],
		providerState: {},
		workspaceRoot: "/tmp/ws",
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

describe("Claude runner idle exit", () => {
	it.each([
		"local_bash",
		"local_agent",
	])("stays alive for %s tasks and starts the idle window when they finish", (type) => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const idle = makeClaudeRunnerIdleExit(onIdle, 100);
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
		const idle = makeClaudeRunnerIdleExit(onIdle, 100);
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
	it("routes subagent persistence and background bookkeeping through JSON messages", async () => {
		const outputs: ClaudeSessionOutput[] = [];
		const onBackgroundTask = vi.fn();
		const ensureClaudeSubagentSession = vi.fn(() => Effect.void);
		const query = createMockQuery([
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
			queryFactory: () => query,
			capabilitiesService,
			subagentSdk: {
				listSubagents: async () => [],
				getSubagentMessages: async () => [],
			},
			materializeSubagents: true,
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
							if (message.type === "materialize-subagents") {
								expect(message.input.knownTasks).toEqual([
									[
										"agent-1",
										expect.objectContaining({
											toolUseId: "tool-1",
											description: "Audit auth",
										}),
									],
								]);
								return roundTrip({
									children: [
										{
											sdkSubagentId: "agent-1",
											childSessionId: "child-1",
											parentToolUseId: "tool-1",
										},
									],
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
												childSessionId: "child-1",
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
		const outputs: ClaudeSessionOutput[] = [];
		const prompts: string[] = [];
		const permissions: Array<PermissionResult | null> = [];
		const approval = await Effect.runPromise(
			Deferred.make<
				Extract<ClaudeSessionOutput, { type: "permission-request" }>
			>(),
		);
		const question = await Effect.runPromise(
			Deferred.make<
				Extract<ClaudeSessionOutput, { type: "question-request" }>
			>(),
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
							return;
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
						{ workspaceRoot: "/tmp/ws", queryFactory, capabilitiesService },
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
					const first = yield* Effect.fork(
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
						} satisfies ClaudeSessionCommand),
					);
					const questionRequest = yield* Deferred.await(question);
					yield* runner.executeEffect(
						roundTrip({
							type: "answer-question",
							sinkId: questionRequest.sinkId,
							requestId: questionRequest.request.requestId,
							answers: { "0": "Yes" },
						} satisfies ClaudeSessionCommand),
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

					const second = yield* Effect.fork(
						runner.executeEffect(roundTrip(send("turn-2"))),
					);
					yield* Deferred.await(secondTurn);
					yield* runner.executeEffect(
						roundTrip({
							type: "interrupt",
							sessionId: "session-1",
						} satisfies ClaudeSessionCommand),
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
						{ workspaceRoot: "/tmp/ws", queryFactory, capabilitiesService },
						(output) =>
							output.type === "release-sink"
								? Deferred.succeed(shutdown, undefined).pipe(Effect.as({}))
								: Effect.succeed({}),
					);
					const turn = yield* Effect.fork(runner.executeEffect(send("turn-1")));
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
