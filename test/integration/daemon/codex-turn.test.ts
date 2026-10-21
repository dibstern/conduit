// Failure modes: dropped or duplicated text, hidden reasoning, missing context
// usage, malformed notifications aborting a turn, a second thread per turn,
// and deleted accounts reappearing after a daemon restart.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import type { HistoryMessagePart } from "../../../src/lib/shared-types.js";
import {
	codexModels,
	fixtureRows,
	rows,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const TEXT = "Hello from the mock model.";
const MODEL = "gpt-6.1-sol";

describe("Codex turns through the real daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let artifactRoot = "";
	let tracePath = "";
	let reportPath = "";
	let capturePath = "";
	let gatePath = "";
	let evidence: Record<string, unknown> = {};

	function writeTrace(trace: TraceRow[]) {
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	async function start(name: string, discovery = "model-list", gated = false) {
		artifactRoot = resolve(`test-results/codex-turn/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		capturePath = join(artifactRoot, "capture.jsonl");
		writeFileSync(reportPath, "");
		evidence = { scenario: name };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "codex-replay.jsonl");
		gatePath = gated ? join(harness.root, "codex-replay-gate") : "";
		if (gatePath) writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const trace = fixtureRows(discovery);
		if (discovery === "model-list") {
			// The isolated recorder has no login. Derive only the account status;
			// catalog pages and all turn notifications remain captured wire data.
			const account = trace.find(
				(row) => row.message?.result?.["account"] === null,
			);
			if (!account?.message?.result)
				throw new Error("No recorded account/read");
			account.message.result["account"] = {
				type: "chatgpt",
				email: "codex-replay@example.test",
				planType: "plus",
			};
			account.message.result["requiresOpenaiAuth"] = true;
		}
		writeTrace(trace);
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath || undefined,
			},
		};
		await harness.restart(restartOptions);
		return {
			fixture: harness,
			browser: await harness.connect(),
			restartOptions,
		};
	}

	async function startTurn(name: string, source = name, gated = false) {
		const { fixture, browser } = await start(name, "model-list", gated);
		const accounts = await vi.waitFor(
			async () => {
				const found = (await browser.instances()).instances.filter(
					({ driver }) => driver === "codex",
				);
				expect(found).toHaveLength(1);
				return found;
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
		const account = accounts[0];
		if (!account) throw new Error("Signed-in Codex account was not auto-added");
		expect(account).toMatchObject({ name: "Codex", available: true });
		expect(await codexModels(browser, account.id)).toContainEqual(
			expect.objectContaining({ id: MODEL, provider: "codex" }),
		);
		sessionId = await browser.createSession(name, account.id, "codex", {
			modelId: MODEL,
			contextWindow: "",
			permissionMode:
				source === "turn-command" || source === "turn-file-change"
					? "full"
					: "ask",
		});
		writeTrace(fixtureRows(source));
		if (gatePath) writeFileSync(gatePath, "0");
		return { fixture, browser, id: sessionId };
	}

	async function expectTurns(fixture: ProcessHarness, id: string, count = 1) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
					Array.from({ length: count }, () => "completed"),
				),
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		if (gatePath) writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		const runnerLogPath = join(fixture.configDir, "runners.log");
		const runnerLog = existsSync(runnerLogPath)
			? readFileSync(runnerLogPath, "utf8")
			: "";
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			evidence["traceReports"] = reports;
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			writeFileSync(
				join(artifactRoot, "events.json"),
				`${JSON.stringify(state ?? {}, null, 2)}\n`,
			);
			writeFileSync(join(artifactRoot, "runners.log"), runnerLog);
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify({ ...evidence, result: task.result?.state, process: fixture.proof() }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
			gatePath = "";
		}
	});

	it(
		"basic",
		async () => {
			const { fixture, browser, id } = await startTurn("basic");
			const reply = await browser.send(id, "Say hello", TIMEOUT);
			expect(reply.chunks.join("")).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) => type === "text.delta").length,
			).toBeGreaterThan(1);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "thinking.start" }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "thinking.delta",
					data: expect.objectContaining({
						text: "I will answer the greeting directly.",
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "thinking.end" }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "turn.completed",
					data: expect.objectContaining({
						tokens: expect.objectContaining({
							input: 19,
							output: 13,
							contextWindow: 258400,
						}),
						contextTokens: 19,
					}),
				}),
			);
			const history = await browser.history(id);
			expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
				expect.objectContaining({
					type: "thinking",
					text: "I will answer the greeting directly.",
				}),
			);
			expect(events.filter(({ type }) => type === "turn.error")).toEqual([]);
			// The userMessage item echoes the prompt conduit already stored.
			expect(events.filter(({ type }) => type === "tool.started")).toEqual([]);
			const request = rows<TraceRow>(capturePath).find(
				({ dir, message }) => dir === "out" && message?.method === "turn/start",
			)?.message?.params;
			expect(request).toMatchObject({
				model: MODEL,
				effort: "low",
				summary: "detailed",
				approvalPolicy: "untrusted",
				sandboxPolicy: { type: "readOnly" },
				approvalsReviewer: "user",
				collaborationMode: {
					mode: "default",
					settings: {
						model: MODEL,
						reasoning_effort: "low",
						developer_instructions: null,
					},
				},
				input: [expect.objectContaining({ type: "text", text: "Say hello" })],
			});
		},
		TIMEOUT * 2,
	);

	it.each(["compact-manual", "compact-auto", "compact-failed"])(
		"maps %s through the compaction transcript and settles once",
		async (scenario) => {
			const { fixture, browser, id } = await startTurn(
				scenario,
				scenario,
				true,
			);
			let compacting = false;
			expect(
				(await Effect.runPromise(browser.rpc.GetCommands({ sessionId: id })))
					.commands,
			).toContainEqual(expect.objectContaining({ name: "compact" }));
			writeTrace(
				fixtureRows(scenario).map((row) => {
					const at = compacting ? 1 : 0;
					if (
						row.message?.method === "item/started" &&
						(row.message.params?.["item"] as { type?: string })?.type ===
							"contextCompaction"
					)
						compacting = true;
					return { ...row, at };
				}),
			);
			const sending = browser.send(
				id,
				scenario === "compact-auto" ? "Say hello" : "  /compact\n",
				TIMEOUT,
			);
			try {
				await browser.waitFor(
					(message) =>
						JSON.stringify(message).includes("Compacting conversation…"),
					0,
					TIMEOUT,
				);
				expect(
					(await browser.history(id))
						.flatMap(({ parts }) => parts ?? [])
						.filter((part) => part.type === "compaction"),
				).toEqual([]);
			} finally {
				writeFileSync(gatePath, "1");
				await sending;
			}
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: scenario === "compact-failed" ? "error" : "completed" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const { events } = snapshot(fixture, id);
			expect(
				events.filter(({ type }) =>
					["turn.completed", "turn.error", "turn.interrupted"].includes(type),
				),
			).toHaveLength(1);
			const parts = (await browser.history(id))
				.flatMap(({ parts }) => parts ?? [])
				.filter((part) => part.type === "compaction");
			expect(parts).toHaveLength(1);
			expect(JSON.stringify(parts)).toContain(
				scenario === "compact-failed"
					? "Fixture compaction failed"
					: scenario === "compact-auto"
						? "Context compacted (auto)"
						: "Context compacted",
			);
			if (scenario === "compact-failed") {
				const native = rows<TraceRow>(capturePath).find(
					({ message }) => message?.method === "turn/completed",
				)?.message?.params?.["turn"] as { error: { message: string } };
				expect(parts[0]?.text).toContain(native.error.message);
			}
			expect(
				events.filter(
					({ type, data }) =>
						type === "tool.started" &&
						(scenario !== "compact-auto" ||
							data["toolName"] === "contextCompaction"),
				),
			).toEqual([]);
			const methods = rows<TraceRow>(capturePath)
				.filter(({ dir }) => dir === "out")
				.map(({ message }) => message?.method);
			if (scenario !== "compact-auto") {
				const capture = rows<TraceRow>(capturePath);
				const thread = capture.find(
					({ message }) => message?.method === "thread/started",
				)?.message?.params?.["thread"] as { id: string };
				expect(
					capture.find(
						({ dir, message }) =>
							dir === "out" && message?.method === "thread/compact/start",
					)?.message?.params,
				).toEqual({ threadId: thread.id });
			}
			expect(
				methods.filter((method) => method === "thread/compact/start"),
			).toHaveLength(scenario === "compact-auto" ? 0 : 1);
			expect(methods.filter((method) => method === "turn/start")).toHaveLength(
				scenario === "compact-auto" ? 1 : 0,
			);
		},
		TIMEOUT * 2,
	);

	it(
		"runs /compact as a native command after declining a steer",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"compact-while-busy",
				"basic",
				true,
			);
			const basic = fixtureRows("basic");
			const started = basic.find(
				(row) => row.message?.method === "turn/started",
			)?.message?.params;
			if (!started) throw new Error("Missing recorded turn start");
			const compact = fixtureRows("compact-manual");
			const compactStart = compact.findIndex(
				(row) => row.message?.method === "thread/compact/start",
			);
			const delta = basic.findIndex(
				(row) => row.message?.method === "item/agentMessage/delta",
			);
			const terminal = basic.find(
				(row) => row.message?.method === "turn/completed",
			);
			if (!terminal?.message?.params) throw new Error("Missing terminal");
			const turn = terminal.message.params["turn"] as Record<string, unknown>;
			terminal.message.params["turn"] = {
				...turn,
				status: "interrupted",
				items: [],
			};
			writeTrace([
				...basic.slice(0, delta + 1).map((row) => ({ ...row, at: 0 })),
				{
					dir: "out",
					at: 0,
					message: {
						id: 99,
						method: "turn/interrupt",
						params: { threadId: started["threadId"], turnId: turn["id"] },
					},
				},
				{ dir: "in", at: 0, message: { id: 99, result: {} } },
				{ ...terminal, at: 0 },
				...compact.slice(compactStart).map((row) => ({
					...row,
					at: 0,
					...(row.message?.params?.["threadId"]
						? {
								message: {
									...row.message,
									params: {
										...row.message.params,
										threadId: started["threadId"],
									},
								},
							}
						: {}),
				})),
			]);
			const sending = browser.send(id, "Say hello", TIMEOUT);
			try {
				await browser.waitFor(
					(message) => JSON.stringify(message).includes("Hello"),
					0,
					TIMEOUT,
				);
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId: id,
						originId: browser.originId,
						inputId: "compact-while-busy",
						delivery: "steer",
						text: "/compact",
					}),
				);
			} finally {
				writeFileSync(gatePath, "1");
				await sending;
			}
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns).toEqual([
						{ state: "interrupted" },
						{ state: "completed" },
					]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const outgoing = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			expect(
				outgoing.filter(({ message }) => message?.method === "turn/steer"),
			).toEqual([]);
			expect(
				outgoing.filter(
					({ message }) => message?.method === "thread/compact/start",
				),
			).toHaveLength(1);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-command",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-command");
			expect(
				(await browser.send(id, "Run the command", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const started = events.find(({ type }) => type === "tool.started");
			expect(started?.data).toMatchObject({
				toolName: "Bash",
				input: {
					tool: "Bash",
					command: expect.stringContaining("exit 7"),
					workingDirectory: "/workspace",
				},
			});
			expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
				1,
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.running",
					data: expect.objectContaining({
						partId: started?.data["partId"],
						metadata: expect.objectContaining({
							output: expect.stringContaining("line\n"),
						}),
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({
						partId: started?.data["partId"],
						result: "first line\nsecond line\nthird line\n",
						metadata: expect.objectContaining({ isError: true, exitCode: 7 }),
					}),
				}),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "Bash",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: started?.data["input"] }),
						output: expect.objectContaining({
							text: "first line\nsecond line\nthird line\n",
						}),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"streams command output over WS and on history reload before completion",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"command-live-output",
				"turn-command",
				true,
			);
			let held = false;
			writeTrace(
				fixtureRows("turn-command").map((row) => {
					const at = held ? 1 : 0;
					if (row.message?.method === "item/commandExecution/outputDelta")
						held = true;
					return { ...row, at };
				}),
			);
			const sending = browser.send(id, "Run the command", TIMEOUT);
			try {
				const frame = await browser.waitFor(
					(message) =>
						message["type"] === "transcript_message" &&
						message["sessionId"] === id &&
						(message["parts"] as HistoryMessagePart[] | undefined)?.some(
							(part) => {
								const metadata = part.state?.["metadata"];
								return (
									part.type === "tool" &&
									part.tool === "Bash" &&
									part.state?.status === "running" &&
									typeof metadata === "object" &&
									metadata !== null &&
									"output" in metadata &&
									metadata.output === "second line\n"
								);
							},
						) === true,
				);
				expect(
					snapshot(fixture, id).events.filter(
						({ type }) =>
							type === "tool.completed" || type === "turn.completed",
					),
				).toEqual([]);
				const reloaded = await fixture.connect(id);
				const history = await reloaded.history(id);
				expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
					expect.objectContaining({
						type: "tool",
						tool: "Bash",
						state: expect.objectContaining({
							status: "running",
							metadata: expect.objectContaining({ output: "second line\n" }),
						}),
					}),
				);
				evidence["liveOutputBeforeCompletion"] = { frame, history };
			} finally {
				writeFileSync(gatePath, "1");
				await sending;
			}
			await expectTurns(fixture, id);
			const completed = (await browser.history(id))
				.flatMap(({ parts }) => parts ?? [])
				.find((part) => part.type === "tool" && part.tool === "Bash");
			expect(completed?.state?.output?.text).toBe(
				"first line\nsecond line\nthird line\n",
			);
			expect(completed?.state?.["metadata"] ?? {}).not.toHaveProperty("output");
		},
		TIMEOUT * 2,
	);

	it(
		"turn-file-change",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-file-change");
			expect(
				(await browser.send(id, "Change both files", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const started = events.find(({ type }) => type === "tool.started");
			expect(started?.data).toMatchObject({
				toolName: "Patch",
				input: {
					tool: "Patch",
					patch: expect.stringContaining("alpha"),
					filePaths: ["/workspace/alpha.txt", "/workspace/beta.txt"],
				},
			});
			expect(started?.data["input"]).toMatchObject({
				patch: expect.stringContaining("beta"),
			});
			expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
				1,
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({ partId: started?.data["partId"] }),
				}),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "Patch",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: started?.data["input"] }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-plan",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-plan");
			expect(
				(await browser.send(id, "Make a plan", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const input = {
				tool: "Unknown",
				name: "TodoWrite",
				raw: {
					todos: [
						{ content: "Inspect the files", status: "completed" },
						{ content: "Apply the change", status: "in_progress" },
						{ content: "Run verification", status: "pending" },
					],
				},
			};
			const started = events.find(({ type }) => type === "tool.started");
			expect(started?.data).toMatchObject({ toolName: "TodoWrite", input });
			expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
				1,
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({
						partId: started?.data["partId"],
						input,
					}),
				}),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "TodoWrite",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: input }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-mcp-tool",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-mcp-tool");
			expect(
				(await browser.send(id, "Look it up", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const input = {
				tool: "Unknown",
				name: "mcp__fixture__lookup",
				raw: { query: "fixture lookup" },
			};
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.started",
					data: expect.objectContaining({
						toolName: "mcp__fixture__lookup",
						input,
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({
						result: expect.objectContaining({ content: expect.any(Array) }),
					}),
				}),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "mcp__fixture__lookup",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: input }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-web-search",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-web-search");
			expect(
				(await browser.send(id, "Search the web", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const input = { tool: "WebSearch", query: "conduit tool cards" };
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.started",
					data: expect.objectContaining({ toolName: "WebSearch", input }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "tool.completed" }),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "WebSearch",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: input }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-image-view",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-image-view");
			expect(
				(await browser.send(id, "View the image", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const input = { tool: "Read", filePath: "/workspace/chart.png" };
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.started",
					data: expect.objectContaining({ toolName: "Read", input }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "tool.completed" }),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "Read",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: input }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-collab-tool",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-collab-tool");
			expect(
				(
					await browser.send(id, "Delegate the inspection", TIMEOUT)
				).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const input = {
				tool: "Task",
				description: "Inspect the patch",
				prompt: "Inspect the patch",
				subagentType: "Codex",
			};
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.started",
					data: expect.objectContaining({ toolName: "Task", input }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "tool.completed" }),
			);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "Task",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({ value: input }),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it(
		"malformed known tools remain generic cards without aborting the turn",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"invalid-tools",
				"basic",
			);
			const types = [
				"commandExecution",
				"fileChange",
				"mcpToolCall",
				"webSearch",
				"imageView",
				"collabAgentToolCall",
				"plan",
			];
			const trace = fixtureRows("basic").flatMap((row) => {
				if (
					row.message?.method !== "item/started" &&
					row.message?.method !== "item/completed"
				)
					return [row];
				const item = row.message.params?.["item"] as
					| { type?: string; id?: string }
					| undefined;
				if (item?.type !== "reasoning") return [row];
				return types.map((type) => ({
					...row,
					message: {
						...row.message,
						params: {
							...row.message?.params,
							item: { type, id: `${item.id}-${type}` },
						},
					},
				}));
			});
			writeTrace(trace);
			await browser.send(id, "Say hello", TIMEOUT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			for (const type of types)
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "tool.started",
						data: expect.objectContaining({
							toolName: type,
							input: {
								tool: "Unknown",
								name: type,
								raw: { item: expect.objectContaining({ type }) },
							},
						}),
					}),
				);
			expect(
				events.filter(({ type }) => type === "tool.completed"),
			).toHaveLength(types.length);
			expect(
				(await browser.history(id))
					.flatMap(({ parts }) => parts ?? [])
					.filter((part) => part.type === "tool"),
			).toHaveLength(types.length);
		},
		TIMEOUT * 2,
	);

	it(
		"updates the turn task list in place",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"plan-updates",
				"turn-plan",
			);
			writeTrace(
				fixtureRows("turn-plan").flatMap((row) => {
					if (row.message?.method !== "turn/plan/updated") return [row];
					const first = structuredClone(row);
					if (!first.message?.params) throw new Error("Missing plan params");
					first.message.params["plan"] = [
						{ step: "Old step", status: "pending" },
					];
					return [first, row];
				}),
			);
			await browser.send(id, "Make a plan", TIMEOUT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
				1,
			);
			const updates = events.filter(({ type }) => type === "tool.completed");
			expect(updates).toHaveLength(2);
			expect(updates[1]?.data).toMatchObject({
				input: {
					raw: {
						todos: expect.arrayContaining([
							{ content: "Apply the change", status: "in_progress" },
						]),
					},
				},
			});
			const tools = (await browser.history(id))
				.flatMap(({ parts }) => parts ?? [])
				.filter((part) => part.type === "tool");
			expect(tools).toHaveLength(1);
			expect(tools[0]).toMatchObject({
				tool: "TodoWrite",
				state: {
					input: {
						value: {
							raw: {
								todos: expect.arrayContaining([
									{ content: "Run verification", status: "pending" },
								]),
							},
						},
					},
				},
			});
		},
		TIMEOUT * 2,
	);

	it(
		"publishes every plan update to the todo overlay before settlement",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"plan-live-overlay",
				"turn-plan",
				true,
			);
			let phase = 0;
			writeTrace(
				fixtureRows("turn-plan").flatMap((row) => {
					if (row.message?.method !== "turn/plan/updated")
						return [{ ...row, at: phase }];
					const first = structuredClone(row);
					if (!first.message?.params) throw new Error("Missing plan params");
					first.message.params["plan"] = [
						{ step: "Old step", status: "pending" },
					];
					phase = 2;
					return [
						{ ...first, at: 0 },
						{ ...row, at: 1 },
					];
				}),
			);
			const todoFrames: unknown[] = [];
			const subscription = Effect.runFork(
				Stream.runForEach(
					browser.rpc.SubscribeSessionTodos({ sessionId: id }),
					(envelope) =>
						Effect.sync(() => {
							todoFrames.push(envelope);
						}),
				),
			);
			evidence["todoOverlayFrames"] = todoFrames;
			let sending: ReturnType<ProcessBrowser["send"]> | undefined;
			try {
				await vi.waitFor(
					() =>
						expect(todoFrames).toContainEqual(
							expect.objectContaining({ _tag: "synchronized" }),
						),
					{ timeout: TIMEOUT },
				);
				sending = browser.send(id, "Make a plan", TIMEOUT);
				await vi.waitFor(
					() =>
						expect(todoFrames).toContainEqual(
							expect.objectContaining({
								_tag: "upsert",
								item: expect.objectContaining({
									sessionId: id,
									items: [
										expect.objectContaining({
											subject: "Old step",
											status: "pending",
										}),
									],
								}),
							}),
						),
					{ timeout: TIMEOUT },
				);
				expect(
					snapshot(fixture, id).events.filter(
						({ type }) => type === "turn.completed",
					),
				).toEqual([]);
				const initial = (await browser.history(id))
					.flatMap(({ parts }) => parts ?? [])
					.find((part) => part.type === "tool" && part.tool === "TodoWrite");
				const cursor = todoFrames.length;
				writeFileSync(gatePath, "1");
				await vi.waitFor(
					() =>
						expect(todoFrames.slice(cursor)).toContainEqual(
							expect.objectContaining({
								_tag: "upsert",
								item: expect.objectContaining({
									sessionId: id,
									items: [
										expect.objectContaining({
											subject: "Inspect the files",
											status: "completed",
										}),
										expect.objectContaining({
											subject: "Apply the change",
											status: "in_progress",
										}),
										expect.objectContaining({
											subject: "Run verification",
											status: "pending",
										}),
									],
								}),
							}),
						),
					{ timeout: TIMEOUT },
				);
				expect(
					snapshot(fixture, id).events.filter(
						({ type }) => type === "turn.completed",
					),
				).toEqual([]);
				const tools = (await browser.history(id))
					.flatMap(({ parts }) => parts ?? [])
					.filter((part) => part.type === "tool");
				expect(tools).toHaveLength(1);
				expect(tools[0]).toMatchObject({
					id: initial?.id,
					tool: "TodoWrite",
					state: { status: "completed" },
				});
			} finally {
				writeFileSync(gatePath, "2");
				await sending;
				await Effect.runPromise(Fiber.interrupt(subscription));
			}
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
				1,
			);
			expect(
				events.filter(({ type }) => type === "tool.completed"),
			).toHaveLength(2);
		},
		TIMEOUT * 2,
	);

	it(
		"reconciles plan text without losing completed tool cards",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"plan-text-tools",
				"turn-command",
			);
			writeTrace(
				fixtureRows("turn-command").flatMap((row) => {
					if (row.message?.method !== "turn/completed") return [row];
					const params = row.message.params;
					const frame = (
						method: string,
						fields: Record<string, unknown>,
					): TraceRow => ({
						dir: "in",
						at: row["at"],
						message: {
							method,
							params: {
								threadId: params?.["threadId"],
								turnId: (params?.["turn"] as { id: string }).id,
								...fields,
							},
						},
					});
					return [
						frame("item/started", {
							item: { type: "plan", id: "fixture-plan", text: "" },
						}),
						frame("item/plan/delta", {
							itemId: "fixture-plan",
							delta: "Draft plan",
						}),
						frame("item/completed", {
							item: {
								type: "plan",
								id: "fixture-plan",
								text: "Authoritative plan",
							},
						}),
						row,
					];
				}),
			);
			await browser.send(id, "Run the command", TIMEOUT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "text.delta",
					data: expect.objectContaining({
						text: "Draft plan",
						partId: expect.stringContaining(":text:fixture-plan"),
					}),
				}),
			);
			const parts = (await browser.history(id)).flatMap(
				({ parts }) => parts ?? [],
			);
			expect(parts).toContainEqual(
				expect.objectContaining({ type: "text", text: "Authoritative plan" }),
			);
			expect(parts).not.toContainEqual(
				expect.objectContaining({ type: "text", text: "Draft plan" }),
			);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: "tool",
					tool: "Bash",
					state: expect.objectContaining({
						status: "completed",
						input: expect.objectContaining({
							value: expect.objectContaining({ tool: "Bash" }),
						}),
						output: expect.objectContaining({
							text: "first line\nsecond line\nthird line\n",
						}),
					}),
				}),
			);
		},
		TIMEOUT * 2,
	);

	it.each(["completion", "settlement"])(
		"keeps a UTF-8 output tail on command %s when aggregated output is missing",
		async (ending) => {
			const { fixture, browser, id } = await startTurn(
				`command-tail-${ending}`,
				"turn-command",
			);
			const chunk = `${"🙂".repeat(20_000)}last line\n`;
			const tail = `${"🙂".repeat(
				Math.floor((64 * 1024 - Buffer.byteLength("last line\n")) / 4),
			)}last line\n`;
			let sent = false;
			writeTrace(
				fixtureRows("turn-command").flatMap((row) => {
					if (row.message?.method === "item/commandExecution/outputDelta") {
						if (sent) return [];
						sent = true;
						if (!row.message.params) throw new Error("Missing delta params");
						row.message.params["delta"] = chunk;
						return [row];
					}
					const item = row.message?.params?.["item"] as
						| Record<string, unknown>
						| undefined;
					if (
						row.message?.method === "item/completed" &&
						item?.["type"] === "commandExecution"
					) {
						if (ending === "settlement") return [];
						item["aggregatedOutput"] = null;
					}
					return [row];
				}),
			);
			await browser.send(id, "Run the command", TIMEOUT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const running = events.filter(({ type }) => type === "tool.running");
			expect(running).toHaveLength(1);
			expect(running[0]?.data).toMatchObject({ metadata: { output: tail } });
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({
						result: tail,
						metadata: expect.objectContaining({
							output: tail,
							exitCode: ending === "completion" ? 7 : null,
						}),
					}),
				}),
			);
			expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64 * 1024);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-raw-reasoning",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-raw-reasoning");
			const reply = await browser.send(id, "Say hello", TIMEOUT);
			expect(reply.chunks.join("")).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "thinking.start" }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "thinking.delta",
					data: expect.objectContaining({
						text: "I will answer the greeting directly.",
					}),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "thinking.end" }),
			);
			const history = await browser.history(id);
			expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
				expect.objectContaining({
					type: "thinking",
					text: "I will answer the greeting directly.",
				}),
			);
			expect(events.filter(({ type }) => type === "turn.error")).toEqual([]);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-decode-failure",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-decode-failure");
			const reply = await browser.send(id, "Say hello", TIMEOUT);
			expect(reply.chunks.join("")).toContain("the mock model.");
			await expectTurns(fixture, id);
			const history = await browser.history(id);
			expect(history.flatMap(({ parts }) => parts ?? [])).toContainEqual(
				expect.objectContaining({ type: "text", text: TEXT }),
			);
			await vi.waitFor(
				() => {
					const log = readFileSync(
						join(fixture.configDir, "runners.log"),
						"utf8",
					);
					expect(log).toContain("codex.decode_failed");
					expect(log).toContain("item/agentMessage/delta");
					expect(log).toMatch(/byte(?:Size|s)/);
				},
				{ timeout: TIMEOUT },
			);
		},
		TIMEOUT * 2,
	);

	it(
		"turn-unknown-item",
		async () => {
			const { fixture, browser, id } = await startTurn("turn-unknown-item");
			expect(
				(await browser.send(id, "Say hello", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool.started",
					data: expect.objectContaining({ toolName: "futureItem" }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "tool.completed" }),
			);
		},
		TIMEOUT * 2,
	);

	it.each(["missing suffix", "corrected text"])(
		"reconciles authoritative completed text after %s",
		async (scenario) => {
			const { fixture, browser, id } = await startTurn(scenario, "basic");
			const trace = fixtureRows("basic");
			const deltas = trace.filter(
				({ message }) => message?.method === "item/agentMessage/delta",
			);
			if (scenario === "missing suffix") {
				const last = deltas.at(-1);
				writeTrace(trace.filter((row) => row !== last));
			} else {
				const first = deltas[0]?.message?.params;
				if (!first) throw new Error("No recorded text delta");
				first["delta"] = "Incorrect prefix ";
				writeTrace(trace);
			}
			await browser.send(id, "Say hello", TIMEOUT);
			await expectTurns(fixture, id);
			expect(
				(await browser.history(id)).flatMap(({ parts }) => parts ?? []),
			).toContainEqual(expect.objectContaining({ type: "text", text: TEXT }));
		},
		TIMEOUT * 2,
	);

	it(
		"settles unfinished thinking and generic cards before the turn completes",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"open-items",
				"turn-unknown-item",
			);
			writeTrace(
				fixtureRows("turn-unknown-item").filter(({ message }) => {
					if (message?.method !== "item/completed") return true;
					const item = message.params?.["item"] as
						| { type?: string }
						| undefined;
					return item?.type !== "reasoning" && item?.type !== "futureItem";
				}),
			);
			await browser.send(id, "Say hello", TIMEOUT);
			await expectTurns(fixture, id);
			const { events } = snapshot(fixture, id);
			const terminal = events.findIndex(
				({ type }) => type === "turn.completed",
			);
			const cardEnd = events.findIndex(({ type }) => type === "tool.completed");
			const thinkingEnd = events.findIndex(
				({ type }) => type === "thinking.end",
			);
			expect(cardEnd).toBeGreaterThan(-1);
			expect(thinkingEnd).toBeGreaterThan(-1);
			expect(cardEnd).toBeLessThan(terminal);
			expect(thinkingEnd).toBeLessThan(terminal);
		},
		TIMEOUT * 2,
	);

	it(
		"version-unsupported",
		async () => {
			const { fixture, browser } = await start(
				"version-unsupported",
				"version-unsupported",
			);
			const added = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "Old Codex",
				driver: "codex",
			});
			const account = (await browser.instances()).instances.find(
				({ id }) => id === added.addedInstanceId,
			);
			expect(account).toMatchObject({
				available: false,
				unavailableCode: "codex_version_unsupported",
			});
			expect(account?.unavailableReason).toContain("0.160.0");
			evidence["account"] = account;
		},
		TIMEOUT * 2,
	);

	it.each([
		{ info: "Unauthorized", code: "auth_required" },
		{ info: "FutureProviderError", code: "provider_error" },
	])(
		"maps failed turns with $info to $code",
		async ({ info, code }) => {
			const { fixture, browser, id } = await startTurn(
				`failed-${info}`,
				"basic",
			);
			const trace = fixtureRows("basic");
			const completed = trace.find(
				({ message }) => message?.method === "turn/completed",
			);
			const turn = completed?.message?.params?.["turn"] as
				| Record<string, unknown>
				| undefined;
			if (!turn) throw new Error("No recorded terminal turn");
			turn["status"] = "failed";
			turn["error"] = {
				message: `Recorded failure: ${info}`,
				codexErrorInfo: info,
				additionalDetails: null,
			};
			writeTrace(trace);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["error"],
					),
				{ timeout: TIMEOUT },
			);
			const { events } = snapshot(fixture, id);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({
						code,
						error: `Recorded failure: ${info}`,
					}),
				}),
			);
			expect(
				events.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(0);
		},
		TIMEOUT * 2,
	);

	it(
		"fails child exit and respawns with the stored thread on the next turn",
		async () => {
			const { fixture, browser, id } = await startTurn(
				"child-exit-resume",
				"two-turns",
			);
			const trace = fixtureRows("two-turns");
			const deltaIndex = trace.findIndex(
				({ message }) => message?.method === "item/agentMessage/delta",
			);
			if (deltaIndex < 0) throw new Error("No recorded text delta");
			writeTrace([
				...trace.slice(0, deltaIndex + 1),
				{
					dir: "exit",
					at: Number(trace[deltaIndex]?.["at"]) + 1,
					code: 1,
					signal: null,
				},
			]);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["error"],
					),
				{ timeout: TIMEOUT },
			);
			expect(snapshot(fixture, id).events).toContainEqual(
				expect.objectContaining({
					type: "turn.error",
					data: expect.objectContaining({
						code: "provider_unavailable",
						retryable: true,
					}),
				}),
			);
			const identity = JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", id, "session.json"),
					"utf8",
				),
			) as { threadId: string };
			const runnerPids = fixture.runnerPids();
			evidence["failedCapture"] = rows<TraceRow>(capturePath);

			const requests = trace.flatMap(({ message }, index) =>
				message?.method === "turn/start" ? [index] : [],
			);
			const first = requests[0];
			const second = requests[1];
			if (first === undefined || second === undefined)
				throw new Error("Two recorded turns required");
			const resumed = [...trace.slice(0, first), ...trace.slice(second)];
			const thread = resumed.find(
				({ message }) => message?.method === "thread/start",
			)?.message;
			if (!thread) throw new Error("No recorded thread creation");
			thread.method = "thread/resume";
			thread.params = { threadId: identity.threadId };
			writeTrace(resumed);
			expect(
				(await browser.send(id, "Say hello again", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["error", "completed"],
					),
				{ timeout: TIMEOUT },
			);
			expect(fixture.runnerPids()).toEqual(runnerPids);
			const captured = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			expect(
				captured.filter(({ message }) => message?.method === "thread/start"),
			).toHaveLength(0);
			expect(
				captured.filter(({ message }) => message?.method === "thread/resume"),
			).toHaveLength(1);
			expect(
				captured.find(({ message }) => message?.method === "thread/resume")
					?.message?.params?.["threadId"],
			).toBe(identity.threadId);
		},
		TIMEOUT * 3,
	);

	it(
		"two-turns reuse the live app-server and thread",
		async () => {
			const { fixture, browser, id } = await startTurn("two-turns");
			expect(
				(await browser.send(id, "Say hello", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			const runnerPids = fixture.runnerPids();
			expect(
				(await browser.send(id, "Say hello again", TIMEOUT)).chunks.join(""),
			).toBe(TEXT);
			await expectTurns(fixture, id, 2);
			expect(fixture.runnerPids()).toEqual(runnerPids);
			const captured = rows<TraceRow>(capturePath).filter(
				({ dir }) => dir === "out",
			);
			expect(
				captured.filter(({ message }) => message?.method === "initialize"),
			).toHaveLength(1);
			expect(
				captured.filter(({ message }) => message?.method === "thread/start"),
			).toHaveLength(1);
			expect(
				captured.filter(({ message }) => message?.method === "thread/resume"),
			).toHaveLength(0);
			const turns = captured.filter(
				({ message }) => message?.method === "turn/start",
			);
			expect(turns).toHaveLength(2);
			expect(turns[0]?.message?.params?.["threadId"]).toBe(
				turns[1]?.message?.params?.["threadId"],
			);
			const identity = JSON.parse(
				readFileSync(
					join(fixture.configDir, "codex", "stores", id, "session.json"),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(identity["threadId"]).toBe(
				turns[0]?.message?.params?.["threadId"],
			);
		},
		TIMEOUT * 3,
	);

	it(
		"model-list discovers every visible model with effort variants and defaults",
		async () => {
			const { browser } = await start("model-list");
			const accounts = await vi.waitFor(
				async () => {
					const found = (await browser.instances()).instances.filter(
						({ driver }) => driver === "codex",
					);
					expect(found).toHaveLength(1);
					return found;
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			const account = accounts[0];
			if (!account) throw new Error("No Codex account");
			const models = await codexModels(browser, account.id);
			const captured = fixtureRows("model-list")
				.filter(
					({ message }) => message?.result && "nextCursor" in message.result,
				)
				.flatMap(
					({ message }) =>
						(message?.result?.["data"] ?? []) as Array<{
							model: string;
							hidden: boolean;
							supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
							defaultReasoningEffort: string;
						}>,
				);
			expect(models.map(({ id }) => id).sort()).toEqual(
				captured
					.filter(({ hidden }) => !hidden)
					.map(({ model }) => model)
					.sort(),
			);
			for (const native of captured.filter(({ hidden }) => !hidden)) {
				const model = models.find(({ id }) => id === native.model);
				expect(model?.variants?.slice().sort()).toEqual(
					native.supportedReasoningEfforts
						.map(({ reasoningEffort }) => reasoningEffort)
						.sort(),
				);
				expect(
					model?.parameters?.combinations.find(({ isDefault }) => isDefault)
						?.variant,
				).toBe(native.defaultReasoningEffort);
			}
			evidence["models"] = models;
		},
		TIMEOUT * 2,
	);

	it(
		"keeps a deleted Codex account deleted across a daemon restart",
		async () => {
			const { fixture, browser, restartOptions } = await start("model-list");
			const accounts = await vi.waitFor(
				async () => {
					const found = (await browser.instances()).instances.filter(
						({ driver }) => driver === "codex",
					);
					expect(found).toHaveLength(1);
					return found;
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			const account = accounts[0];
			if (!account) throw new Error("No Codex account");
			// Finish every catalog page before deletion closes the first transport.
			expect(await codexModels(browser, account.id)).toContainEqual(
				expect.objectContaining({ id: MODEL, provider: "codex" }),
			);
			await browser.removeInstance(account.id);
			expect(
				(await browser.instances()).instances.filter(
					({ driver }) => driver === "codex",
				),
			).toEqual([]);
			await fixture.terminate();
			await fixture.restart(restartOptions);
			const restarted = await fixture.connect();
			const settleUntil = Date.now() + 3_000;
			do {
				expect(
					(await restarted.instances()).instances.filter(
						({ driver }) => driver === "codex",
					),
				).toEqual([]);
				await new Promise((resolve) => setTimeout(resolve, 100));
			} while (Date.now() < settleUntil);
			evidence["deletedAccountId"] = account.id;
		},
		TIMEOUT * 3,
	);
});
