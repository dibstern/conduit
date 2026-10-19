import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
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
	] as const)("keeps intake and terminal ownership with %s evidence", async (evidence) => {
		const root = mkdtempSync(join(tmpdir(), "cursor-run-ownership-"));
		const events: ProviderRuntimeEvent[] = [];
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const intake = yield* Deferred.make<void>();
						const delivered = yield* Deferred.make<
							"complete_delivered" | "revert_to_followup"
						>();
						const finish = yield* Deferred.make<void>();
						let sends = 0;
						let delta: ((value: unknown) => void) | undefined;
						const steer = vi.fn(() =>
							Effect.runPromise(Deferred.await(delivered)),
						);
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
								send: async (_prompt, _options, onDelta) => {
									const first = ++sends === 1;
									if (first) delta = onDelta;
									const nativeId = first
										? String(running["run_id"])
										: "native-next";
									return {
										id: nativeId,
										steer,
										cancel: async () => {},
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
							},
							(output) =>
								Effect.sync(() => {
									if (output.type === "event") events.push(output.event);
									return {};
								}),
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
							return;
						}
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(accepted()).toHaveLength(1)),
						);
						const second = yield* Effect.forkChild(send("input-b", "run-b"));
						yield* Effect.promise(() =>
							vi.waitFor(() => expect(steer).toHaveBeenCalledOnce()),
						);
						expect(accepted()).toHaveLength(1);
						if (evidence === "ack")
							yield* Deferred.succeed(delivered, "complete_delivered");
						else
							delta?.({
								type: "user-message-appended",
								userMessage: { text: "input-b" },
							});
						expect((yield* Fiber.join(second)).status).toBe("joined");
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
						expect((yield* Fiber.join(first)).status).toBe("completed");
						expect((yield* send("input-c", "run-c")).status).toBe("completed");
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
