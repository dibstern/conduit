import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Option, Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCursorSessionRunner } from "../../../../src/lib/provider/cursor/cursor-runner-payload.js";
import type { CursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-port.js";
import type { SendScope } from "../../../../src/lib/provider/runner/send-scope.js";
import type { SessionTurn } from "../../../../src/lib/provider/runner/session-runner.js";
import { cursorCredentialFixture } from "../../../helpers/cursor-account-resources-fixture.js";
import { makeRunnerAdmission } from "../../../helpers/runner-provider-admission.js";

const rows = readFileSync(
	join(import.meta.dirname, "../../../fixtures/cursor-sdk-traces/basic.jsonl"),
	"utf8",
)
	.split("\n")
	.filter(Boolean)
	.map((line): { kind?: string; data?: Record<string, unknown> } =>
		JSON.parse(line),
	);
const running = rows.find(
	(row) => row.kind === "stream" && row.data?.["status"] === "RUNNING",
)?.data;
const terminal = rows.find((row) => row.kind === "wait.result")?.data;
if (!running || !terminal)
	throw new Error("Missing recorded Cursor boundaries");

describe("Cursor accepted run ownership", () => {
	it.each([
		"ack",
		"user-echo",
		"no-intake",
		"terminal-error",
		"recall-before-send",
		"recall-after-send",
		"unprepared",
		// Signed in, but the send lacks prepare's facts.
		"unprepared-facts",
		// J7 (AMENDMENT-2026-11-16): the steer's answer arrives after the turn ends.
		"late-delivered",
		"late-reverted",
		"steer-failure",
	] as const)("keeps intake and terminal ownership with %s evidence", async (evidence) => {
		const root = mkdtempSync(join(tmpdir(), "cursor-run-ownership-"));
		const events: ProviderRuntimeEvent[] = [];
		const lifecycle: string[] = [];
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const intake = yield* Deferred.make<void>();
						const preparation = yield* Deferred.make<void>();
						let preparing = false;
						const delivered = yield* Deferred.make<
							"complete_delivered" | "revert_to_followup"
						>();
						const finish = yield* Deferred.make<void>();
						const ended = yield* Deferred.make<void>();
						let sends = 0;
						let delta: ((value: unknown) => void) | undefined;
						const steer = vi.fn(() =>
							evidence === "steer-failure"
								? Promise.reject(new Error("steer transport failed"))
								: Effect.runPromise(Deferred.await(delivered)),
						);
						const cancel = vi.fn(async () => {});
						const port: CursorSdkPort = {
							probeRuntime: async () => ({ available: true }),
							authLogin: async () => {},
							authStatus: async () => ({ status: "logged-out" }),
							authLogout: async () => {},
							storedCredential: async () => undefined,
							modelsList: async () => [],
							openStore: async () => ({ dispose: async () => {} }),
							getActiveRun: async () => undefined,
							deleteAgent: async () => {},
							primeSandbox: async () => {
								preparing = true;
								if (evidence === "recall-before-send")
									await Effect.runPromise(Deferred.await(preparation));
							},
							resumeAgent: (_id, options, credential, store, tools) =>
								port.createAgent(options, credential, store, tools),
							createAgent: async () => ({
								id: String(running["agent_id"]),
								getUsage: async () => undefined,
								close: async () => {},
								send: async (_prompt, _options, onDelta) => {
									const first = ++sends === 1;
									if (first) delta = onDelta;
									const nativeId = first
										? String(running["run_id"])
										: "native-next";
									return {
										id: nativeId,
										steer,
										cancel,
										stream: (async function* () {
											if (first) {
												yield { ...running, run_id: "foreign-native-run" };
												await Effect.runPromise(Deferred.await(intake));
											}
											if (evidence !== "no-intake")
												yield { ...running, run_id: nativeId };
											onDelta({ type: "text-delta", text: "Answer" });
											if (first)
												await Effect.runPromise(Deferred.await(finish));
										})(),
										wait: async () => {
											if (first)
												await Effect.runPromise(Deferred.await(finish));
											return { ...terminal, id: nativeId };
										},
									};
								},
							}),
						};
						const runner = yield* makeCursorSessionRunner(
							{
								workspaceRoot: root,
								daemonConfigDir: root,
								port,
								credential: () =>
									evidence === "unprepared"
										? undefined
										: cursorCredentialFixture("inert-test-key", "environment"),
								environment: () => ({ CURSOR_API_KEY: "inert-test-key" }),
								onAbandonedRun: (inputId) => {
									lifecycle.push(`retire:${inputId}`);
								},
							},
							(output) => {
								if (
									evidence === "terminal-error" &&
									output.type === "event" &&
									output.event.type === "turn.completed"
								)
									return Effect.fail({
										operation: "persist terminal",
										message: "terminal ingestion failed",
									});
								return Effect.sync(() => {
									if (output.type === "event") events.push(output.event);
									return {};
								}).pipe(
									Effect.tap(() =>
										output.type === "event" &&
										output.event.type === "turn.completed"
											? Deferred.succeed(ended, undefined)
											: Effect.void,
									),
								);
							},
							(inFlight) => {
								lifecycle.push(inFlight ? "busy" : "idle");
							},
						);
						const admission = yield* makeRunnerAdmission(runner, "cursor");
						let activeSend: SendScope | undefined;
						const send = (inputId: string, runId: string) => {
							const input: SessionTurn = {
								sessionId: "session",
								inputId,
								runId,
								prompt: inputId,
								history: [],
								providerState: {},
								workspaceRoot: root,
								extraFolders: [],
								configDir: configuredClaudeConfigDir(root),
								folderSource: "account",
								model: { providerId: "cursor", modelId: "composer-2.5" },
								...(evidence === "unprepared-facts"
									? {}
									: {
											facts: {
												_tag: "Cursor" as const,
												model: { _tag: "Resolved" as const, params: [] },
											},
										}),
							};
							return admission
								.admitSendEffect(
									{ origin: { _tag: "Fresh" }, sinkId: inputId, input },
									(handle) => {
										activeSend = handle;
										return runner.executeEffect(
											{
												type: "send-turn",
												sinkId: inputId,
												aborted: false,
												input,
											},
											handle,
										);
									},
								)
								.pipe(Effect.map(Option.getOrThrow));
						};
						const accepted = () =>
							events.filter((event) => event.type === "run.started");
						if (evidence === "unprepared" || evidence === "unprepared-facts") {
							const result = yield* send("unprepared", "run-unprepared");
							expect(result).toMatchObject({
								status: "error",
								error: { code: "turn_unprepared" },
							});
							expect(sends).toBe(0);
							return;
						}
						const first = yield* Effect.forkChild(send("input-a", "run-a"));
						if (
							evidence === "recall-before-send" ||
							evidence === "recall-after-send"
						) {
							yield* Effect.promise(() =>
								vi.waitFor(() =>
									expect(
										evidence === "recall-before-send" ? preparing : sends === 1,
									).toBe(true),
								),
							);
							if (!activeSend)
								return yield* Effect.die("Missing admitted send");
							yield* runner.executeEffect(
								{ type: "abort", sinkId: "input-a" },
								activeSend,
							);
							const response = yield* Effect.result(
								Fiber.join(first).pipe(Effect.timeout("1 second")),
							);
							const cancellations = cancel.mock.calls.length;
							if (Result.isFailure(response)) {
								yield* Deferred.succeed(preparation, undefined);
								yield* Deferred.succeed(intake, undefined);
								yield* Deferred.succeed(finish, undefined);
							}
							expect(response._tag).toBe("Success");
							if (Result.isFailure(response)) return;
							expect(response.success.status).toBe(
								evidence === "recall-before-send"
									? "cancelled"
									: "indeterminate",
							);
							expect(cancellations).toBe(0);
							expect(accepted()).toHaveLength(0);
							expect(
								events.filter((event) => event.type === "turn.interrupted"),
							).toHaveLength(0);
							if (evidence === "recall-before-send") {
								yield* Deferred.succeed(preparation, undefined);
								yield* Effect.promise(() =>
									vi.waitFor(() => expect(lifecycle.at(-1)).toBe("idle")),
								);
								expect(sends).toBe(0);
								return;
							}
							yield* Deferred.succeed(intake, undefined);
							yield* Effect.promise(() =>
								vi.waitFor(() =>
									expect(accepted().map((event) => event.runId)).toEqual([
										"run-a",
									]),
								),
							);
							yield* Deferred.succeed(finish, undefined);
							yield* Effect.promise(() =>
								vi.waitFor(() =>
									expect(
										events
											.filter((event) => event.type === "turn.completed")
											.map((event) => event.runId),
									).toEqual(["run-a"]),
								),
							);
							expect(cancel).not.toHaveBeenCalled();
							return;
						}
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(sends).toBe(1)),
						);
						expect(accepted()).toHaveLength(0);
						yield* Deferred.succeed(intake, undefined);
						if (evidence === "no-intake") {
							yield* Deferred.succeed(finish, undefined);
							expect((yield* Fiber.join(first)).status).toBe("completed");
							expect(accepted()).toHaveLength(0);
							expect(
								events
									.filter((event) => event.type === "turn.completed")
									.map((event) => event.runId),
							).toEqual(["run-a"]);
							expect(events).toEqual(
								expect.arrayContaining([
									expect.objectContaining({
										type: "text.delta",
										runId: "run-a",
										data: expect.objectContaining({ text: "Answer" }),
									}),
								]),
							);
							return;
						}
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(accepted()).toHaveLength(1)),
						);
						const replies: string[] = [];
						yield* Effect.forkChild(
							Fiber.join(first).pipe(
								Effect.tap((result) =>
									Effect.sync(() => {
										replies.push(result.status);
									}),
								),
							),
						);
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(replies).toEqual(["accepted"])),
						);
						const second = yield* Effect.forkChild(send("input-b", "run-b"));
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(steer).toHaveBeenCalledOnce()),
						);
						expect(accepted()).toHaveLength(1);
						if (evidence === "steer-failure") {
							// 107: a failed steer call fails the send, final; it is not declined.
							expect(yield* Fiber.join(second)).toMatchObject({
								status: "error",
								error: {
									retryable: false,
									message: expect.stringContaining("steer transport failed"),
								},
							});
							yield* Deferred.succeed(finish, undefined);
							expect((yield* Fiber.join(first)).status).toBe("accepted");
							expect(accepted()).toHaveLength(1);
							return;
						}
						if (evidence === "late-delivered" || evidence === "late-reverted") {
							// 105: the turn ends with the answer outstanding; the steer
							// stays pending, and its later answer settles it. A late
							// complete_delivered starts the steer's own Run and settles it
							// with the turn's native outcome: nothing else would end it.
							yield* Deferred.succeed(finish, undefined);
							expect((yield* Fiber.join(first)).status).toBe("accepted");
							yield* Deferred.await(ended);
							expect(second.pollUnsafe()).toBeUndefined();
							yield* Deferred.succeed(
								delivered,
								evidence === "late-delivered"
									? "complete_delivered"
									: "revert_to_followup",
							);
							expect((yield* Fiber.join(second)).status).toBe(
								evidence === "late-delivered" ? "accepted" : "steer-declined",
							);
							expect(
								accepted().map(({ runId, data }) => ({ runId, data })),
							).toEqual([
								{
									runId: "run-a",
									data: { inputId: "input-a", requestedRunId: "run-a" },
								},
								...(evidence === "late-delivered"
									? [
											{
												runId: "run-b",
												data: { inputId: "input-b", requestedRunId: "run-b" },
											},
										]
									: []),
							]);
							expect(
								events.flatMap(({ type, runId, data }) =>
									type === "turn.completed" ||
									type === "turn.interrupted" ||
									type === "turn.error"
										? [
												{
													type,
													runId,
													userMessageId:
														typeof data === "object" &&
														data !== null &&
														"userMessageId" in data
															? data.userMessageId
															: undefined,
												},
											]
										: [],
								),
							).toEqual([
								{
									type: "turn.completed",
									runId: "run-a",
									userMessageId: undefined,
								},
								...(evidence === "late-delivered"
									? [
											{
												type: "turn.completed",
												runId: "run-b",
												userMessageId: "input-b",
											},
										]
									: []),
							]);
							return;
						}
						if (evidence === "user-echo") {
							// 92: an appended-user delta matching the steer's text is not
							// its join; only the SDK's complete_delivered answer is.
							delta?.({
								type: "user-message-appended",
								userMessage: { text: "input-b" },
							});
							yield* Effect.sleep("50 millis");
							expect(second.pollUnsafe()).toBeUndefined();
							expect(accepted()).toHaveLength(1);
						}
						yield* Deferred.succeed(delivered, "complete_delivered");
						expect((yield* Fiber.join(second)).status).toBe("accepted");
						expect(
							accepted().map(({ runId, data }) => ({ runId, data })),
						).toEqual([
							{
								runId: "run-a",
								data: { inputId: "input-a", requestedRunId: "run-a" },
							},
							{
								runId: "run-a",
								data: { inputId: "input-b", requestedRunId: "run-b" },
							},
						]);
						expect(
							events.filter((event) => event.type === "turn.completed"),
						).toHaveLength(0);
						yield* Deferred.succeed(finish, undefined);
						if (evidence === "terminal-error") {
							yield* Effect.promise(() =>
								vi.waitFor(() =>
									expect(lifecycle.slice(-2)).toEqual([
										"retire:input-a",
										"idle",
									]),
								),
							);
							expect((yield* Fiber.join(first)).status).toBe("accepted");
							return;
						}
						yield* Effect.promise(() =>
							vi.waitFor(() =>
								expect(
									events.filter((event) => event.type === "turn.completed"),
								).toHaveLength(1),
							),
						);
						expect((yield* Fiber.join(first)).status).toBe("accepted");
						expect((yield* send("input-c", "run-c")).status).toBe("accepted");
						yield* Effect.promise(() =>
							vi.waitFor(() =>
								expect(
									events.filter((event) => event.type === "turn.completed"),
								).toHaveLength(2),
							),
						);
						expect(accepted().map((event) => event.runId)).toEqual([
							"run-a",
							"run-a",
							"run-c",
						]);
						expect(
							events
								.filter((event) => event.type === "turn.completed")
								.map((event) => event.runId),
						).toEqual(["run-a", "run-c"]);
						expect(
							events
								.filter((event) => event.type === "text.delta")
								.map((event) => event.runId),
						).toEqual(["run-a", "run-c"]);
					}),
				),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// 4.6: a Stop names runs, never reusable input ids, so a late frame never
	// stops a newer send's turn: the turn runs on to its own completion.
	it("a late interrupt naming an older run never stops a newer send's turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-run-stop-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const finish = yield* Deferred.make<void>();
						const cancel = vi.fn(async () => {
							await Effect.runPromise(Deferred.succeed(finish, undefined));
						});
						let sends = 0;
						const port: CursorSdkPort = {
							probeRuntime: async () => ({ available: true }),
							authLogin: async () => {},
							authStatus: async () => ({ status: "logged-out" }),
							authLogout: async () => {},
							storedCredential: async () => undefined,
							modelsList: async () => [],
							openStore: async () => ({ dispose: async () => {} }),
							getActiveRun: async () => undefined,
							deleteAgent: async () => {},
							primeSandbox: async () => {},
							resumeAgent: (_id, options, credential, store, tools) =>
								port.createAgent(options, credential, store, tools),
							createAgent: async () => ({
								id: String(running["agent_id"]),
								getUsage: async () => undefined,
								close: async () => {},
								send: async () => {
									sends += 1;
									const nativeId = String(running["run_id"]);
									return {
										id: nativeId,
										steer: async () => "complete_delivered" as const,
										cancel,
										stream: (async function* () {
											yield { ...running, run_id: nativeId };
											await Effect.runPromise(Deferred.await(finish));
										})(),
										wait: async () => {
											await Effect.runPromise(Deferred.await(finish));
											return { ...terminal, id: nativeId };
										},
									};
								},
							}),
						};
						const started = yield* Deferred.make<void>();
						const ended = yield* Deferred.make<ProviderRuntimeEvent>();
						const runner = yield* makeCursorSessionRunner(
							{
								workspaceRoot: root,
								daemonConfigDir: root,
								port,
								credential: () =>
									cursorCredentialFixture("inert-test-key", "environment"),
								environment: () => ({ CURSOR_API_KEY: "inert-test-key" }),
							},
							(output) =>
								(output.type !== "event"
									? Effect.void
									: output.event.type === "run.started"
										? Deferred.succeed(started, undefined)
										: [
													"turn.interrupted",
													"turn.completed",
													"turn.error",
												].includes(output.event.type)
											? Deferred.succeed(ended, output.event)
											: Effect.void
								).pipe(Effect.as({})),
						);
						const admission = yield* makeRunnerAdmission(runner, "cursor");
						const input: SessionTurn = {
							sessionId: "session",
							inputId: "shared-input",
							runId: "run-new",
							prompt: "Answer",
							history: [],
							providerState: {},
							workspaceRoot: root,
							extraFolders: [],
							configDir: configuredClaudeConfigDir(root),
							folderSource: "account",
							model: { providerId: "cursor", modelId: "composer-2.5" },
							facts: {
								_tag: "Cursor",
								model: { _tag: "Resolved", params: [] },
							},
						};
						yield* Effect.forkChild(
							admission.admitSendEffect(
								{ origin: { _tag: "Fresh" }, sinkId: "shared-input", input },
								(handle) =>
									runner.executeEffect(
										{
											type: "send-turn",
											sinkId: "shared-input",
											aborted: false,
											input,
										},
										handle,
									),
							),
						);
						yield* Deferred.await(started);
						yield* runner.executeEffect({
							type: "interrupt",
							sessionId: "session",
							runIds: ["run-old"],
						});
						yield* Deferred.succeed(finish, undefined);
						expect((yield* Deferred.await(ended)).type).toBe("turn.completed");
						expect(cancel).not.toHaveBeenCalled();
						expect(sends).toBe(1);
					}),
				),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
