// Failure modes: process exit hides a native missing-thread error; a session
// retains the previous account's home after an account switch.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCodexSessionRunner } from "../../../../src/lib/provider/codex/codex-runner-payload.js";
import { writeCodexSessionIdentity } from "../../../../src/lib/provider/codex/codex-session-store.js";

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
				const send = (home: string) =>
					runner.executeEffect({
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
});
