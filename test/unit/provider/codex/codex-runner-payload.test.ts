// Failure modes: process exit hides a native missing-thread error; a session
// retains the previous account's home after an account switch; a goal
// successor that arrived inside its window is dropped when read after it.
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { TestClock } from "effect/testing";
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
							facts: {
								_tag: "Codex",
								skill: { _tag: "None" },
								truncate: { _tag: "None" },
							},
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
						facts: {
							_tag: "Codex",
							skill: { _tag: "None" },
							truncate: { _tag: "None" },
						},
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

	// F271 (lane audit F271a-c): a goal successor that reached the runner inside
	// the window is the chain's, however late the turn loop reads it. The loop is
	// held in its sink on a goal update that follows the first turn/completed
	// while the successor arrives, then the clock passes the deadline.
	it.effect(
		"a successor that arrived inside the window joins the chain when read after it",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "codex-runner-successor-")),
					),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const lines = readFileSync(
					fileURLToPath(
						new URL(
							"../../../fixtures/codex-app-server-traces/goal-chain.jsonl",
							import.meta.url,
						),
					),
					"utf8",
				)
					.trim()
					.split("\n");
				const method = (line: string | undefined): unknown =>
					line ? JSON.parse(line).message?.method : undefined;
				const completed = lines.findIndex(
					(line) => method(line) === "turn/completed",
				);
				const update = lines
					.slice(0, completed)
					.map(method)
					.lastIndexOf("thread/goal/updated");
				const trace = join(root, "goal-chain.jsonl");
				writeFileSync(
					trace,
					`${[
						...lines.slice(0, update),
						...lines.slice(update + 1, completed + 1),
						lines[update],
						...lines.slice(completed + 1),
					].join("\n")}\n`,
				);
				const held = yield* Deferred.make<void>();
				const queued = yield* Deferred.make<void>();
				let usage = 0;
				const release = yield* Deferred.make<void>();
				const ended = yield* Deferred.make<ProviderRuntimeEvent>();
				const events: ProviderRuntimeEvent[] = [];
				const runner = yield* makeCodexSessionRunner(
					{
						workspaceRoot: root,
						daemonConfigDir: root,
						environment: () => ({
							CODEX_HOME: root,
							NODE_ENV: "test",
							CONDUIT_CODEX_APP_SERVER_TRACE: trace,
						}),
					},
					(output) =>
						Effect.gen(function* () {
							// The reader reports usage as rows arrive: the trace's fourth
							// usage row follows every goal turn's turn/started.
							if (output.type === "account-usage" && ++usage === 4)
								yield* Deferred.succeed(queued, undefined);
							if (output.type !== "event") return {};
							events.push(output.event);
							if (
								output.event.type === "session.goal_changed" &&
								events.filter(({ type }) => type === "session.goal_changed")
									.length === 3
							) {
								yield* Deferred.succeed(held, undefined);
								yield* Deferred.await(release);
							}
							if (
								["turn.interrupted", "turn.completed", "turn.error"].includes(
									output.event.type,
								)
							)
								yield* Deferred.succeed(ended, output.event);
							return {};
						}),
				);
				const admission = yield* makeRunnerAdmission(runner, "codex");
				yield* admitRunnerCommand(admission, runner, {
					type: "send-turn",
					sinkId: "input",
					aborted: false,
					input: {
						sessionId: "session",
						inputId: "input",
						runId: "run",
						prompt: "$goal Say hello",
						history: [],
						providerState: {},
						workspaceRoot: root,
						extraFolders: [],
						configDir: configuredClaudeConfigDir(root),
						folderSource: "account",
						model: { providerId: "codex", modelId: "gpt-6.1-sol" },
						facts: {
							_tag: "Codex",
							skill: { _tag: "None" },
							truncate: { _tag: "None" },
						},
					},
				});
				yield* Deferred.await(held);
				yield* Deferred.await(queued);
				yield* TestClock.adjust("31 seconds");
				yield* Deferred.succeed(release, undefined);
				expect(yield* Deferred.await(ended)).toMatchObject({
					type: "turn.completed",
					runId: "run",
				});
				// All three goal turns reach the one Run: each turn's text, once.
				expect(events.filter(({ type }) => type === "text.delta")).toHaveLength(
					6,
				);
			}),
	);

	// The runner never re-derives what prepare decided: a turn without its
	// facts fails before any native turn starts.
	it.live("a send without prepared turn facts fails unprepared", () =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-facts-"))),
				(path) =>
					Effect.sync(() => rmSync(path, { recursive: true, force: true })),
			);
			const capture = join(root, "capture.jsonl");
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
				() => Effect.succeed({}),
			);
			const admission = yield* makeRunnerAdmission(runner, "codex");
			expect(
				yield* admitRunnerCommand(admission, runner, {
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
						model: { providerId: "codex", modelId: "gpt-5.4" },
						facts: { _tag: "Claude" },
					},
				}),
			).toMatchObject({ status: "error", error: { code: "turn_unprepared" } });
			expect(
				existsSync(capture) ? readFileSync(capture, "utf8") : "",
			).not.toContain('"method":"turn/start"');
		}),
	);
});
