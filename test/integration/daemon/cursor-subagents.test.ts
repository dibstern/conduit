// Failure modes: parent-owned child content, unstable child IDs, snapshot
// duplication, inherited parent model, early background completion, uncancelled
// children, missing tool restrictions, and a resumable child input path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}
interface StoredEvent {
	sequence: number;
	type: string;
	sessionId: string;
	data: Record<string, unknown>;
}
const TIMEOUT = 120_000;
const TASK_CALL = "tool_227c0ba1-9bbc-4924-9f30-d3f3d2af0e4";
const CHILD_AGENT = "58405bbc-5595-489e-bfcb-1c1684843400";
const CAPTURE = "subagent-foreground-default-fixed";

function rows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}
function snapshot(harness: ProcessHarness) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<
					[],
					{ sequence: number; type: string; session_id: string; data: string }
				>(
					"SELECT sequence, type, session_id, data FROM events WHERE project_id = 'process-test' ORDER BY sequence",
				)
				.all()
				.map<StoredEvent>((row) => ({
					sequence: row.sequence,
					type: row.type,
					sessionId: row.session_id,
					data: JSON.parse(row.data) as Record<string, unknown>,
				})),
			sessions: db
				.prepare<
					[],
					{
						id: string;
						parent_id: string | null;
						provider: string;
						provider_sid: string | null;
						model_id: string | null;
						status: string;
					}
				>(
					"SELECT id, parent_id, provider, provider_sid, model_id, status FROM sessions WHERE project_id = 'process-test'",
				)
				.all(),
			turns: db
				.prepare<[], { session_id: string; state: string }>(
					"SELECT session_id, state FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE project_id = 'process-test')",
				)
				.all(),
		};
	} finally {
		db.close();
	}
}
function content(events: readonly StoredEvent[], type: string) {
	return events
		.filter((event) => event.type === type)
		.map(({ data }) => String(data["text"] ?? ""))
		.join("");
}
function capturedChildContent(type: string) {
	return rows(resolve(`test/fixtures/cursor-sdk-traces/${CAPTURE}.jsonl`))
		.flatMap(({ kind, data }) => {
			const update = data?.["taskUpdate"] as
				| Record<string, unknown>
				| undefined;
			return kind === "delta" && update?.["type"] === type
				? [String(update["text"])]
				: [];
		})
		.join("");
}

