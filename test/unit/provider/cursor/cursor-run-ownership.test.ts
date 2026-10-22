import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCursorSessionRunner } from "../../../../src/lib/provider/cursor/cursor-runner-payload.js";
import type { CursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-port.js";
import type { SessionTurn } from "../../../../src/lib/provider/runner/session-runner.js";

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
						let sends = 0;
						let delta: ((value: unknown) => void) | undefined;
						const steer = vi.fn(() =>
							Effect.runPromise(Deferred.await(delivered)),
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
								});
							},
							(inFlight) => {
								lifecycle.push(inFlight ? "busy" : "idle");
							},
						);
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
							};
							return runner.executeEffect({
								type: "send-turn",
								sinkId: inputId,
								aborted: false,
								input,
							});
						};
						const accepted = () =>
							events.filter((event) => event.type === "run.started");
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
							yield* runner.executeEffect({ type: "abort", sinkId: "input-a" });
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
						if (evidence === "ack" || evidence === "terminal-error")
							yield* Deferred.succeed(delivered, "complete_delivered");
						else
							delta?.({
								type: "user-message-appended",
								userMessage: { text: "input-b" },
							});
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
});
