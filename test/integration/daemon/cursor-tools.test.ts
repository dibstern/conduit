// Failure modes: missing/duplicated tools, invented tool payloads, shell output
// assigned to a concurrent read, lost file diffs/media, ignored nested tools,
// truncation lost, and progress updates failing the authoritative wait result.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { AddInstance } from "../../../src/lib/contracts/ws-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

interface StoredEvent {
	type: string;
	data: Record<string, unknown>;
}

const TIMEOUT = 90_000;
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=";
const kinds = {
	shell: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	delete: "Delete",
	glob: "Glob",
	grep: "Grep",
	ls: "Glob",
	readLints: "LSP",
	semSearch: "Grep",
	mcp: "mcp__spike__echo_hi",
	updateTodos: "TodoWrite",
	createPlan: "CreatePlan",
	generateImage: "generateImage",
	recordScreen: "recordScreen",
	computerUse: "ComputerUse",
	task: "Task",
	unknown: "future-tool",
	"nested-computerUse": "Task",
	"shell-error": "Bash",
	"computerUse-error": "ComputerUse",
	"stream-truncated": "Glob",
	"early-stream-truncated": "Glob",
} as const;

function rows(name: string): TraceRow[] {
	return readFileSync(
		resolve(`test/fixtures/cursor-sdk-traces/${name}.jsonl`),
		"utf8",
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

function snapshot(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare<[string], { type: string; data: string }>(
				"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId)
			.map<StoredEvent>((event) => ({
				type: event.type,
				data: JSON.parse(event.data) as Record<string, unknown>,
			}));
	} finally {
		db.close();
	}
}

describe("Cursor tool traces through the built daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	const scenarios: Record<string, unknown>[] = [];

	afterAll(async () => {
		if (!harness) return;
		try {
			await harness.dispose();
			expect(harness.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.7.json",
				`${JSON.stringify(
					{
						ticket: "conduit-test-xqsg.7",
						scenarios,
						process: harness.proof(),
						remainingRunnerPids: harness.remainingRunnerPids(),
					},
					null,
					2,
				)}\n`,
			);
		}
	}, TIMEOUT);

	it("persists every declared tool, unknown tools, nested computer use and result payloads", async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const tracePath = join(harness.root, "cursor-tools.jsonl");
		writeFileSync(
			join(harness.projectDir, "screen.png"),
			Buffer.from(PNG, "base64"),
		);
		writeFileSync(
			join(harness.projectDir, "screen.webm"),
			"replay video bytes",
		);
		const catalog = rows("basic").find(({ kind }) => kind === "models.list");
		if (!catalog) throw new Error("Basic capture has no model catalog");
		const modelCatalog: TraceRow = catalog;
		function writeTrace(name: string) {
			const trace = rows(`tool-${name}`);
			trace.splice(1, 0, modelCatalog, {
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
			return trace;
		}
		writeTrace("shell");
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: { CONDUIT_CURSOR_SDK_TRACE: tracePath },
		});
		const added = await harness.requestRpc(
			new AddInstance({ name: "Cursor tool replay", driver: "cursor" }),
		);
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Cursor tool rows",
			added.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "", permissionMode: "ask" },
		);
		let priorCount = 0;
		for (const [kind, toolName] of Object.entries(kinds)) {
			const trace = writeTrace(kind);
			await browser.send(sessionId, `Replay ${kind}`, TIMEOUT);
			const allEvents = snapshot(harness, sessionId);
			const events = allEvents.slice(priorCount);
			priorCount = allEvents.length;
			const started = events.filter(({ type }) => type === "tool.started");
			const completed = events.filter(({ type }) => type === "tool.completed");
			const sourceCompleted = trace.filter(
				({ kind: rowKind, data }) =>
					rowKind === "delta" && data?.["type"] === "tool-call-completed",
			);
			expect(
				started.some(({ data }) => data["toolName"] === toolName),
				kind,
			).toBe(true);
			expect(completed, kind).toHaveLength(
				sourceCompleted.length + (kind === "stream-truncated" ? 1 : 0),
			);
			for (const source of sourceCompleted) {
				const call = source.data?.["toolCall"] as Record<string, unknown>;
				const stored = completed.find(
					({ data }) =>
						data["partId"] ===
						`${data["messageId"]}:tool:${source.data?.["callId"]}`,
				);
				const envelope = call["result"] as Record<string, unknown>;
				const value = (envelope["value"] ?? envelope["error"]) as Record<
					string,
					unknown
				>;
				const args = call["args"] as Record<string, unknown>;
				let expectedResult = call["result"];
				if (envelope["status"] === "error")
					expectedResult = value["message"] || call["result"];
				else {
					switch (call["type"]) {
						case "task":
							expectedResult = value["resultSuffix"] ?? "";
							break;
						case "shell":
							expectedResult =
								String(value["stdout"]) + String(value["stderr"]);
							break;
						case "read":
							expectedResult = value["content"];
							break;
						case "edit":
							expectedResult = value["diffString"] || call["result"];
							break;
						case "glob":
							expectedResult = (value["files"] as string[]).join("\n");
							break;
						case "semSearch":
							expectedResult = value["results"];
							break;
						case "createPlan":
							expectedResult = args["plan"];
							break;
					}
				}
				expect(stored?.data["result"], kind).toEqual(expectedResult);
				expect(stored?.data["metadata"], kind).toMatchObject({
					cursorToolType: call["type"],
				});
				for (const key of ["cursor", "stdout", "stderr", "shellOutput"])
					expect(stored?.data["metadata"], kind).not.toHaveProperty(key);
			}
			expect(
				events.filter(({ type }) => type === "file.attached"),
				kind,
			).toEqual([]);
			expect(
				events.filter(({ type }) => type === "turn.completed"),
				kind,
			).toHaveLength(1);
			expect(
				events.some(({ type }) => type === "turn.error"),
				kind,
			).toBe(false);
			expect(
				events.some(
					({ type, data }) =>
						type === "session.status" && typeof data["message"] === "string",
				),
				kind,
			).toBe(true);
			const metadata = completed.at(-1)?.data["metadata"] as Record<
				string,
				unknown
			>;
			const history = await browser.history(sessionId);
			const finalPart = history
				.flatMap(({ parts }) => parts ?? [])
				.find(({ id }) => id === completed.at(-1)?.data["partId"]);
			expect(finalPart?.state?.["metadata"], kind).toMatchObject({
				progress:
					kind === "task" ? "Inspecting tool results" : "Running 3 tools",
			});
			if (kind === "shell") {
				expect(completed[0]?.data["result"]).toBe("hi\n");
				expect(metadata).toMatchObject({
					exitCode: 0,
					output: null,
				});
				const running = events.filter(({ type }) => type === "tool.running");
				expect(
					running.some(({ data }) =>
						JSON.stringify(data["metadata"]).includes("first stdout"),
					),
				).toBe(true);
				expect(
					running.some(({ data }) =>
						JSON.stringify(data["metadata"]).includes("first stderr"),
					),
				).toBe(true);
				for (const { data } of running)
					for (const key of ["cursor", "stdout", "stderr", "shellOutput"])
						expect(data["metadata"]).not.toHaveProperty(key);
				expect(finalPart?.state?.["metadata"]).not.toHaveProperty("output");
				const outputDb = new Database(harness.daemonStorePath(), {
					readonly: true,
				});
				try {
					const projected = outputDb
						.prepare<[string], { metadata: string }>(
							"SELECT metadata FROM message_parts WHERE id = ?",
						)
						.get(String(completed[0]?.data["partId"]));
					expect(JSON.parse(projected?.metadata ?? "null")).toHaveProperty(
						"output",
						null,
					);
				} finally {
					outputDb.close();
				}
			}
			if (kind === "edit")
				expect(metadata["fileChange"]).toEqual({
					filePath: "/home/test/src/personal/cursor-spike/ws/a.txt",
					diff: expect.stringContaining("@@"),
					linesAdded: 1,
					linesRemoved: 0,
				});
			if (kind === "write") {
				expect(completed[0]?.data["input"]).toEqual({
					tool: "Write",
					filePath: "created.txt",
					content: "created\n",
				});
				expect(metadata["fileChange"]).toEqual({
					filePath: "created.txt",
					linesAdded: 1,
				});
			}
			if (kind === "delete")
				expect(metadata["fileChange"]).toEqual({
					filePath: "/home/test/src/personal/cursor-spike/ws/delete-me.txt",
					deleted: true,
					fileSize: 7,
				});
			if (
				kind === "glob" ||
				kind === "stream-truncated" ||
				kind === "early-stream-truncated"
			)
				expect(metadata["truncated"]).toBe(true);
			if (kind === "updateTodos")
				expect(completed[0]?.data["input"]).toMatchObject({
					tool: "Unknown",
					raw: {
						todos: [
							{ content: "Inspect tools", status: "in_progress" },
							{ content: "Render rows", status: "pending" },
						],
					},
				});
			if (kind === "shell-error" || kind === "computerUse-error") {
				expect(metadata["isError"]).toBe(true);
				const errorDb = new Database(harness.daemonStorePath(), {
					readonly: true,
				});
				try {
					expect(
						errorDb
							.prepare<[string], { status: string }>(
								"SELECT status FROM message_parts WHERE id = ?",
							)
							.get(String(completed.at(-1)?.data["partId"]))?.status,
					).toBe("error");
				} finally {
					errorDb.close();
				}
				const history = await browser.history(sessionId);
				const part = history
					.flatMap(({ parts }) => parts ?? [])
					.find(({ id }) => id === completed.at(-1)?.data["partId"]);
				expect(part?.state).toMatchObject({
					status: "error",
					error: expect.any(String),
				});
			}
			if (kind === "createPlan")
				expect(metadata["plan"]).toMatchObject({
					content: "# Tool rendering\n\nRender all tools.",
				});
			if (
				[
					"computerUse",
					"computerUse-error",
					"generateImage",
					"recordScreen",
				].includes(kind)
			) {
				expect(metadata["media"]).toEqual([
					expect.objectContaining({ url: expect.stringMatching(/^data:/) }),
				]);
			}
			if (kind === "computerUse" || kind === "computerUse-error")
				expect(metadata["computerUse"]).toMatchObject({
					actions: expect.arrayContaining([
						expect.objectContaining({ type: "screenshot" }),
					]),
				});
			if (kind === "nested-computerUse") {
				expect(started).toHaveLength(1);
				expect(started[0]?.data["toolName"]).toBe("Task");
				const childId = metadata["childSessionId"];
				expect(childId).toEqual(expect.any(String));
				const childEvents = snapshot(harness, String(childId));
				const childStarted = childEvents.filter(
					({ type }) => type === "tool.started",
				);
				const childCompleted = childEvents.filter(
					({ type }) => type === "tool.completed",
				);
				expect(childStarted).toHaveLength(1);
				expect(childCompleted).toHaveLength(1);
				expect(
					childStarted.some(({ data }) => data["toolName"] === "ComputerUse"),
				).toBe(true);
				const nestedTool = childCompleted.find(
					({ data }) =>
						(data["metadata"] as Record<string, unknown>)["cursorToolType"] ===
						"computerUse",
				);
				expect(nestedTool?.data["metadata"]).toMatchObject({
					computerUse: {
						actions: expect.arrayContaining([
							expect.objectContaining({ type: "screenshot" }),
						]),
					},
					media: [
						expect.objectContaining({ url: expect.stringMatching(/^data:/) }),
					],
				});
				expect(
					childEvents.some(
						({ type, data }) =>
							type === "text.delta" &&
							data["text"] === "Inspecting the browser",
					),
				).toBe(true);
			}
			scenarios.push({
				kind,
				source: `tool-${kind}.jsonl`,
				started,
				completed,
				attachmentCount: events.filter(({ type }) => type === "file.attached")
					.length,
				completedTurn: true,
			});
		}
		writeTrace("shell");
		await browser.send(
			sessionId,
			"Replay identical captured tool IDs again",
			TIMEOUT,
		);
		const toolStarts = snapshot(harness, sessionId).filter(
			({ type }) => type === "tool.started",
		);
		const db = new Database(harness.daemonStorePath(), { readonly: true });
		try {
			const parts = db
				.prepare<[string], { id: string; messageId: string }>(
					"SELECT mp.id, mp.message_id AS messageId FROM message_parts mp JOIN messages m ON m.id = mp.message_id WHERE m.session_id = ? AND mp.type = 'tool'",
				)
				.all(sessionId);
			expect(parts).toHaveLength(toolStarts.length);
			for (const { data } of toolStarts)
				expect(parts).toContainEqual({
					id: data["partId"],
					messageId: data["messageId"],
				});
			scenarios.push({
				kind: "repeated-captured-tool-ids",
				projectedPartCount: parts.length,
				everyTurnRetainedOwnTools: true,
			});
		} finally {
			db.close();
		}
		expect(harness.proof().rpcDecodeFailures).toEqual([]);
	}, 360_000);
});
