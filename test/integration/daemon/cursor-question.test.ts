// Failure modes: answers never reach the callback, resumed agents lose tools,
// restart loses an ask, interrupt leaves a callback alive, or a child's parent
// context sessionId hides the asking subagent.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_DRIVERS } from "../../../src/lib/contracts/provider-instance.js";
import { AddInstance } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}

const TIMEOUT = 90_000;
const QUESTION = {
	question: "Which deployment?",
	header: "Deployment",
	options: [
		{ label: "Blue", description: "Blue deployment" },
		{ label: "Green", description: "Green deployment" },
	],
	multiSelect: false,
	custom: true,
};

function traceRows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

function snapshot(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<[string], { type: string; data: string }>(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('question.asked', 'question.resolved', 'turn.completed', 'turn.interrupted', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId)
				.map(({ type, data }) => ({
					type,
					data: JSON.parse(data) as Record<string, unknown>,
				})),
			turns: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state }) => state),
		};
	} finally {
		db.close();
	}
}

describe("Cursor questions through the built daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	let capturePath = "";
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	async function start(
		scenario: string,
		source = "question-basic",
		malformedThenDuplicate = false,
	) {
		evidence = { scenario, sourceFixture: `${source}.jsonl`, assertions: {} };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const fixture = harness;
		const tracePath = join(fixture.root, "cursor-question-replay.jsonl");
		capturePath = join(fixture.root, "cursor-question-capture.jsonl");
		let rows = traceRows(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		if (source === "question-basic") {
			const custom = rows.find(({ kind }) => kind === "custom.start")?.data as {
				context: { toolCallId: string };
			};
			const second = JSON.parse(
				JSON.stringify(
					rows.slice(rows.findIndex(({ kind }) => kind === "send.options")),
				).replaceAll(
					custom.context.toolCallId,
					`${custom.context.toolCallId}-second`,
				),
			) as TraceRow[];
			if (malformedThenDuplicate) {
				rows = JSON.parse(
					JSON.stringify(rows).replaceAll(
						JSON.stringify({ questions: [QUESTION] }),
						JSON.stringify({ questions: [] }),
					),
				) as TraceRow[];
				const index = second.findIndex(({ kind }) => kind === "custom.start");
				const callback = second[index];
				if (!callback)
					throw new Error("Question capture has no custom callback");
				second.splice(index + 1, 0, callback);
			}
			rows.push(...second);
		}
		const catalog = traceRows(
			resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
		).find(({ kind }) => kind === "models.list");
		if (!catalog) throw new Error("Basic capture has no model catalog");
		rows.splice(1, 0, catalog, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			tracePath,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
			},
		});
		const added = await fixture.requestRpc(
			new AddInstance({ name: "Cursor question replay", driver: "cursor" }),
		);
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		sessionId = await browser.createSession(
			scenario,
			added.addedInstanceId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "ask",
			},
		);
		return {
			fixture,
			browser,
			id: sessionId,
			accountId: added.addedInstanceId,
		};
	}

	async function ask(browser: ProcessBrowser, id: string) {
		const cursor = browser.frames.length;
		await Effect.runPromise(
			browser.rpc.input.submit({
				sessionId: id,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Ask me which deployment to use with ask_user.",
			}),
		);
		return browser.waitFor(
			(message) =>
				message["type"] === "question_pending" && message["sessionId"] === id,
			cursor,
			TIMEOUT,
		);
	}

	async function answer(
		browser: ProcessBrowser,
		question: Record<string, unknown>,
		text: string,
	) {
		expect(
			await Effect.runPromise(
				browser.rpc.AnswerQuestion({
					projectSlug: "process-test",
					originId: browser.originId,
					commandId: randomUUID(),
					toolId: String(question["toolId"]),
					answers: { "0": text },
				}),
			),
		).toEqual({ ok: true });
	}

	async function expectTurns(
		fixture: ProcessHarness,
		id: string,
		states: readonly string[],
	) {
		await vi.waitFor(
			() => expect(snapshot(fixture, id).turns).toEqual(states),
			{
				timeout: TIMEOUT,
				interval: 100,
			},
		);
	}

	async function expectResult(result: string, count = 1) {
		await vi.waitFor(
			() =>
				expect(
					traceRows(capturePath).filter(({ kind }) => kind === "custom.result"),
				).toHaveLength(count),
			{ timeout: TIMEOUT },
		);
		expect(
			traceRows(capturePath)
				.filter(({ kind }) => kind === "custom.result")
				.at(-1)?.data,
		).toMatchObject({
			toolName: "ask_user",
			context: {
				toolCallId: expect.any(String),
				sessionId: expect.any(String),
			},
			result,
		});
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		const captured = traceRows(capturePath);
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
			expect(fixture.proof().rpcDecodeFailures).toEqual([]);
		} finally {
			const proof = fixture.proof();
			scenarios.push({
				...evidence,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				stored: state,
				captured: captured.filter(({ kind }) =>
					[
						"create.options",
						"resume.options",
						"send.options",
						"custom.start",
						"custom.result",
						"cancel.call",
					].includes(kind ?? ""),
				),
				process: {
					buildIdentity: proof.buildIdentity,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					runnerPids: fixture.runnerPids(),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					rpcDecodeFailures: proof.rpcDecodeFailures,
					isolatedConfig: true,
					onlyOwnedProcessesStopped: true,
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.9.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.9", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
			sessionId = undefined;
		}
	});

	it("returns option and custom answers and configures ask_user on create and resume", async () => {
		const { fixture, browser, id, accountId } = await start(
			"option-and-custom-answer",
		);
		const instances = await browser.instances();
		expect(
			instances.instances.find(
				({ id: instanceId }) => instanceId === accountId,
			),
		).toMatchObject({ driver: "cursor", available: true });
		expect(instances.providerTraits?.["cursor"]).toMatchObject({
			supportsQuestionSkip: false,
		});
		expect(PROVIDER_DRIVERS.cursor.promptsSurviveRestart).toBe(true);
		const question = await ask(browser, id);
		expect(question["questions"]).toEqual([QUESTION]);
		expect(snapshot(fixture, id).turns).toEqual(["running"]);
		await answer(browser, question, "Blue");
		await expectResult('{"0":"Blue"}');
		await expectTurns(fixture, id, ["completed"]);
		const second = await ask(browser, id);
		expect(second["questions"]).toEqual([QUESTION]);
		await answer(browser, second, "Canary first, then production");
		await expectResult('{"0":"Canary first, then production"}', 2);
		await expectTurns(fixture, id, ["completed", "completed"]);
		const captured = traceRows(capturePath);
		const configurations = captured.filter(
			({ kind }) => kind === "create.options" || kind === "resume.options",
		);
		expect(configurations.map(({ kind }) => kind)).toEqual([
			"create.options",
			"resume.options",
		]);
		for (const { data } of configurations) {
			expect(data).toMatchObject({
				local: { customTools: ["ask_user"] },
				disallowedTools: expect.arrayContaining(["askQuestion"]),
			});
			expect(
				(data as { disallowedTools: string[] }).disallowedTools,
			).not.toContain("mcp");
		}
		for (const { data } of captured.filter(
			({ kind }) => kind === "send.options",
		))
			expect(data).toMatchObject({
				prompt: expect.stringContaining("ask_user"),
			});
		expect(
			snapshot(fixture, id).events.filter(
				({ type }) => type === "question.asked",
			),
		).toHaveLength(2);
		expect(
			snapshot(fixture, id)
				.events.filter(({ type }) => type === "question.resolved")
				.map(({ data }) => data["answers"]),
		).toEqual([{ "0": "Blue" }, { "0": "Canary first, then production" }]);
		evidence["assertions"] = {
			optionAnswer: true,
			customAnswer: true,
			customToolsOnCreateAndResume: true,
			builtInAskQuestionDisallowed: true,
			mcpAllowed: true,
			restartTrait: true,
			questionSkipUnsupported: true,
		};
	}, 240_000);

	it("keeps a pending question through daemon replacement with the same runner", async () => {
		const { fixture, browser, id } = await start(
			"pending-across-daemon-restart",
		);
		const question = await ask(browser, id);
		const runners = fixture.runnerPids();
		expect(runners).toHaveLength(1);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "custom.result"),
		).toHaveLength(0);
		await fixture.kill();
		expect(fixture.remainingRunnerPids()).toEqual(runners);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: join(
					fixture.root,
					"cursor-question-replay.jsonl",
				),
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
			},
		});
		const reconnected = await fixture.connect(id);
		const recovered = await reconnected.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				message["toolId"] === question["toolId"],
			0,
			TIMEOUT,
		);
		expect(recovered["questions"]).toEqual([QUESTION]);
		expect(recovered["sessionId"]).toBe(id);
		expect(fixture.runnerPids()).toEqual(runners);
		await answer(reconnected, recovered, "Green");
		await expectResult('{"0":"Green"}');
		await expectTurns(fixture, id, ["completed"]);
		const state = snapshot(fixture, id);
		expect(
			state.events.filter(({ type }) => type === "question.asked"),
		).toHaveLength(1);
		expect(
			state.events.filter(({ type }) => type === "question.resolved"),
		).toHaveLength(1);
		expect(fixture.runnerPids()).toEqual(runners);
		evidence["assertions"] = {
			pendingRecovered: true,
			sameRequest: true,
			sameRunner: true,
			answerReachedOriginalCallback: true,
			askedStoredOnce: true,
			resolvedStoredOnce: true,
		};
	}, 240_000);

	it("rejects malformed arguments without a pending ask and reuses a duplicate callback answer", async () => {
		const { fixture, browser, id } = await start(
			"malformed-and-duplicate",
			"question-basic",
			true,
		);
		await browser.send(id, "Replay the malformed ask_user call.", TIMEOUT);
		await expectTurns(fixture, id, ["completed"]);
		await expectResult(
			"Invalid ask_user arguments: supply nonempty questions with header, question and options.",
		);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "question_pending",
			),
		).toEqual([]);
		expect(
			snapshot(fixture, id).events.filter(
				({ type }) => type === "question.asked",
			),
		).toEqual([]);
		const question = await ask(browser, id);
		await answer(browser, question, "Green");
		await expectResult('{"0":"Green"}', 3);
		await expectTurns(fixture, id, ["completed", "completed"]);
		const results = traceRows(capturePath).filter(
			({ kind }) => kind === "custom.result",
		);
		expect(results[2]?.data).toEqual(results[1]?.data);
		expect(results.slice(1).map(({ data }) => data)).toEqual([
			expect.objectContaining({ result: '{"0":"Green"}' }),
			expect.objectContaining({ result: '{"0":"Green"}' }),
		]);
		const state = snapshot(fixture, id);
		expect(
			state.events.filter(({ type }) => type === "question.asked"),
		).toHaveLength(1);
		expect(
			state.events.filter(({ type }) => type === "question.resolved"),
		).toHaveLength(1);
		evidence["assertions"] = {
			malformedArgsReturnedToolError: true,
			noMalformedPendingQuestion: true,
			duplicateCallbackAnsweredTwice: true,
			duplicateAskStoredOnce: true,
			duplicateResolutionStoredOnce: true,
		};
	}, 240_000);

	it("settles an open custom callback when interrupted and permits a following turn", async () => {
		const { fixture, browser, id } = await start(
			"interrupt-open-question",
			"question-cancel",
		);
		const question = await ask(browser, id);
		expect(question["questions"]).toEqual([QUESTION]);
		const cursor = browser.frames.length;
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
		);
		await expectTurns(fixture, id, ["interrupted"]);
		await expectResult("Question cancelled: turn interrupted");
		await browser.waitFor(
			(message) =>
				message["type"] === "approval_removed" &&
				message["id"] === question["toolId"],
			cursor,
			TIMEOUT,
		);
		expect(
			traceRows(capturePath).some(({ kind }) => kind === "cancel.call"),
		).toBe(true);
		const reconnected = await fixture.connect(id);
		expect(
			reconnected.frames.filter(
				({ message }) => message["type"] === "question_pending",
			),
		).toEqual([]);
		expect(
			(await reconnected.send(id, "Say cancel followup.", TIMEOUT)).chunks.join(
				"",
			),
		).toBe("cancel followup");
		await expectTurns(fixture, id, ["interrupted", "completed"]);
		expect(
			snapshot(fixture, id).events.filter(({ type }) => type === "turn.error"),
		).toEqual([]);
		evidence["assertions"] = {
			interrupted: true,
			customCallbackSettled: true,
			questionRemoved: true,
			noQuestionOnReconnect: true,
			nextTurnCompleted: true,
		};
	}, 240_000);

	it("labels a subagent ask using nested Task call IDs despite its parent context sessionId", async () => {
		const { fixture, browser, id } = await start(
			"subagent-question",
			"question-subagent",
		);
		const source = traceRows(
			resolve("test/fixtures/cursor-sdk-traces/question-subagent.jsonl"),
		);
		const custom = source.find(({ kind }) => kind === "custom.start")?.data as {
			context: { toolCallId: string; sessionId: string };
			parentId: string;
		};
		expect(custom.context.sessionId).toBe(custom.parentId);
		expect(
			source.some(
				({ kind, data }) =>
					kind === "delta" &&
					(data as { taskUpdate?: { callId?: string } }).taskUpdate?.callId ===
						custom.context.toolCallId,
			),
		).toBe(true);
		const question = await ask(browser, id);
		expect(question["sessionId"]).toBe(id);
		expect(question["questions"]).toEqual([
			{ ...QUESTION, header: "spike: Deployment" },
		]);
		await answer(browser, question, "Blue");
		await expectResult('{"0":"Blue"}');
		await expectTurns(fixture, id, ["completed"]);
		expect(
			snapshot(fixture, id).events.filter(
				({ type }) => type === "question.asked",
			),
		).toHaveLength(1);
		evidence["assertions"] = {
			parentSessionUsed: true,
			parentValuedContextPreserved: true,
			nestedTaskCallIdMatched: true,
			askingSubagentNamed: true,
			answerReturned: true,
		};
	}, 240_000);
});
