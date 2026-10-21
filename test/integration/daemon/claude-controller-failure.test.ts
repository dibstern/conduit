// A query-open failure must keep the controller for retry, while explicit End
// must forget it even when there is no live query left to dispose.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeClaudeSessionRunner } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../src/lib/provider/event-sink-errors.js";
import type {
	SessionCommand,
	SessionOutput,
} from "../../../src/lib/provider/runner/session-runner.js";
import { isRecord } from "../../../src/lib/utils.js";
import { createMockQuery, makeSuccessResult } from "../../helpers/mock-sdk.js";

it.each([
	{ end: false, failure: "open" },
	{ end: true, failure: "open" },
	{ end: false, failure: "resume" },
	{ end: true, failure: "resume" },
])("retains a controller after $failure failure, but resets it on explicit End $end", async ({
	end,
	failure,
}) => {
	const root = mkdtempSync(join(tmpdir(), "claude-controller-failure-"));
	const outputs: SessionOutput[] = [];
	let queries = 0;
	const send = (
		inputId: string,
		account: string,
	): Extract<SessionCommand, { type: "send-turn" }> => ({
		type: "send-turn",
		sinkId: inputId,
		aborted: false,
		input: {
			sessionId: "session",
			inputId,
			runId: inputId,
			prompt: inputId,
			workspaceRoot: root,
			extraFolders: [],
			history: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(join(root, account)),
			folderSource: "account",
			instanceId: account,
			model: { providerId: "claude", modelId: "sonnet" },
		},
	});
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							workspaceRoot: root,
							daemonConfigDir: join(root, "config"),
							readGoalStatus: async () => undefined,
							capabilitiesService: {
								get: () =>
									Effect.fail(
										new ClaudeBoundaryError({
											operation: "probe",
											cause: "No live SDK",
										}),
									),
							},
							queryFactory: ({ prompt }) => {
								if (++queries === 2) {
									if (failure === "open")
										throw new Error("Replacement query could not open");
									return Object.assign(createMockQuery([]), {
										next: async () => {
											throw new Error(
												"No conversation found with session ID: missing",
											);
										},
									});
								}
								const stream = (async function* (): AsyncGenerator<SDKMessage> {
									for await (const message of prompt) {
										yield {
											type: "command_lifecycle",
											state: "started",
											command_uuid: message.uuid ?? "input",
											uuid: "00000000-0000-4000-8000-000000000003",
											session_id: "native",
										};
										yield {
											type: "active_goal",
											uuid: "00000000-0000-4000-8000-000000000001",
											session_id: "native",
											value: {
												condition: "Keep facts",
												iterations: 0,
												set_at: 1234,
												tokens_at_start: 0,
											},
										};
										yield {
											type: "user",
											uuid: "00000000-0000-4000-8000-000000000002",
											session_id: "native",
											parent_tool_use_id: null,
											isSynthetic: true,
											message: {
												role: "user",
												content:
													"Stop hook feedback:\n[Keep facts]: Keep going",
											},
										};
										yield makeSuccessResult();
									}
								})();
								return Object.assign(createMockQuery([]), {
									[Symbol.asyncIterator]: () => stream,
								});
							},
						},
						(output) =>
							Effect.sync(() => {
								outputs.push(output);
								return {};
							}),
					);
					yield* runner.executeEffect(send("first", "a"));
					while (
						!outputs.some(
							(output) =>
								output.type === "event" &&
								output.event.type === "turn.completed",
						)
					)
						yield* Effect.sleep("10 millis");
					const failedTurn = send("failed", "b");
					const failed = yield* runner
						.executeEffect(
							failure === "open"
								? failedTurn
								: {
										...failedTurn,
										input: {
											...failedTurn.input,
											resumeSessionId: "missing",
											clearInheritedGoal: true,
										},
									},
						)
						.pipe(Effect.result);
					expect(failed._tag).toBe(failure === "open" ? "Failure" : "Success");
					if (failure === "open")
						expect(
							outputs.some(
								(output) =>
									output.type === "event" &&
									output.event.type === "session.goal_changed" &&
									isRecord(output.event.data) &&
									output.event.data["pausedReason"] ===
										"Replacement query could not open",
							),
						).toBe(true);
					if (failed._tag === "Success")
						expect(failed.success).toMatchObject({
							status: "error",
							nativeResumeRejected: true,
						});
					// Process runners wait for quiescence before another send. This
					// direct runner fixture lets the stream finalizer finish first.
					yield* Effect.sleep("20 millis");
					if (end)
						yield* runner.executeEffect({
							type: "end-session",
							sessionId: "session",
						});
					yield* runner.executeEffect(send("retry", "b"));
					while (
						outputs.filter(
							(output) =>
								output.type === "event" &&
								output.event.type === "turn.completed",
						).length < 2
					)
						yield* Effect.sleep("10 millis");
					const newGoals = outputs.filter(
						(output) =>
							output.type === "event" &&
							output.event.type === "session.goal_changed" &&
							isRecord(output.event.data) &&
							isRecord(output.event.data["goal"]) &&
							output.event.data["goal"]["iterations"] === 0,
					);
					expect(newGoals).toHaveLength(end ? 2 : 1);
					const latestGoal = outputs
						.filter(
							(output) =>
								output.type === "event" &&
								output.event.type === "session.goal_changed",
						)
						.at(-1);
					if (latestGoal?.type === "event")
						expect(latestGoal.event.data).not.toHaveProperty("pausedReason");
				}),
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([
	200,
	0,
	undefined,
])("uses the incoming token total %s for a new goal on rebind, falling back only when omitted", async (tokens) => {
	const root = mkdtempSync(join(tmpdir(), "claude-rebind-tokens-"));
	const outputs: SessionOutput[] = [];
	const goalInputId = randomUUID();
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runner = yield* makeClaudeSessionRunner(
						{
							workspaceRoot: root,
							daemonConfigDir: join(root, "config"),
							readGoalStatus: async () => undefined,
							capabilitiesService: {
								get: () =>
									Effect.fail(
										new ClaudeBoundaryError({
											operation: "probe",
											cause: "No live SDK",
										}),
									),
							},
							queryFactory: ({ prompt }) => {
								const stream = (async function* (): AsyncGenerator<SDKMessage> {
									for await (const message of prompt) {
										yield {
											type: "command_lifecycle",
											state: "started",
											command_uuid: message.uuid ?? "input",
											uuid: randomUUID(),
											session_id: "native",
										};
										if (message.uuid === goalInputId)
											yield {
												type: "assistant",
												uuid: randomUUID(),
												session_id: "native",
												parent_tool_use_id: null,
												message: {
													id: randomUUID(),
													role: "assistant",
													model: "<synthetic>",
													content: [
														{ type: "text", text: "Goal set: After rebinding" },
													],
												},
											} as SDKMessage;
										yield makeSuccessResult();
									}
								})();
								return Object.assign(createMockQuery([]), {
									[Symbol.asyncIterator]: () => stream,
								});
							},
						},
						(output) =>
							Effect.sync(() => {
								outputs.push(output);
								return {};
							}),
					);
					for (const [index, account] of ["a", "b"].entries()) {
						yield* runner.executeEffect({
							type: "send-turn",
							sinkId: account,
							aborted: false,
							input: {
								sessionId: "session",
								inputId: index === 0 ? randomUUID() : goalInputId,
								runId: account,
								prompt: account,
								workspaceRoot: root,
								extraFolders: [],
								history: [],
								providerState: {},
								configDir: configuredClaudeConfigDir(join(root, account)),
								instanceId: account,
								model: { providerId: "claude", modelId: "sonnet" },
								...(index === 0
									? { cumulativeTokens: 100 }
									: tokens === undefined
										? {}
										: { cumulativeTokens: tokens }),
							},
						});
						while (
							outputs.filter(
								(output) =>
									output.type === "event" &&
									output.event.type === "turn.completed",
							).length <
							index + 1
						)
							yield* Effect.sleep("10 millis");
					}
					expect(
						outputs.find(
							(output) =>
								output.type === "event" &&
								output.event.type === "session.goal_changed",
						),
					).toMatchObject({
						type: "event",
						event: { data: { goal: { tokensAtStart: tokens ?? 100 } } },
					});
				}),
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
