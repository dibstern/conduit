/**
 * Codex goals against the real app-server (82tn.32.27; CONTRACT.md 8.6). A scripted Responses API
 * stands in for the model and holds a reply open, so each goal action lands mid-turn.
 * How it could fail (lane 3227 audit 2, 3, 4, 5, 9, 11, 12, 20, 24): PauseGoal or ResumeGoal stays
 * refused for Codex; a Pause interrupts the turn, or a continuation starts after it; Resume sends a
 * host turn; the Paused or Cleared note outlives the turn; Clear ends the turn; Stop pauses the
 * goal or Codex continues after it; a model-driven complete does not show Met; a goal action
 * terminates background terminals.
 *
 * pnpm build
 * CONDUIT_CODEX_LIVE=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/codex-goals-live.test.ts
 * Leaves test-results/82tn-32-27-codex-goals-live.json and the app-server capture beside it.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 120_000;
const EVIDENCE = "test-results/82tn-32-27-codex-goals-live.json";

type Reply = { readonly text: string; readonly hold?: Promise<void> } | "done";
type Row = Record<string, unknown> & {
	goalPhase?: {
		tag: string;
		action?: { kind: string };
		send?: string;
		status?: { tag: string; limit?: string };
	};
	goalState?: {
		goal?: unknown;
		ended?: string;
		pausedReason?: string;
		limit?: string;
		turnFinishing?: boolean;
	};
	processing?: boolean;
};

const item = (n: number, text: string) => ({
	id: `msg_${n}`,
	type: "message",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const toolItem = (n: number) => ({
	type: "function_call",
	id: `fc_${n}`,
	call_id: `call_goal_${n}`,
	name: "update_goal",
	arguments: JSON.stringify({ status: "complete" }),
});

/** What the session bar shows: the pending action's verb, else the confirmed status and its note. */
const shown = (row: Row) => {
	const phase = row.goalPhase;
	if (phase?.tag === "Pending") return `${phase.action?.kind}:${phase.send}`;
	// A confirmed status with nothing pending rides the row's goal state.
	const facts = row.goalState;
	const tag =
		phase?.status?.tag ??
		(facts?.goal
			? facts.limit
				? "Limited"
				: facts.pausedReason
					? "Paused"
					: "Active"
			: facts?.ended === "met"
				? "Met"
				: "Cleared");
	const limit =
		phase?.status?.tag === "Limited" ? phase.status.limit : facts?.limit;
	return `${tag}${limit ? `(${limit})` : ""}${facts?.turnFinishing ? ", finishing turn" : ""}`;
};

