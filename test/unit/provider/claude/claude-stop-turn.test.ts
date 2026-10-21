import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeErrorResult,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

describe("turn-only Stop interactions", () => {
	it.each([
		"Bash",
		"AskUserQuestion",
	])("settles %s and its foreground tool while retaining the query", async (toolName) => {
		const requested = await Effect.runPromise(Deferred.make<void>());
		const query = createMockQuery([]);
		const sink = createMockEventSink();
		const push = vi.mocked(sink.push);
		const wait = () =>
			Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
		sink.requestPermission = wait;
		sink.requestQuestion = wait;
		sink.cancelSessionInteractions = vi.fn(() => Effect.void);
		const factory = vi.fn<
			NonNullable<Parameters<typeof makeClaudeSessionRunner>[0]["queryFactory"]>
		>(({ prompt, options }) => {
			const stream = (async function* (): AsyncGenerator<SDKMessage> {
				let turn = 0;
				for await (const _input of prompt) {
					if (++turn > 1) {
						yield makeSuccessResult();
						continue;
					}
					yield {
						type: "system",
						subtype: "background_tasks_changed",
						uuid: "00000000-0000-0000-0000-000000000021",
						session_id: "sdk-session-1",
						tasks: [
							{
								task_id: "monitor",
								task_type: "monitor_mcp",
								description: "Watch events",
								ambient: false,
							},
						],
					};
					yield {
						type: "stream_event",
						uuid: "00000000-0000-0000-0000-000000000022",
						session_id: "sdk-session-1",
						parent_tool_use_id: null,
						event: {
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: "foreground-tool",
								name: toolName,
								input: {},
							},
						},
					};
					yield {
						type: "stream_event",
						uuid: "00000000-0000-0000-0000-000000000023",
						session_id: "sdk-session-1",
						parent_tool_use_id: null,
						event: { type: "content_block_stop", index: 0 },
					};
					if (!options?.canUseTool || !options.abortController)
						throw new Error("Missing permission bridge");
					const response = await options.canUseTool(
						toolName,
						{ command: "pwd", questions: [{ question: "Continue?" }] },
						{
							signal: options.abortController.signal,
							toolUseID: "foreground-tool",
							requestId: "foreground-request",
						},
					);
					expect(response).toMatchObject({ behavior: "deny" });
					yield makeErrorResult({ errors: ["Execution ended"] });
				}
			})();
			return Object.assign(query, { [Symbol.asyncIterator]: () => stream });
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						workspaceRoot: "/tmp/ws",
						queryFactory: factory,
					});
					const input = makeBaseSendTurnInput({
						eventSink: sink,
						model: { providerId: "claude", modelId: "sonnet" },
					});
					const turn = yield* Effect.forkChild(runtime.sendTurnEffect(input));
					yield* Deferred.await(requested);
					yield* runtime.interruptTurnEffect(input.sessionId);
					expect((yield* Fiber.join(turn)).status).toBe("interrupted");
					expect(query.interrupt).toHaveBeenCalledOnce();
					expect(query.close).not.toHaveBeenCalled();
					expect(sink.cancelSessionInteractions).toHaveBeenCalledWith(
						"Turn interrupted",
						{ recoverQuestions: false },
					);
					expect(
						push.mock.calls
							.filter(([event]) => event.type === "tool.completed")
							.map(([event]) => event.data),
					).toContainEqual(
						expect.objectContaining({ partId: "foreground-tool" }),
					);
					expect(
						push.mock.calls.filter(([event]) => event.type === "turn.error"),
					).toEqual([]);
					expect(
						push.mock.calls.filter(
							([event]) => event.type === "turn.interrupted",
						),
					).toHaveLength(1);
					expect(
						(yield* runtime.sendTurnEffect({
							...input,
							inputId: "next-turn",
							prompt: "Continue",
						})).status,
					).toBe("completed");
					expect(factory).toHaveBeenCalledOnce();
				}),
			),
		);
	});

	// End closes the query while its interrupt is still unanswered.
	// The SDK rejects that interrupt on close; unobserved, it crashes the runner.
	it("closes the query without leaking the pending interrupt's rejection", async () => {
		const started = await Effect.runPromise(Deferred.make<void>());
		const query = createMockQuery([]);
		const rejectInterrupts: Array<(error: Error) => void> = [];
		let interrupted = false;
		// Not vi.fn: a spy observes returned promises, which would hide the leak.
		query.interrupt = () => {
			interrupted = true;
			return new Promise((_resolve, reject) => {
				rejectInterrupts.push(reject);
			});
		};
		vi.mocked(query.close).mockImplementation(() => {
			for (const reject of rejectInterrupts)
				reject(new Error("Query closed before response received"));
		});
		const factory = vi.fn<
			NonNullable<Parameters<typeof makeClaudeSessionRunner>[0]["queryFactory"]>
		>(({ prompt }) => {
			const stream = (async function* (): AsyncGenerator<SDKMessage> {
				for await (const _input of prompt) {
					await Effect.runPromise(Deferred.succeed(started, undefined));
					await new Promise(() => {});
				}
			})();
			return Object.assign(query, { [Symbol.asyncIterator]: () => stream });
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const runtime = yield* makeClaudeProviderRuntime({
							runnerFactory: makeClaudeSessionRunner,
							workspaceRoot: "/tmp/ws",
							queryFactory: factory,
						});
						const input = makeBaseSendTurnInput({
							eventSink: createMockEventSink(),
							model: { providerId: "claude", modelId: "sonnet" },
						});
						const turn = yield* Effect.forkChild(runtime.sendTurnEffect(input));
						yield* Deferred.await(started);
						const stopping = yield* Effect.forkChild(
							runtime
								.interruptTurnEffect(input.sessionId, [input.inputId])
								.pipe(Effect.result),
						);
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(interrupted).toBe(true)),
						);
						yield* runtime.endSessionEffect(input.sessionId);
						expect((yield* Effect.result(Fiber.join(turn)))._tag).toBe(
							"Failure",
						);
						expect((yield* Fiber.join(stopping))._tag).toBe("Failure");
						expect(interrupted).toBe(true);
						expect(query.close).toHaveBeenCalled();
					}),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
