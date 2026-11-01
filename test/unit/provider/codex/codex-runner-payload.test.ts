// Failure modes: process exit hides a native missing-thread error; a session
// retains the previous account's home after an account switch.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { expect } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCodexSessionRunner } from "../../../../src/lib/provider/codex/codex-runner-payload.js";
import { writeCodexSessionIdentity } from "../../../../src/lib/provider/codex/codex-session-store.js";
import {
	admitRunnerCommand,
	makeRunnerAdmission,
} from "../../../helpers/runner-provider-admission.js";

describe("Codex runner preparation", () => {
	it.effect(
		"reloads a cached session after its selected account home changes",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "codex-runner-preparation-")),
					),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const events: ProviderRuntimeEvent[] = [];
				const transports = join(root, "transports.jsonl");
				const firstHome = join(root, "first");
				const secondHome = join(root, "second");
				const threadId = "019a0000-0000-7000-8000-000000000000";
				writeCodexSessionIdentity(root, "session", {
					threadId,
					codexHome: firstHome,
					cwd: root,
					controllerPid: process.pid,
				});
				const runner = yield* makeCodexSessionRunner(
					{
						workspaceRoot: root,
						daemonConfigDir: root,
						environment: () => ({
							CODEX_HOME: root,
							NODE_ENV: "test",
							CONDUIT_TEST_CODEX_TRANSPORTS: transports,
							CONDUIT_CODEX_APP_SERVER_TRACE: fileURLToPath(
								new URL(
									"../../../fixtures/codex-app-server-traces/resume-missing.jsonl",
									import.meta.url,
								),
							),
							CONDUIT_CODEX_APP_SERVER_CAPTURE: join(root, "capture.jsonl"),
						}),
					},
					(output) => {
						if (output.type === "event") events.push(output.event);
						return Effect.succeed({});
					},
				);
				const admission = yield* makeRunnerAdmission(runner, "codex");
				const send = (home: string) =>
					admitRunnerCommand(admission, runner, {
						type: "send-turn",
						sinkId: "input",
						aborted: false,
						input: {
							sessionId: "session",
							inputId: "input",
							runId: "run",
							prompt: "Say hello",
							history: [],
							providerState: {},
							workspaceRoot: root,
							extraFolders: [],
							configDir: configuredClaudeConfigDir(root),
							folderSource: "account",
							model: { providerId: "codex", modelId: "gpt-6.1-sol" },
							account: {
								id: AccountIdSchema.make(home),
								driver: "codex",
								configuredFolder: home,
								name: home,
								usageEligible: false,
							},
						},
					});
				expect(yield* send(firstHome)).toMatchObject({
					status: "error",
					error: { code: "codex_thread_missing" },
				});
				writeCodexSessionIdentity(root, "session", {
					threadId,
					codexHome: secondHome,
					cwd: root,
					controllerPid: process.pid,
					resumeFallbackDigest: "Keep the saved history",
				});
				expect(yield* send(secondHome)).toMatchObject({
					status: "error",
				});
				expect(
					readFileSync(transports, "utf8")
						.trim()
						.split("\n")
						.map((line): unknown => JSON.parse(line)),
				).toEqual([
					expect.objectContaining({ home: firstHome }),
					expect.objectContaining({ home: secondHome }),
				]);
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "turn.error",
						data: expect.objectContaining({ code: "codex_thread_missing" }),
					}),
				);
			}),
	);

	// 4.6: a Stop names runs, never reusable input ids, so a late frame never
	// stops a newer send's turn. Each interrupt returns after its turn/interrupt
	// reply, and the capture records every request synchronously.
	it.live(
		"a late interrupt naming an older run never stops a newer send's turn",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-stop-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const capture = join(root, "capture.jsonl");
				const started = yield* Deferred.make<void>();
				const ended = yield* Deferred.make<ProviderRuntimeEvent>();
				const runner = yield* makeCodexSessionRunner(
					{
						workspaceRoot: root,
						daemonConfigDir: root,
						environment: () => ({
							CODEX_HOME: root,
							NODE_ENV: "test",
							CONDUIT_CODEX_APP_SERVER_TRACE: fileURLToPath(
								new URL(
									"../../../fixtures/codex-app-server-traces/stop-queued.jsonl",
									import.meta.url,
								),
							),
							CONDUIT_CODEX_APP_SERVER_CAPTURE: capture,
						}),
					},
					(output) =>
						(output.type !== "event"
							? Effect.void
							: output.event.type === "run.started"
								? Deferred.succeed(started, undefined)
								: ["turn.interrupted", "turn.completed", "turn.error"].includes(
											output.event.type,
										)
									? Deferred.succeed(ended, output.event)
									: Effect.void
						).pipe(Effect.as({})),
				);
				const admission = yield* makeRunnerAdmission(runner, "codex");
				yield* admitRunnerCommand(admission, runner, {
					type: "send-turn",
					sinkId: "input",
					aborted: false,
					input: {
						sessionId: "session",
						inputId: "shared-input",
						runId: "run-new",
						prompt: "Say hello",
						history: [],
						providerState: {},
						workspaceRoot: root,
						extraFolders: [],
						configDir: configuredClaudeConfigDir(root),
						folderSource: "account",
						model: { providerId: "codex", modelId: "gpt-5.4" },
					},
				}).pipe(Effect.forkScoped);
				const interruptRequests = () =>
					readFileSync(capture, "utf8")
						.split("\n")
						.filter((line) => line.includes('"method":"turn/interrupt"'))
						.length;
				yield* Deferred.await(started);
				yield* runner.executeEffect({
					type: "interrupt",
					sessionId: "session",
					runIds: ["run-old"],
				});
				expect(interruptRequests()).toBe(0);
				expect(yield* Deferred.isDone(ended)).toBe(false);
				yield* runner.executeEffect({
					type: "interrupt",
					sessionId: "session",
					runIds: ["run-new"],
				});
				expect(interruptRequests()).toBe(1);
				expect(yield* Deferred.await(ended)).toMatchObject({
					type: "turn.interrupted",
					runId: "run-new",
				});
			}),
	);
});
