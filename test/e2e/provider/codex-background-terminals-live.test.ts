// Box 1 of 82tn.32.28 against the real Codex app-server (codex-cli on PATH, or CONDUIT_CODEX_BINARY).
// Opt in with CONDUIT_CODEX_LIVE=1. A scripted Responses API stands in for the model, so the turn
// is the same every run: it starts `sleep 300` and yields, leaving a real background terminal that
// Codex owns. How it could fail: the terminal is never listed; Stop tasks never reaches terminate;
// the terminal stays listed after it was terminated; the late finish shows an error or a second Run.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 120_000;

/** One Responses API stream: a model turn that calls exec_command, or one that replies in text. */
const stream = (n: number, call?: Record<string, unknown>) => {
	const item = call
		? {
				type: "function_call",
				id: `fc_${n}`,
				call_id: `call_bg_${n}`,
				name: "exec_command",
				arguments: JSON.stringify(call),
			}
		: {
				id: `msg_${n}`,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "STARTED", annotations: [] }],
			};
	return [
		{ type: "response.created", response: { id: `resp_${n}` } },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: `resp_${n}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
};

describe.skipIf(process.env["CONDUIT_CODEX_LIVE"] !== "1")(
	"Codex background terminals against the real app-server",
	() => {
		// test-waits-allow timeout-override: the real app-server starts, runs a turn and a stop on the wall clock.
		it(
			"lists a background terminal, terminates it through Stop tasks, and the list empties",
			{ timeout: 360_000 },
			async () => {
				const artifacts = resolve(
					"test-results/codex-background-terminals-live",
				);
				mkdirSync(artifacts, { recursive: true });
				const root = mkdtempSync(join(artifacts, "run-"));
				const codexHome = join(root, "codex-home");
				mkdirSync(codexHome, { recursive: true });
				const capturePath = join(root, "app-server.jsonl");
				const replies = [
					stream(1, { cmd: "sleep 300", login: false, yield_time_ms: 500 }),
					stream(2),
				];
				let served = 0;
				const server = createServer((request, response) => {
					request.resume();
					request.on("end", () => {
						const events = replies[served++] ?? stream(served);
						response.writeHead(200, { "content-type": "text/event-stream" });
						for (const event of events)
							response.write(
								`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
							);
						response.end();
					});
				});
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const { port } = server.address() as AddressInfo;
				writeFileSync(
					join(codexHome, "config.toml"),
					`model_provider = "scripted"

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
				// An API-key login: Codex reports an account, and the scripted provider ignores it.
				writeFileSync(
					join(codexHome, "auth.json"),
					JSON.stringify({
						auth_mode: "apikey",
						OPENAI_API_KEY: "sk-scripted",
					}),
				);
				const evidence: Record<string, unknown> = { capturePath };
				const harness = ProcessHarness.create({
					dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				});
				let sessionId: string | undefined;
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
				/** Each list or terminate request with Codex's answer, in order. */
				const calls = (method: string) => {
					const rows = captured();
					return rows
						.filter(
							(row) => row.dir === "out" && row.message?.method === method,
						)
						.map((row) => ({
							params: row.message?.params,
							result: rows.find(
								(reply) =>
									reply.dir === "in" &&
									reply.message?.id === row.message?.id &&
									!reply.message?.method,
							)?.message?.result,
						}));
				};
				const ledger = (id: string) => {
					const db = new Database(harness.daemonStorePath(), {
						readonly: true,
					});
					try {
						return {
							runs: db
								.prepare(
									"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
								)
								.all(id),
							errors: db
								.prepare(
									"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.error', 'session.error')",
								)
								.all(id),
							snapshots: (
								db
									.prepare(
										"SELECT json_extract(data, '$.tasks') AS tasks FROM events WHERE session_id = ? AND type = 'evidence.tasks_snapshot' ORDER BY sequence",
									)
									.all(id) as { tasks: string }[]
							).map(({ tasks }) => JSON.parse(tasks) as unknown[]),
							outbox: db
								.prepare(
									"SELECT status, json_extract(payload_json, '$.effect.key.taskId') AS taskId FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'stop_task'",
								)
								.all(id),
						};
					} finally {
						db.close();
					}
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
					evidence["catalog"] = catalog["providers"];
					evidence["account"] = (await browser.instances()).instances.find(
						({ id }) => id === addedInstanceId,
					);
					if (!modelId) throw new Error("Codex listed no models");
					sessionId = await browser.createSession(
						"Codex background terminal",
						addedInstanceId,
						"codex",
						{ modelId, contextWindow: "", permissionMode: "full" },
					);
					const id = sessionId;
					await browser.followSession(id);
					const reply = await browser.send(
						id,
						"Start a background sleep.",
						TIMEOUT,
					);
					expect(reply.chunks.join("")).toContain("STARTED");
					const row = (predicate: (tasks: unknown) => boolean, cursor = 0) =>
						browser.waitFor(
							(message) =>
								message["type"] === "session_row" &&
								message["id"] === id &&
								"workspaceHint" in message &&
								predicate(message["backgroundTasks"]),
							cursor,
							TIMEOUT,
						);
					const listed = await row(
						(tasks) => Array.isArray(tasks) && tasks.length === 1,
					);
					evidence["listed"] = {
						row: listed["backgroundTasks"],
						list: calls("thread/backgroundTerminals/list").at(-1),
					};
					expect(listed["backgroundTasks"]).toEqual([
						expect.objectContaining({
							type: "local_bash",
							kind: "shell",
							description: expect.stringContaining("sleep 300"),
						}),
					]);
					const cursor = browser.frames.length;
					expect(
						await Effect.runPromise(
							browser.rpc.StopTasks({ sessionId: id, tasks: "all" }),
						),
					).toEqual({ ok: true });
					const emptied = await row((tasks) => tasks === undefined, cursor);
					// test-waits-allow polling: the late finish reaches only the app-server capture.
					await vi.waitFor(
						() =>
							expect(
								captured().some(
									(row) =>
										row.message?.method === "item/completed" &&
										(row.message.params?.["item"] as { id?: string })?.id ===
											"call_bg_1",
								),
							).toBe(true),
						{ timeout: TIMEOUT },
					);
					const terminate = calls("thread/backgroundTerminals/terminate");
					const lists = calls("thread/backgroundTerminals/list");
					const stored = ledger(id);
					Object.assign(evidence, {
						emptied: emptied["backgroundTasks"] ?? null,
						terminate,
						lists,
						lateFinish: captured().find(
							(row) =>
								row.message?.method === "item/completed" &&
								(row.message.params?.["item"] as { id?: string })?.id ===
									"call_bg_1",
						)?.message?.params,
						...stored,
					});
					expect(terminate).toEqual([
						{
							params: {
								threadId: expect.any(String),
								processId: expect.any(String),
							},
							result: { terminated: true },
						},
					]);
					expect(lists.at(-1)?.result).toEqual({ data: [], nextCursor: null });
					expect(stored.runs).toEqual([
						expect.objectContaining({ status: "completed" }),
					]);
					expect(stored.errors).toEqual([]);
					expect(stored.outbox).toEqual([
						expect.objectContaining({ status: "completed" }),
					]);
					evidence["completed"] = true;
				} catch (error) {
					evidence["failure"] =
						error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					await harness.dispose();
					server.close();
					evidence["process"] = harness.proof();
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/82tn-32-28-codex-live.json",
						`${JSON.stringify({ ticket: "conduit-test-82tn.32.28", box: 1, ...evidence }, null, 2)}\n`,
					);
					expect(harness.remainingRunnerPids()).toEqual([]);
				}
			},
		);
	},
);