describe.skipIf(process.env["CONDUIT_CODEX_LIVE"] !== "1")(
	"Codex goals against the real app-server",
	() => {
		// test-waits-allow timeout-override: three goal phases on the real app-server, on the wall clock.
		it(
			"pauses and resumes, clears mid-turn and keeps the goal through Stop",
			{ timeout: 600_000 },
			async () => {
				const artifacts = resolve("test-results/codex-goals-live");
				mkdirSync(artifacts, { recursive: true });
				const root = mkdtempSync(join(artifacts, "run-"));
				const codexHome = join(root, "codex-home");
				mkdirSync(codexHome, { recursive: true });
				const capturePath = join(root, "app-server.jsonl");
				const script: Reply[] = [];
				const requests: { n: number; lastInput: string }[] = [];
				let served = 0;
				const server = createServer((request, response) => {
					const body: Buffer[] = [];
					request.on("data", (chunk: Buffer) => body.push(chunk));
					request.on("end", () => {
						const n = ++served;
						const input = (
							JSON.parse(Buffer.concat(body).toString() || "{}") as {
								input?: unknown[];
							}
						).input;
						requests.push({
							n,
							lastInput: JSON.stringify(input?.at(-1) ?? null).slice(0, 400),
						});
						const reply = script.shift() ?? { text: `IDLE-${n}` };
						const output =
							reply === "done" ? [toolItem(n)] : [item(n, reply.text)];
						const write = (event: Record<string, unknown>) =>
							response.destroyed ||
							response.write(
								`event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`,
							);
						response.writeHead(200, { "content-type": "text/event-stream" });
						write({ type: "response.created", response: { id: `resp_${n}` } });
						void (async () => {
							if (reply !== "done") await reply.hold;
							for (const [index, done] of output.entries())
								write({
									type: "response.output_item.done",
									output_index: index,
									item: done,
								});
							write({
								type: "response.completed",
								response: {
									id: `resp_${n}`,
									status: "completed",
									output,
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							});
							response.end();
						})();
					});
				});
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const { port } = server.address() as AddressInfo;
				writeFileSync(
					join(codexHome, "config.toml"),
					`model_provider = "scripted"

[features]
goals = true

[model_providers.scripted]
name = "Scripted Responses API"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
				);
				writeFileSync(
					join(codexHome, "auth.json"),
					JSON.stringify({
						auth_mode: "apikey",
						OPENAI_API_KEY: "sk-scripted",
					}),
				);
				/** A reply held open until released: the goal action lands mid-turn. */
				const held = (text: string) => {
					let release = () => {};
					const hold = new Promise<void>((done) => {
						release = done;
					});
					script.push({ text, hold });
					const reached = served + script.length;
					return { release, reached };
				};
				const evidence: Record<string, unknown> = {
					ticket: "conduit-test-82tn.32.27",
					capturePath,
					outcome: "failed",
				};
				const harness = ProcessHarness.create({
					dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				});
				const captured = () =>
					readFileSync(capturePath, "utf8")
						.split("\n")
						.filter((line) => line.trim() !== "")
						.map(
							(line) =>
								JSON.parse(line) as {
									dir: string;
									message?: {
										id?: number;
										method?: string;
										params?: Record<string, unknown>;
										result?: unknown;
									};
								},
						);
				/** The goal and turn requests conduit sent from a capture row on, with Codex's answers. */
				const sentFrom = (from: number) => {
					const rows = captured();
					return rows
						.slice(from)
						.filter(
							(row) =>
								row.dir === "out" &&
								/^(thread\/goal\/|turn\/|thread\/backgroundTerminals\/terminate)/.test(
									row.message?.method ?? "",
								),
						)
						.map((row) => ({
							method: row.message?.method,
							params: row.message?.params,
							result: rows.find(
								(reply) =>
									reply.dir === "in" &&
									reply.message?.id === row.message?.id &&
									!reply.message?.method,
							)?.message?.result,
						}));
				};
				let stepsSoFar: () => unknown = () => undefined;
				const quiet = async (ms: number) => {
					const before = served;
					// test-waits-allow real-wait: a continuation would reach the scripted model within this window.
					await new Promise((done) => setTimeout(done, ms));
					return served - before;
				};
				try {
					await harness.restart({
						startupTimeoutMs: TIMEOUT,
						runnerStartupTimeoutMs: TIMEOUT,
						serviceEnvironment: {
							CONDUIT_CODEX_APP_SERVER_TRACE: "",
							CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
							...(process.env["CONDUIT_CODEX_BINARY"]
								? { CONDUIT_CODEX_BINARY: process.env["CONDUIT_CODEX_BINARY"] }
								: {}),
						},
					});
					const { addedInstanceId } = await harness.requestRpc({
						_tag: "AddInstance",
						name: "Codex scripted model",
						driver: "codex",
						configDir: codexHome,
					});
					if (!addedInstanceId) throw new Error("Missing Codex account");
					const browser = await harness.connect();
					await browser.followSessions();
					const catalogCursor = browser.frames.length;
					await browser.getModels(addedInstanceId);
					const catalog = await browser.waitFor(
						(message) =>
							message["type"] === "project_setting" &&
							message["_tag"] === "providerModels" &&
							message["accountId"] === addedInstanceId,
						catalogCursor,
					);
					const modelId = (catalog["providers"] as ProviderInfo[])[0]?.models[0]
						?.id;
					if (!modelId) throw new Error("Codex listed no models");
					const id = await browser.createSession(
						"Codex goals",
						addedInstanceId,
						"codex",
						{ modelId, contextWindow: "", permissionMode: "full" },
					);
					evidence["sessionId"] = id;
					await browser.followSession(id);
					const isRow = (message: Record<string, unknown>): message is Row =>
						message["type"] === "session_row" &&
						message["id"] === id &&
						"workspaceHint" in message;
					const row = (predicate: (row: Row) => boolean, cursor: number) =>
						browser.waitFor(
							(message) => isRow(message) && predicate(message),
							cursor,
							TIMEOUT,
						) as Promise<Row>;
					const steps = (cursor: number) =>
						browser.frames
							.slice(cursor)
							.map(({ message }) => message)
							.filter(isRow)
							.map((message) => ({
								shown: shown(message),
								processing: message.processing === true,
							}))
							.filter(
								(step, index, all) =>
									index === 0 ||
									step.shown !== all[index - 1]?.shown ||
									step.processing !== all[index - 1]?.processing,
							);
					stepsSoFar = () => steps(0);
					const rpc = <A>(effect: Effect.Effect<A, unknown>) =>
						Effect.runPromise(effect);
					const reach = async (n: number) => {
						while (served < n)
							// test-waits-allow real-wait: the scripted model sees the held request arrive.
							await new Promise((done) => setTimeout(done, 50));
					};
					/** Sets a goal; Codex either starts its turn itself or the send below does. */
					const goalTurn = async (condition: string, text: string) => {
						const hold = held(text);
						const at = captured().length;
						expect(
							await rpc(
								browser.rpc.SetGoal({
									sessionId: id,
									commandId: randomUUID(),
									condition,
								}),
							),
						).toEqual({ ok: true });
						// test-waits-allow polling: Codex either starts a turn for the goal or stays idle.
						const deadline = Date.now() + 3_000;
						const started = () =>
							captured()
								.slice(at)
								.some((row) => row.message?.method === "turn/started");
						while (Date.now() < deadline && !started())
							// test-waits-allow real-wait: Codex's own turn start reaches only the app-server capture.
							await new Promise((done) => setTimeout(done, 50));
						const selfStarted = started();
						const sent = selfStarted
							? undefined
							: browser.send(id, `Work on: ${condition}`, TIMEOUT);
						await reach(hold.reached);
						return { ...hold, selfStarted, sent, at };
					};

					// A first send launches Codex; goal actions need its live thread.
					script.push({ text: "HELLO" });
					expect(
						(await browser.send(id, "Say hello.", TIMEOUT)).chunks.join(""),
					).toContain("HELLO");

					// Phase A: Pause mid-turn, then Resume from idle.
					const a = await goalTurn("Finish task A", "WORKING-A");
					evidence["selfStartedOnSet"] = a.selfStarted;
					const pauseAt = browser.frames.length;
					expect(
						await rpc(
							browser.rpc.PauseGoal({ sessionId: id, commandId: randomUUID() }),
						),
					).toEqual({ ok: true });
					await row(
						(message) =>
							shown(message) === "Paused, finishing turn" &&
							message.processing === true,
						pauseAt,
					);
					a.release();
					await a.sent;
					await row(
						(message) =>
							shown(message) === "Paused" && message.processing !== true,
						pauseAt,
					);
					const afterPause = await quiet(5_000);
					evidence["pause"] = {
						steps: steps(pauseAt),
						continuationRequests: afterPause,
						sent: sentFrom(a.at),
					};
					expect(afterPause).toBe(0);

					script.push("done", { text: "DONE-A" });
					const resumeAt = browser.frames.length;
					const resumeCapture = captured().length;
					expect(
						await rpc(
							browser.rpc.ResumeGoal({
								sessionId: id,
								commandId: randomUUID(),
							}),
						),
					).toEqual({ ok: true });
					await row(
						(message) =>
							shown(message) === "Met" && message.processing !== true,
						resumeAt,
					);
					const resumeSent = sentFrom(resumeCapture);
					evidence["resume"] = { steps: steps(resumeAt), sent: resumeSent };
					expect(resumeSent.map(({ method }) => method)).not.toContain(
						"turn/start",
					);
					expect(resumeSent[0]).toEqual(
						expect.objectContaining({
							method: "thread/goal/set",
							params: expect.objectContaining({ status: "active" }),
						}),
					);
					expect(
						resumeSent[0]?.params && "objective" in resumeSent[0].params,
					).toBe(false);

					// Phase B: Clear mid-turn.
					const b = await goalTurn("Finish task B", "WORKING-B");
					const clearAt = browser.frames.length;
					expect(
						await rpc(
							browser.rpc.ClearGoal({ sessionId: id, commandId: randomUUID() }),
						),
					).toEqual({ ok: true });
					await row(
						(message) =>
							shown(message) === "Cleared, finishing turn" &&
							message.processing === true,
						clearAt,
					);
					b.release();
					await b.sent;
					await row(
						(message) =>
							shown(message) === "Cleared" && message.processing !== true,
						clearAt,
					);
					const afterClear = await quiet(5_000);
					evidence["clear"] = {
						steps: steps(clearAt),
						continuationRequests: afterClear,
						sent: sentFrom(b.at),
					};
					expect(afterClear).toBe(0);

					// Phase C: Stop interrupts the turn and leaves the goal active; Codex starts no
					// continuation after an interrupt (as goal-interrupt.jsonl recorded).
					const c = await goalTurn("Finish task C", "WORKING-C");
					const stopAt = browser.frames.length;
					const stopCapture = captured().length;
					await rpc(
						browser.rpc.CancelSession({
							sessionId: id,
							commandId: randomUUID(),
						}),
					);
					c.release();
					await c.sent?.catch(() => undefined);
					await row(
						(message) =>
							shown(message) === "Active" && message.processing !== true,
						stopAt,
					);
					const afterStop = await quiet(5_000);
					const stopSent = sentFrom(stopCapture);
					evidence["stop"] = {
						steps: steps(stopAt),
						sent: stopSent,
						continuationRequests: afterStop,
					};
					expect(stopSent.map(({ method }) => method)).toContain(
						"turn/interrupt",
					);
					expect(
						stopSent.filter(({ method }) => method?.startsWith("thread/goal/")),
					).toEqual([]);
					expect(
						steps(stopAt).map(({ shown: label }) => label),
					).not.toContainEqual(expect.stringMatching(/^(Paused|Cleared)/));
					expect(afterStop).toBe(0);

					const db = new Database(harness.daemonStorePath(), {
						readonly: true,
					});
					try {
						evidence["runs"] = db
							.prepare(
								"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
							)
							.all(id);
						// A turn Codex starts itself is a wake Run: its start and end evidence (8.6).
						evidence["wakes"] = db
							.prepare(
								"SELECT sequence, type FROM events WHERE session_id = ? AND type LIKE 'evidence.turn_%' ORDER BY sequence",
							)
							.all(id);
						evidence["errors"] = db
							.prepare(
								"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.error', 'session.error')",
							)
							.all(id);
					} finally {
						db.close();
					}
					expect(evidence["errors"]).toEqual([]);
					// Each self-started turn shows as a wake that starts and ends.
					const wakes = evidence["wakes"] as { type: string }[];
					expect(
						wakes.filter(({ type }) => type === "evidence.turn_started").length,
					).toBeGreaterThanOrEqual(1);
					expect(
						wakes.filter(({ type }) => type === "evidence.turn_ended").length,
					).toBe(
						wakes.filter(({ type }) => type === "evidence.turn_started").length,
					);
					expect(
						sentFrom(0).filter(
							({ method }) => method === "thread/backgroundTerminals/terminate",
						),
					).toEqual([]);
					evidence["requests"] = requests;
					evidence["outcome"] = "passed";
				} catch (error) {
					evidence["failure"] =
						error instanceof Error ? error.message : String(error);
					evidence["requests"] = requests;
					evidence["rows"] = stepsSoFar();
					try {
						const db = new Database(harness.daemonStorePath(), {
							readonly: true,
						});
						evidence["goalEvents"] = db
							.prepare(
								"SELECT sequence, type, data FROM events WHERE type IN ('session.goal_changed', 'evidence.command_receipt', 'evidence.turn_started', 'evidence.turn_ended', 'turn.completed', 'turn.interrupted') ORDER BY sequence",
							)
							.all();
						db.close();
					} catch (cause) {
						evidence["goalEvents"] = String(cause);
					}
					throw error;
				} finally {
					await harness.dispose();
					server.close();
					evidence["process"] = harness.proof();
					mkdirSync("test-results", { recursive: true });
					writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
					const scratch = process.env["LANE_EVIDENCE_DIR"];
					if (scratch) {
						copyFileSync(
							EVIDENCE,
							join(scratch, "82tn-32-27-codex-goals-live.json"),
						);
						copyFileSync(
							capturePath,
							join(scratch, "82tn-32-27-codex-goals-live.jsonl"),
						);
					}
					expect(harness.remainingRunnerPids()).toEqual([]);
				}
			},
		);
	},
);
