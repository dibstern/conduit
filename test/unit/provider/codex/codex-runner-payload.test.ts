// Failure modes: process exit hides a native missing-thread error; a session
// retains the previous account's home after an account switch; a goal
// successor that arrived inside its window is dropped when read after it; an
// app-server exit inside the successor window fails a turn that completed; a
// successor that arrived after its window is lost when its loop reads it.
// A steer (J2, J3 AMENDMENT-2026-11-16): it joins the open run at its
// turn/steer reply rather than at Codex's echo; an accepted steer Codex never
// echoes before turn/completed joins the closed run (90); a reply read after
// the turn settled joins or writes to the closed run (91); an echo without
// clientId joins a steer, on the turn its reply named or beside a tagged echo
// (108); a tagged echo read as both item/started and item/completed joins
// twice (110); the turn's own input echo, read after a steer's reply, joins
// that steer.
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
import { Deferred, Effect, Fiber } from "effect";
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
						prompt: "Say hello",
						nativeFirst: [{ commandId: "goal-set", text: "/goal Say hello" }],
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

	it.effect(
		"a successor that arrived after the window runs as a wake when read late",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-late-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const source = fileURLToPath(
					new URL(
						"../../../fixtures/codex-app-server-traces/goal-chain.jsonl",
						import.meta.url,
					),
				);
				const rows = readFileSync(source, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const completed = rows.findIndex(
					({ message }) => message?.method === "turn/completed",
				);
				const successor = rows.findIndex(
					({ message }, index) =>
						index > completed && message?.method === "turn/started",
				);
				const successorCompleted = rows.findIndex(
					({ message }, index) =>
						index > successor && message?.method === "turn/completed",
				);
				// The successor's start is the first row after the window, so the loop
				// reads it before anything else that arrived late; the chain ends with
				// it, so only that start can wake the session.
				const kept = [
					...rows.slice(0, completed + 1),
					...rows.slice(successor, successorCompleted + 1),
					rows.at(-1),
				];
				const usageRows = kept.filter(
					({ message }) => message?.method === "account/rateLimits/updated",
				).length;
				const trace = join(root, "goal-chain.jsonl");
				writeFileSync(
					trace,
					`${kept.map((row) => JSON.stringify(row)).join("\n")}\n`,
				);
				// The player passes rows up to the gate; the rest arrive after the window.
				const gate = join(root, "gate");
				writeFileSync(gate, String(rows[completed].at));
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						process.env["CONDUIT_CODEX_APP_SERVER_TRACE_GATE"] = gate;
					}),
					() =>
						Effect.sync(() => {
							delete process.env["CONDUIT_CODEX_APP_SERVER_TRACE_GATE"];
						}),
				);
				const held = yield* Deferred.make<void>();
				const queued = yield* Deferred.make<void>();
				let usage = 0;
				const release = yield* Deferred.make<void>();
				const ended = yield* Deferred.make<ProviderRuntimeEvent>();
				// A wake's events reach no closed send, so the runner's busy reports
				// show it: the send's turn, the wake taking over, the wake's end.
				const busy: boolean[] = [];
				let woke = () => {};
				const wakeEnded = new Promise<void>((resolve) => {
					woke = resolve;
				});
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
							if (output.type === "account-usage" && ++usage === usageRows)
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
					(inFlight) => {
						busy.push(inFlight);
						if (busy.length === 3) woke();
					},
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
						prompt: "Say hello",
						nativeFirst: [{ commandId: "goal-set", text: "/goal Say hello" }],
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
				yield* TestClock.adjust("31 seconds");
				writeFileSync(gate, String(Number.MAX_SAFE_INTEGER));
				yield* TestClock.adjust("1 second");
				yield* Deferred.await(queued);
				yield* Deferred.succeed(release, undefined);
				// The send's Run ends at its own turn; the late successor is a wake (CONTRACT 3119).
				expect(yield* Deferred.await(ended)).toMatchObject({
					type: "turn.completed",
					runId: "run",
				});
				yield* Effect.promise(() => wakeEnded);
				expect(busy).toEqual([true, true, false]);
			}),
	);

	it.live(
		"an app-server exit ends a completed goal turn as completed, a live turn as an error",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-exit-"))),
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
				const method = (line: string): unknown =>
					JSON.parse(line).message?.method;
				const completed = lines.findIndex(
					(line) => method(line) === "turn/completed",
				);
				const delta = lines.findIndex(
					(line) => method(line) === "item/agentMessage/delta",
				);
				// The trace ends with the app-server's exit row.
				const endOf = (cut: number) =>
					Effect.gen(function* () {
						const trace = join(root, `exit-${cut}.jsonl`);
						writeFileSync(
							trace,
							`${[...lines.slice(0, cut + 1), lines.at(-1)].join("\n")}\n`,
						);
						const ended = yield* Deferred.make<ProviderRuntimeEvent>();
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
								(output.type === "event" &&
								["turn.interrupted", "turn.completed", "turn.error"].includes(
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
								inputId: "input",
								runId: "run",
								prompt: "Say hello",
								nativeFirst: [
									{ commandId: "goal-set", text: "/goal Say hello" },
								],
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
						return (yield* Deferred.await(ended)).type;
					});
				// No successor can start once the app-server is gone, so the
				// withheld result is the turn's own (CONTRACT 3087, 3118).
				expect(yield* endOf(completed)).toBe("turn.completed");
				expect(yield* endOf(delta)).toBe("turn.error");
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

	// J2, J3 (AMENDMENT-2026-11-16): Codex's userMessage echo is a steer's join; the turn/steer
	// reply only places it. An echo joins by identity only, its clientId, never by text or by the
	// turn its reply named, and only on the turn still executing. Nothing joins or reaches the closed run
	// after its turn settled (90, 91). A steer its turn ended without echoing is its own Run (J4):
	// the later turn Codex runs it in starts that Run, under its own run id, and ends it (90); an
	// echo naming the ended turn consumes nothing. `starts` names the run its run.started names;
	// `wake` runs a turn after the first, echoing the steer on it or on the ended turn.
	for (const variant of [
		{ name: "joins at the echo", readsReply: true, starts: "run" },
		{
			name: "joins no echo without clientId on its reply's turn",
			readsReply: true,
		},
		{
			name: "joins no echo of its turn's own input read after its reply",
			readsReply: true,
			// The turn's own input, word for word: text is no identity.
			prompt: "Say hello",
		},
		{
			name: "stays pending when no echo precedes turn/completed",
			readsReply: false,
		},
		{
			name: "joins nothing from a reply read after the turn settled",
			readsReply: false,
		},
		{
			name: "starts its own Run at a later turn's echo after turn/completed",
			readsReply: true,
			starts: "run-steer",
			wake: "echo",
		},
		{
			name: "is not taken by its ended turn's late echo read in a later turn",
			readsReply: true,
			wake: "stale",
		},
	] as const)
		it.live(`a steer ${variant.name}`, () =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-steer-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const rows: {
					at: number;
					message?: {
						id?: number;
						method?: string;
						params?: {
							item?: Record<string, unknown>;
							turn?: { id?: string };
						};
					};
				}[] = readFileSync(
					fileURLToPath(
						new URL(
							"../../../fixtures/codex-app-server-traces/steer.jsonl",
							import.meta.url,
						),
					),
					"utf8",
				)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const echoed = (row: (typeof rows)[number]) =>
					row.message?.params?.item?.["type"] === "userMessage" &&
					row.message.params.item["clientId"] === "fixture-steer";
				// The turn's own input, echoed without clientId; read late, it reaches the turn loop
				// only after a steer's reply named this turn.
				const opening = (row: (typeof rows)[number]) =>
					row.message?.params?.item?.["type"] === "userMessage" &&
					row.message.params.item["clientId"] === null;
				const reply = rows.findIndex(
					({ message }) => message?.id === 4 && message.method === undefined,
				);
				const completed = rows.findIndex(
					({ message }) => message?.method === "turn/completed",
				);
				const settledAt = rows[completed]?.at ?? 0;
				const kept =
					variant.name === "joins at the echo"
						? rows
						: variant.name ===
								"joins no echo without clientId on its reply's turn"
							? rows.map((row) => {
									if (!echoed(row) || !row.message?.params?.item) return row;
									const { clientId: _clientId, ...item } =
										row.message.params.item;
									return {
										...row,
										message: {
											...row.message,
											params: { ...row.message.params, item },
										},
									};
								})
							: variant.name ===
									"joins no echo of its turn's own input read after its reply"
								? rows.flatMap((row, index) =>
										echoed(row) || opening(row)
											? []
											: index === reply
												? [
														row,
														...rows
															.filter(opening)
															.map((echo) => ({ ...echo, at: row.at + 1 })),
													]
												: [row],
									)
								: variant.name ===
										"stays pending when no echo precedes turn/completed"
									? rows.filter((row) => !echoed(row))
									: variant.wake
										? rows.flatMap((row, index) => {
												if (echoed(row)) return [];
												if (index !== completed) return [row];
												// Codex starts a new turn while idle: its start, the steer's echo
												// (on the new turn, or late on the ended one) and its end.
												const ended =
													rows[completed]?.message?.params?.turn?.id ?? "";
												return [
													row,
													...rows
														.filter(
															(next, index) =>
																next.message?.method === "turn/started" ||
																echoed(next) ||
																index === completed,
														)
														.map((next, offset) => ({
															...(variant.wake === "stale" && echoed(next)
																? next
																: JSON.parse(
																		JSON.stringify(next).replaceAll(
																			ended,
																			"wake-turn",
																		),
																	)),
															at: settledAt + 1 + offset,
														})),
												];
											})
										: rows.flatMap((row, index) =>
												echoed(row) || index === reply
													? []
													: index === completed
														? [row, { ...rows[reply], at: settledAt + 1 }]
														: [row],
											);
				const trace = join(root, "steer.jsonl");
				writeFileSync(
					trace,
					`${kept.map((row) => JSON.stringify(row)).join("\n")}\n`,
				);
				// A joining steer's echo waits behind the gate until its reply has been read; the
				// late reply passes it only once the turn's terminal has been read.
				const gate = join(root, "gate");
				writeFileSync(
					gate,
					String(variant.readsReply ? (rows[reply]?.at ?? 0) : settledAt),
				);
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						process.env["CONDUIT_CODEX_APP_SERVER_TRACE_GATE"] = gate;
					}),
					() =>
						Effect.sync(() => {
							delete process.env["CONDUIT_CODEX_APP_SERVER_TRACE_GATE"];
						}),
				);
				const events: ProviderRuntimeEvent[] = [];
				const started = yield* Deferred.make<void>();
				const ended = yield* Deferred.make<void>();
				const wakeEnded = yield* Deferred.make<void>();
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
							if (output.type !== "event") return {};
							events.push(output.event);
							if (output.event.type === "run.started")
								yield* Deferred.succeed(started, undefined);
							if (output.event.type === "turn.completed")
								yield* Deferred.succeed(
									events.filter(({ type }) => type === "turn.completed")
										.length > 1
										? wakeEnded
										: ended,
									undefined,
								);
							return {};
						}),
				);
				const admission = yield* makeRunnerAdmission(runner, "codex");
				const send = (inputId: string, runId: string, prompt: string) =>
					admitRunnerCommand(admission, runner, {
						type: "send-turn",
						sinkId: inputId,
						aborted: false,
						input: {
							sessionId: "session",
							inputId,
							runId,
							prompt,
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
					});
				const turn = yield* send("input", "run", "Say hello").pipe(
					Effect.forkScoped,
				);
				yield* Deferred.await(started);
				const steering = yield* send(
					"steer",
					"run-steer",
					variant.prompt ?? "Use the steered instruction",
				).pipe(Effect.forkScoped);
				const joins = () =>
					events.filter(
						({ type, data }) =>
							type === "run.started" &&
							typeof data === "object" &&
							data !== null &&
							"requestedRunId" in data &&
							data.requestedRunId === "run-steer",
					);
				if (variant.readsReply) {
					expect(yield* Fiber.join(steering)).toMatchObject({
						status: "accepted",
					});
					// The reply only places the steer: no join before its echo.
					expect(joins()).toEqual([]);
				} else yield* Deferred.await(ended);
				writeFileSync(gate, String(Number.MAX_SAFE_INTEGER));
				expect(yield* Fiber.join(steering)).toMatchObject({
					status: "accepted",
				});
				yield* Fiber.join(turn);
				yield* Deferred.await(ended);
				// The steer's own Run ends at the terminal of the turn that ran it, and no other.
				if (variant.wake) {
					yield* Deferred.await(wakeEnded);
					expect(
						events.filter(({ type }) => type === "turn.completed").at(-1)
							?.runId,
					).toBe(variant.starts);
				}
				expect(joins()).toEqual(
					variant.starts
						? [
								expect.objectContaining({
									runId: variant.starts,
									data: expect.objectContaining({
										inputId: "steer",
										requestedRunId: "run-steer",
									}),
								}),
							]
						: [],
				);
				// The closed run takes nothing after its terminal but the turn's own idle status.
				expect(
					events
						.slice(
							events.findIndex(({ type }) => type === "turn.completed") + 1,
						)
						.filter(
							({ runId, type }) => runId === "run" && type !== "session.status",
						),
				).toEqual([]);
			}),
		);

	// J3: the item/started echo is the join, by its clientId alone. Codex sends each userMessage as
	// item/started and item/completed; the tagged echo joins its steer once (110), and an untagged
	// copy on the same turn joins neither steer (108), though both replies named that turn.
	it.live(
		"one tagged echo joins its steer once and an untagged one joins none",
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-runner-echo-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const rows: {
					at: number;
					message?: {
						id?: number;
						method?: string;
						params?: Record<string, unknown> & {
							item?: Record<string, unknown>;
						};
					};
				}[] = readFileSync(
					fileURLToPath(
						new URL(
							"../../../fixtures/codex-app-server-traces/steer.jsonl",
							import.meta.url,
						),
					),
					"utf8",
				)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const request = rows.findIndex(
					({ message }) => message?.method === "turn/steer",
				);
				const reply = rows.findIndex(
					({ message }) => message?.id === 4 && message.method === undefined,
				);
				const second = [
					{
						...rows[request],
						message: {
							...rows[request]?.message,
							id: 5,
							params: {
								...rows[request]?.message?.params,
								clientUserMessageId: "fixture-steer-2",
							},
						},
					},
					{ ...rows[reply], message: { ...rows[reply]?.message, id: 5 } },
				];
				const kept = rows.flatMap((row, index) => {
					if (index === reply) return [row, ...second];
					const item = row.message?.params?.item;
					if (item?.["clientId"] !== "fixture-steer" || !row.message?.params)
						return [row];
					const { clientId: _clientId, ...rest } = item;
					return [
						row,
						{
							...row,
							message: {
								...row.message,
								params: {
									...row.message.params,
									item: { ...rest, id: `${String(rest["id"])}-untagged` },
								},
							},
						},
					];
				});
				const trace = join(root, "steer.jsonl");
				writeFileSync(
					trace,
					`${kept.map((row) => JSON.stringify(row)).join("\n")}\n`,
				);
				const events: ProviderRuntimeEvent[] = [];
				const started = yield* Deferred.make<void>();
				const ended = yield* Deferred.make<void>();
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
							if (output.type !== "event") return {};
							events.push(output.event);
							if (output.event.type === "run.started")
								yield* Deferred.succeed(started, undefined);
							if (output.event.type === "turn.completed")
								yield* Deferred.succeed(ended, undefined);
							return {};
						}),
				);
				const admission = yield* makeRunnerAdmission(runner, "codex");
				const send = (inputId: string, runId: string, prompt: string) =>
					admitRunnerCommand(admission, runner, {
						type: "send-turn",
						sinkId: inputId,
						aborted: false,
						input: {
							sessionId: "session",
							inputId,
							runId,
							prompt,
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
					});
				const turn = yield* send("input", "run", "Say hello").pipe(
					Effect.forkScoped,
				);
				yield* Deferred.await(started);
				expect(
					yield* send("steer", "run-steer", "Use the steered instruction"),
				).toMatchObject({ status: "accepted" });
				expect(
					yield* send("steer-2", "run-steer-2", "Use the steered instruction"),
				).toMatchObject({ status: "accepted" });
				yield* Fiber.join(turn);
				yield* Deferred.await(ended);
				expect(
					events.flatMap(({ type, runId, data }) =>
						type === "run.started" &&
						typeof data === "object" &&
						data !== null &&
						"requestedRunId" in data
							? [`${runId} ${String(data.requestedRunId)}`]
							: [],
					),
				).toEqual(["run run", "run run-steer"]);
			}),
	);
});