describe("Cursor live child sessions through daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId = "";
	let capturePath = "";
	let scenario = "";
	const evidence: Record<string, unknown>[] = [];

	async function start(name: string, fixture = CAPTURE, waitDelayMs = 0) {
		scenario = name;
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const tracePath = join(harness.root, "cursor-subagent.jsonl");
		capturePath = join(harness.root, "cursor-capture.jsonl");
		const trace = rows(
			resolve(`test/fixtures/cursor-sdk-traces/${fixture}.jsonl`),
		);
		const catalog = rows(
			resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
		).find(({ kind }) => kind === "models.list");
		if (!catalog) throw new Error("Missing captured model catalogue");
		trace.splice(1, 0, catalog, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				CONDUIT_TEST_CURSOR_DELTA_DELAY_MS: "5",
				CONDUIT_TEST_CURSOR_WAIT_DELAY_MS: String(waitDelayMs),
			},
		});
		const account = await harness.requestRpc({
			_tag: "AddInstance",
			name: "Cursor subagent replay",
			driver: "cursor",
		});
		if (!account.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await harness.connect();
		sessionId = await browser.createSession(
			name,
			account.addedInstanceId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "ask",
			},
		);
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Replay the captured Task.",
			}),
		);
		return {
			fixture: harness,
			browser,
			id: sessionId,
			accountId: account.addedInstanceId,
		};
	}
	async function waitChild(fixture: ProcessHarness, id: string) {
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture).sessions.some((row) => row.parent_id === id),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		const child = snapshot(fixture).sessions.find(
			(row) => row.parent_id === id,
		);
		if (!child) throw new Error("Missing materialized child");
		return child;
	}
	async function waitTurn(fixture: ProcessHarness, id: string, state: string) {
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture).turns.filter((row) => row.session_id === id),
				).toEqual([{ session_id: id, state }]),
			{ timeout: TIMEOUT },
		);
	}
	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const state = existsSync(fixture.daemonStorePath())
			? snapshot(fixture)
			: undefined;
		const captured = rows(capturePath);
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			evidence.push({
				scenario,
				result: task.result?.state,
				errors: task.result?.errors?.map(({ message }) => message),
				sessions: state?.sessions,
				turns: state?.turns,
				childEvents: state?.events.filter(
					({ sessionId: owner }) => owner !== sessionId,
				),
				operations: captured.filter(({ kind }) =>
					["create.options", "wait.result", "cancel.call"].includes(kind ?? ""),
				),
				process: fixture.proof(),
				remainingRunnerPids: fixture.remainingRunnerPids(),
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.10.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.10", scenarios: evidence }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("streams foreground child text, thinking and tools before reconciling its snapshot once", async () => {
		const { fixture, browser, id, accountId } = await start("foreground");
		const child = await waitChild(fixture, id);
		expect(child.id).toMatch(/^cursor-subagent-/);
		expect(child.id).toBe(
			`cursor-subagent-${createHash("sha256").update(`${id}\0${TASK_CALL}`).digest("hex").slice(0, 24)}`,
		);
		expect(child.id).not.toContain(CHILD_AGENT);
		expect(child.provider_sid).toBe(TASK_CALL);
		expect(child.provider).toBe(accountId);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture).events.some(
						(event) =>
							event.sessionId === child.id && event.type === "text.delta",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		expect(
			snapshot(fixture).turns.find((row) => row.session_id === id)?.state,
		).toBe("running");
		const live = await browser.history(child.id);
		expect(live.some(({ role }) => role === "assistant")).toBe(true);
		await waitTurn(fixture, id, "completed");
		const state = snapshot(fixture);
		const events = state.events.filter((event) => event.sessionId === child.id);
		expect(content(events, "text.delta")).toBe(
			capturedChildContent("text-delta"),
		);
		expect(content(events, "thinking.delta")).toBe(
			capturedChildContent("thinking-delta"),
		);
		const starts = events.filter(({ type }) => type === "tool.started");
		expect(starts).toHaveLength(10);
		expect(new Set(starts.map(({ data }) => data["callId"])).size).toBe(10);
		expect(events.filter(({ type }) => type === "tool.completed")).toHaveLength(
			10,
		);
		expect(
			events.filter(({ type }) => type === "message.snapshot"),
		).toHaveLength(1);
		const parts = (await browser.history(child.id)).flatMap(
			({ parts }) => parts ?? [],
		);
		for (const kind of ["text", "thinking"] as const) {
			expect(
				parts.filter(({ type }) => type === kind).map(({ id }) => id),
			).toEqual([
				...new Set(
					events
						.filter(({ type }) => type === `${kind}.delta`)
						.map(({ data }) => data["partId"]),
				),
			]);
		}
		expect(
			parts.filter(({ tool }) => tool === "getMcpToolsToolCall"),
		).toHaveLength(3);
		expect(parts.slice(0, 7).map(({ type, tool }) => tool ?? type)).toEqual([
			"thinking",
			"text",
			"getMcpToolsToolCall",
			"getMcpToolsToolCall",
			"getMcpToolsToolCall",
			"Read",
			"Bash",
		]);
		expect(
			parts.find(({ tool }) => tool === "Bash")?.state?.["metadata"],
		).toMatchObject({
			cursorToolType: "shell",
			exitCode: 0,
		});
		expect(
			parts.find(({ tool }) => tool === "Bash")?.state?.["metadata"],
		).not.toHaveProperty("output");
		expect(
			parts.find(({ tool }) => tool === "Bash")?.state?.["output"],
		).toEqual({
			_tag: "whole",
			text: "hi\n",
		});
		const parent = state.events.filter((event) => event.sessionId === id);
		const task = parent.find(
			({ type, data }) =>
				type === "tool.started" && data["callId"] === TASK_CALL,
		);
		expect(task?.data).toMatchObject({
			toolName: "Task",
			input: {
				tool: "Task",
				description: "Spike workflow steps",
				subagentType: "spike",
			},
		});
		const completed = parent.find(
			({ type, data }) =>
				type === "tool.completed" && data["partId"] === task?.data["partId"],
		);
		expect(completed?.data["metadata"]).toMatchObject({
			childSessionId: child.id,
			subagentModel: "composer-2.5",
			subagentMode: "unspecified",
		});
		expect(completed?.data["result"]).toBe("");
		expect(JSON.stringify(completed?.data)).not.toContain("conversationSteps");
		expect(parent.filter(({ type }) => type === "tool.started")).toHaveLength(
			1,
		);
		expect(
			events.find(({ type }) => type === "text.delta")?.sequence,
		).toBeLessThan(completed?.sequence ?? 0);
		expect(
			state.sessions.find(({ id: candidate }) => candidate === child.id)
				?.status,
		).toBe("idle");
		const create = rows(capturePath).find(
			({ kind }) => kind === "create.options",
		)?.data;
		expect(create).toMatchObject({
			local: { subagentInherit: { reportedWorkspacePath: fixture.projectDir } },
		});
		expect(create?.["disallowedTools"]).not.toContain("task");
		expect(create?.["disallowedTools"]).toContain("askQuestion");
		expect(create).not.toHaveProperty("agents");
		const childInputId = randomUUID();
		await expect(
			Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId: child.id,
					originId: browser.originId,
					inputId: childInputId,
					delivery: "queue",
					text: "Cannot resume a Task child",
				}),
			),
		).rejects.toThrow("Subagent sessions are read-only");
		expect(
			snapshot(fixture).events.some(
				({ data }) => data["inputId"] === childInputId,
			),
		).toBe(false);
	}, 300_000);

	it("reconciles repeated conversationSteps once without repeating child text or calls", async () => {
		const { fixture, browser, id } = await start(
			"reconcile",
			"subagent-reconcile",
		);
		const child = await waitChild(fixture, id);
		await waitTurn(fixture, id, "completed");
		expect(
			snapshot(fixture).sessions.find((row) => row.id === child.id)?.model_id,
		).toBe("composer-2.5-fast");
		const events = snapshot(fixture).events.filter(
			(event) => event.sessionId === child.id,
		);
		expect(content(events, "text.delta")).toBe(
			capturedChildContent("text-delta"),
		);
		expect(
			events.filter(({ type }) => type === "message.snapshot"),
		).toHaveLength(1);
		const history = await browser.history(child.id);
		expect(
			history
				.flatMap(({ parts }) => parts ?? [])
				.filter(({ type }) => type === "text")
				.map(({ text }) => text)
				.join(""),
		).toBe(capturedChildContent("text-delta"));
		expect(content(events, "thinking.delta")).toBe(
			capturedChildContent("thinking-delta"),
		);
		expect(events.filter(({ type }) => type === "tool.started")).toHaveLength(
			10,
		);
		expect(events.filter(({ type }) => type === "tool.completed")).toHaveLength(
			10,
		);
	}, 300_000);

	it("keeps a background run open through its same-run follow-up until wait resolves", async () => {
		const { fixture, browser, id } = await start(
			"background",
			"subagent-background-follow-up",
			6000,
		);
		const child = await waitChild(fixture, id);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture).events.some(
						({ type, sessionId: owner, data }) =>
							owner === id && type === "text.delta" && data["text"] === "done",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		expect(
			snapshot(fixture).turns.find((row) => row.session_id === id)?.state,
		).toBe("running");
		expect(
			snapshot(fixture).sessions.find((row) => row.id === child.id)?.status,
		).toBe("busy");
		await vi.waitFor(
			async () => {
				const childHistory = await browser.history(child.id);
				expect(
					childHistory
						.flatMap(({ parts }) => parts ?? [])
						.filter(({ type }) => type === "text")
						.map(({ text }) => text)
						.join(""),
				).toBe(`${capturedChildContent("text-delta")}Executing`);
			},
			{ timeout: TIMEOUT },
		);
		await waitTurn(fixture, id, "completed");
		const childHistory = await browser.history(child.id);
		expect(
			childHistory
				.flatMap(({ parts }) => parts ?? [])
				.filter(({ type }) => type === "text")
				.map(({ text }) => text)
				.join(""),
		).toBe(`${capturedChildContent("text-delta")}Executing`);
		const childEvents = snapshot(fixture).events.filter(
			({ sessionId: owner }) => owner === child.id,
		);
		expect(
			childEvents.filter(({ type }) => type === "message.snapshot"),
		).toEqual([]);
		expect(
			childEvents.filter(({ type }) => type === "tool.started"),
		).toHaveLength(7);
		const history = await browser.history(id);
		expect(history.filter(({ role }) => role === "assistant")).toHaveLength(2);
		expect(
			snapshot(fixture).sessions.find((row) => row.id === child.id)?.status,
		).toBe("idle");
		expect(
			rows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(1);
	}, 300_000);

	it("cancels the whole run and settles its active child on interrupt", async () => {
		const { fixture, browser, id } = await start(
			"interrupt",
			"subagent-interrupt",
		);
		const child = await waitChild(fixture, id);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture).events.some(
						({ sessionId: owner, type }) =>
							owner === child.id && type === "thinking.delta",
					),
				).toBe(true),
			{ timeout: TIMEOUT },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await waitTurn(fixture, id, "interrupted");
		expect(
			snapshot(fixture).sessions.find((row) => row.id === child.id)?.status,
		).toBe("idle");
		expect(
			snapshot(fixture).events.filter(
				({ sessionId: owner, type }) =>
					owner === child.id && type === "turn.interrupted",
			),
		).toHaveLength(1);
		expect(rows(capturePath).some(({ kind }) => kind === "cancel.call")).toBe(
			true,
		);
	}, 300_000);
});
