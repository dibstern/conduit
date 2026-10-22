// Failure modes: source events change, a cutoff includes later turns, the fork
// reuses its source's agent/store, hidden context becomes a visible input,
// secrets or tool payloads escape, the digest exceeds its bound, a restart loses
// the seed, a rejected first input consumes it, later turns repeat it, or owned
// runner processes survive cleanup.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-model-types.js";
import { discoverCursorEffect } from "../../../src/lib/provider/cursor/cursor-runner-driver.js";
import {
	cursorSessionStorePath,
	readCursorSessionIdentity,
} from "../../../src/lib/provider/cursor/cursor-session-recovery.js";
import { createTraceCursorSdkPort } from "../../../src/lib/provider/cursor/sdk-trace-player.js";
import { renderForkDigest } from "../../../src/lib/provider/fork-digest.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}

const TIMEOUT = 120_000;
const EVIDENCE = "test-results/conduit-test-hiuf.7.json";

function inheritedDigest(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const messages = db
			.prepare<[string], MessageWithParts>(
				"SELECT * FROM messages WHERE session_id = ? AND is_inherited = 1 ORDER BY created_at, id",
			)
			.all(sessionId);
		for (const message of messages)
			message.parts = db
				.prepare<[string], MessagePartRow>(
					"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				)
				.all(message.id);
		return renderForkDigest(messages);
	} finally {
		db.close();
	}
}

function rows(path: string): TraceRow[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as TraceRow)
		: [];
}

function state(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<
					[string],
					{
						type: string;
						data: string;
						event_id: string;
						metadata: string;
						sequence: number;
						stream_version: number;
						provider: string;
						created_at: number;
					}
				>(
					"SELECT event_id, sequence, stream_version, type, data, metadata, provider, created_at FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId),
			messages: db
				.prepare<[string], { id: string; role: string; text: string }>(
					"SELECT id, role, text FROM messages WHERE session_id = ? ORDER BY created_at, rowid",
				)
				.all(sessionId),
			tools: db
				.prepare<
					[string],
					{ tool_name: string; status: string; input: string; result: string }
				>(
					"SELECT p.tool_name, p.status, p.input, p.result FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND p.type = 'tool' ORDER BY p.sort_order",
				)
				.all(sessionId),
			textParts: db
				.prepare<[string], { text: string }>(
					"SELECT p.text FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND m.role = 'assistant' AND p.type = 'text' ORDER BY m.created_at, p.sort_order",
				)
				.all(sessionId),
			turns: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state: turnState }) => turnState),
			digest: db
				.prepare<[string], { value: string }>(
					"SELECT value FROM provider_state WHERE session_id = ? AND key = 'cursor.forkDigest'",
				)
				.get(sessionId)?.value,
		};
	} finally {
		db.close();
	}
}

function sends(path: string): string[] {
	return rows(path).flatMap(({ kind, data }) =>
		kind === "send.options" &&
		data !== null &&
		typeof data === "object" &&
		"prompt" in data &&
		typeof data.prompt === "string"
			? [data.prompt]
			: [],
	);
}

describe("Cursor transcript forks through the built daemon and detached runner", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let capture = "";
	let sourceId = "";
	const scenarios: Record<string, unknown>[] = [];
	let creationCalls: TraceRow[] = [];
	let creationStart = 0;

	function assertLocalCreation(fixture: ProcessHarness, forkId: string) {
		creationCalls = rows(capture).slice(creationStart);
		expect(creationCalls).toEqual([]);
		expect(state(fixture, forkId).digest).toBeUndefined();
		expect(
			readCursorSessionIdentity(fixture.configDir, forkId),
		).toBeUndefined();
	}

	async function start(name: string, source = "basic") {
		scenario = name;
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
		});
		const fixture = harness;
		const trace = join(fixture.root, "cursor-replay.jsonl");
		capture = join(fixture.root, "cursor-capture.jsonl");
		const sendGate = join(fixture.root, "send.gate");
		creationCalls = [];
		const replay = rows(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		if (!replay.some(({ kind }) => kind === "models.list")) {
			const catalog = rows(
				resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
			).find(({ kind }) => kind === "models.list");
			if (!catalog) throw new Error("Missing captured model catalog");
			replay.splice(1, 0, catalog);
		}
		replay.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			trace,
			`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		expect(
			await Effect.runPromise(
				discoverCursorEffect(createTraceCursorSdkPort(trace)),
			),
		).toMatchObject({ supportsFork: true, supportsRevert: false });
		const restart = (holdBeforeSend = false) =>
			fixture.restart({
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: trace,
					CONDUIT_CURSOR_SDK_CAPTURE: capture,
					CONDUIT_TEST_CURSOR_SEND_GATE: sendGate,
					...(holdBeforeSend
						? { CONDUIT_TEST_HOLD_RUNNER_OUTPUT: "send-turn" }
						: {}),
				},
			});
		await restart();
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor fork replay",
			driver: "cursor",
		});
		if (!addedInstanceId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		sourceId = await browser.createSession(name, addedInstanceId, "cursor", {
			modelId: "composer-2.5",
			contextWindow: "",
			permissionMode: "full",
		});
		return { fixture, browser, id: sourceId, trace, restart, sendGate };
	}

	function freshCapturedAgent(trace: string) {
		const replay = rows(trace);
		const created = replay.find(({ kind }) => kind === "created")?.data;
		if (
			!created ||
			typeof created !== "object" ||
			!("agentId" in created) ||
			typeof created.agentId !== "string"
		)
			throw new Error("Missing captured agent identity");
		const replacement = `agent-${randomUUID()}`;
		writeFileSync(
			trace,
			`${replay
				.map((row) =>
					JSON.stringify(row).replaceAll(
						created.agentId as string,
						replacement,
					),
				)
				.join("\n")}\n`,
		);
		return replacement;
	}

	async function completed(fixture: ProcessHarness, id: string, count: number) {
		await vi.waitFor(
			() => {
				const persisted = state(fixture, id);
				expect(persisted.turns).toEqual(
					Array.from({ length: count }, () => "completed"),
				);
				expect(
					persisted.events.filter(({ type }) => type === "input.sent"),
				).toHaveLength(
					persisted.events.filter(({ type }) => type === "input.admitted")
						.length,
				);
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const observedDigests = sends(capture).flatMap((prompt) => {
			const end = prompt.indexOf("\n\n[Current request]\n");
			return end < 0 ? [] : [prompt.slice(0, end)];
		});
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			scenarios.push({
				scenario: `${scenario}:cleanup`,
				creationProviderCalls: creationCalls,
				firstTurnDigest: observedDigests[0] ?? null,
				seededSends: observedDigests.length,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				invariants: {
					isolatedHomeAndConfig: true,
					realDaemon: proof.generations.every(({ pid }) => pid > 0),
					noRemainingRunner: fixture.remainingRunnerPids().length === 0,
					noRpcDecodeFailure: proof.rpcDecodeFailures.length === 0,
				},
				process: {
					buildIdentity: proof.buildIdentity,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					runnerPids: fixture.runnerPids(),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				EVIDENCE,
				`${JSON.stringify({ ticket: "conduit-test-hiuf.7", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it(
		"copies visible history and seeds a fresh agent once without changing its source",
		async () => {
			const { fixture, browser, id, trace } = await start(
				"fork-isolation",
				"tools-project",
			);
			const sourcePrompt =
				"SOURCE_CONTEXT: inspect this project's files and summarize your work.";
			await browser.send(id, sourcePrompt, TIMEOUT);
			await completed(fixture, id, 1);
			expect(sends(capture).at(-1)).toBe(sourcePrompt);
			expect(state(fixture, id).digest).toBeUndefined();
			const before = state(fixture, id);
			const sourceIdentity = readCursorSessionIdentity(fixture.configDir, id);
			expect(sourceIdentity).toBeDefined();
			expect(before.tools.length).toBeGreaterThan(0);
			const expectedAgent = freshCapturedAgent(trace);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: id,
			});
			expect(forkId).not.toBe(id);
			assertLocalCreation(fixture, forkId);
			const forkBeforeSend = state(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			expect(digest.length).toBeLessThanOrEqual(32_000);
			expect(digest).toContain(sourcePrompt);
			expect(before.textParts.some(({ text }) => text.trim())).toBe(true);
			for (const { text } of before.textParts) expect(digest).toContain(text);
			for (const tool of before.tools) {
				expect(digest).toContain(`Tool: ${tool.tool_name} (${tool.status})`);
				if (tool.input?.length > 20) expect(digest).not.toContain(tool.input);
				if (tool.result?.length > 20) expect(digest).not.toContain(tool.result);
			}
			expect(
				forkBeforeSend.messages.map(({ role, text }) => ({ role, text })),
			).toEqual(before.messages.map(({ role, text }) => ({ role, text })));
			const listed = await fixture.requestRpc({
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
				scope: "process-test",
				roots: false,
			});
			const forkRow = listed.sessions.find(
				({ id: sessionId }) => sessionId === forkId,
			);
			const sourceBoundary = before.messages
				.slice()
				.reverse()
				.find(({ role }) => role === "assistant");
			if (!sourceBoundary) throw new Error("Missing source fork boundary");
			expect(forkRow).toMatchObject({
				forkedFrom: id,
				forkPointMessageId: sourceBoundary.id,
			});
			const history = await browser.history(forkId);
			const renderedHistory = historyToChatMessages(
				history as HistoryMessage[],
			);
			const initialSplit = splitAtForkPoint(
				renderedHistory,
				forkRow?.forkPointMessageId,
				forkRow?.forkPointTimestamp,
				forkId,
			);
			expect(initialSplit.current).toEqual([]);
			expect(initialSplit.inherited).toEqual(renderedHistory);
			const copiedBoundaryParts = renderedHistory.filter(
				(message) =>
					message.messageOrder?.id === `${sourceBoundary.id}_${forkId}`,
			);
			expect(copiedBoundaryParts.length).toBeGreaterThan(1);
			expect(
				copiedBoundaryParts.every((message) =>
					initialSplit.inherited.includes(message),
				),
			).toBe(true);
			const firstPrompt = "Continue the investigation from that prior context.";
			await browser.send(forkId, firstPrompt, TIMEOUT);
			await completed(fixture, forkId, 2);
			const firstSend = sends(capture).at(-1);
			expect(firstSend).toBe(`${digest}\n\n[Current request]\n${firstPrompt}`);
			expect(firstSend?.indexOf(sourcePrompt)).toBeLessThan(
				firstSend?.indexOf(firstPrompt) ?? -1,
			);
			expect(firstSend).toMatch(/prior|previous|historical/i);
			const forkIdentity = readCursorSessionIdentity(fixture.configDir, forkId);
			expect(forkIdentity?.agentId).toBe(expectedAgent);
			expect(forkIdentity?.agentId).not.toBe(sourceIdentity?.agentId);
			expect(cursorSessionStorePath(fixture.configDir, forkId)).not.toBe(
				cursorSessionStorePath(fixture.configDir, id),
			);
			const created = rows(capture).filter(
				({ kind }) => kind === "create.options",
			);
			expect(created).toHaveLength(2);
			expect(JSON.stringify(created.at(-1)?.data)).toContain(
				cursorSessionStorePath(fixture.configDir, forkId),
			);
			expect(
				rows(capture)
					.filter(({ kind }) => kind === "resume.options")
					.some(({ data }) =>
						JSON.stringify(data).includes(sourceIdentity?.agentId ?? "missing"),
					),
			).toBe(false);
			const nextPrompt = "Explain the next step in one sentence.";
			await browser.send(forkId, nextPrompt, TIMEOUT);
			await completed(fixture, forkId, 3);
			expect(sends(capture).at(-1)).toBe(nextPrompt);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.agentId,
			).toBe(forkIdentity?.agentId);
			expect(
				rows(capture).filter(({ kind }) => kind === "create.options"),
			).toHaveLength(2);
			expect(
				rows(capture)
					.filter(({ kind }) => kind === "resume.options")
					.at(-1)?.data,
			).toMatchObject({ agentId: forkIdentity?.agentId });
			const after = state(fixture, forkId);
			expect(after.digest).toBe(digest);
			const copiedIds = new Set(
				forkBeforeSend.messages.map(({ id: messageId }) => messageId),
			);
			expect(
				after.messages
					.filter(
						({ id: messageId, role }) =>
							role === "user" && !copiedIds.has(messageId),
					)
					.map(({ text }) => text),
			).toEqual([firstPrompt, nextPrompt]);
			expect(after.messages.every(({ text }) => !text.includes(digest))).toBe(
				true,
			);
			const visibleInputs = after.events.filter(({ type }) =>
				["message.created", "input.admitted"].includes(type),
			);
			expect(
				visibleInputs.every(
					({ data }) => !data.includes(JSON.stringify(digest).slice(1, -1)),
				),
			).toBe(true);
			expect(await browser.history(forkId)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "user", text: sourcePrompt }),
					expect.objectContaining({ role: "user", text: firstPrompt }),
				]),
			);
			expect(state(fixture, id).events).toEqual(before.events);
			scenarios.push({
				scenario,
				sourceCapture: "tools-project",
				digestCharacters: digest.length,
				invariants: {
					sourceEventsUnchanged: true,
					separateSessionAndStore: true,
					freshAgentCreated: true,
					visibleHistoryInherited: true,
					digestHiddenFromHistory: true,
					firstSendSeeded: true,
					laterSendUnseeded: true,
					toolPayloadsOmitted: true,
				},
			});
		},
		TIMEOUT * 4,
	);

	it(
		"settles an accepted first seed after its runner crashes before send returns",
		async () => {
			const { fixture, browser, id, trace, restart, sendGate } =
				await start("fork-crash-retry");
			await browser.send(id, "Remember the inherited context.", TIMEOUT);
			await completed(fixture, id, 1);
			freshCapturedAgent(trace);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: id,
			});
			assertLocalCreation(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			writeFileSync(sendGate, "hold");
			const pending = browser
				.send(forkId, "First fork request", TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() => {
					expect(sends(capture)).toHaveLength(2);
					const persisted = JSON.parse(
						readFileSync(
							join(
								cursorSessionStorePath(fixture.configDir, forkId),
								"trace-state.json",
							),
							"utf8",
						),
					) as unknown;
					expect(persisted).toMatchObject({ activeRun: { status: "running" } });
				},
				{ timeout: TIMEOUT },
			);
			expect(sends(capture).at(-1)).toBe(
				`${digest}\n\n[Current request]\nFirst fork request`,
			);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(true);
			const owned = fixture.marks.find(
				(mark) => mark.kind === "runner-started" && mark.sessionId === forkId,
			);
			if (owned?.kind !== "runner-started")
				throw new Error("Missing owned fork runner");
			process.kill(owned.pid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(owned.pid, 0)).toThrow(),
				{ timeout: TIMEOUT },
			);
			rmSync(sendGate, { force: true });
			await pending;
			await vi.waitFor(
				() =>
					expect(state(fixture, forkId).turns).toEqual(["completed", "error"]),
				{ timeout: TIMEOUT },
			);
			await fixture.kill();
			await restart();
			const reconnected = await fixture.connect(forkId);
			await reconnected.send(forkId, "Retry after the crash", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(state(fixture, forkId).turns).toEqual([
						"completed",
						"error",
						"completed",
					]),
				{ timeout: TIMEOUT },
			);
			expect(sends(capture).at(-1)).toBe("Retry after the crash");
			expect(
				sends(capture).filter((prompt) =>
					prompt.includes("[Conduit fork context]"),
				),
			).toHaveLength(1);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(false);
		},
		TIMEOUT * 4,
	);

	it(
		"restores the first-turn digest when the daemon crashes before the runner receives its command",
		async () => {
			const { fixture, browser, id, trace, restart } = await start(
				"fork-unseen-command-retry",
			);
			await browser.send(
				id,
				"Keep the source context for a future fork.",
				TIMEOUT,
			);
			await completed(fixture, id, 1);
			freshCapturedAgent(trace);
			await fixture.kill();
			await restart(true);
			const before = await fixture.connect(id);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: before.originId,
				sessionId: id,
			});
			assertLocalCreation(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			const prompt = "Continue this fork after recovery.";
			const pending = before
				.send(forkId, prompt, TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() => {
					expect(
						rows(join(fixture.root, "sdk-proof.ndjson")).some(
							({ kind, type }) =>
								kind === "held-output" && type === "send-turn",
						),
					).toBe(true);
				},
				{ timeout: TIMEOUT },
			);
			expect(state(fixture, forkId).digest).toBe(digest);
			expect(sends(capture)).toHaveLength(1);
			const owned = fixture.marks.find(
				(mark) => mark.kind === "runner-started" && mark.sessionId === forkId,
			);
			if (owned?.kind !== "runner-started")
				throw new Error("Missing owned fork runner");
			await fixture.kill();
			await pending;
			await restart();
			await completed(fixture, forkId, 2);
			expect(
				fixture.marks
					.filter(
						(mark) =>
							mark.kind === "runner-started" && mark.sessionId === forkId,
					)
					.at(-1),
			).toMatchObject({ pid: owned.pid });
			expect(sends(capture).at(-1)).toBe(
				`${digest}\n\n[Current request]\n${prompt}`,
			);
			const after = await fixture.connect(forkId);
			await after.send(forkId, "Next fork request", TIMEOUT);
			await completed(fixture, forkId, 3);
			expect(sends(capture).at(-1)).toBe("Next fork request");
			expect(
				sends(capture).filter((text) =>
					text.includes("[Conduit fork context]"),
				),
			).toHaveLength(1);
		},
		TIMEOUT * 4,
	);

	it(
		"honors an explicit message cutoff in both copied history and digest",
		async () => {
			const { fixture, browser, id, trace } = await start("fork-cutoff");
			const early = "BEFORE_CUTOFF: the project codename is silver-orbit.";
			const later =
				"AFTER_CUTOFF: this later instruction must not reach the fork.";
			await browser.send(id, early, TIMEOUT);
			await completed(fixture, id, 1);
			const firstAnswer = state(fixture, id).messages.find(
				({ role }) => role === "assistant",
			);
			if (!firstAnswer) throw new Error("Missing cutoff assistant message");
			await browser.send(id, later, TIMEOUT);
			await completed(fixture, id, 2);
			const before = state(fixture, id).events;
			freshCapturedAgent(trace);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: id,
				messageId: firstAnswer.id,
			});
			const fork = state(fixture, forkId);
			assertLocalCreation(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			expect(digest).toContain(early);
			expect(digest).not.toContain(later);
			expect(fork.messages.map(({ text }) => text)).toContain(early);
			expect(fork.messages.map(({ text }) => text)).not.toContain(later);
			await browser.send(forkId, "Continue from this point.", TIMEOUT);
			await completed(fixture, forkId, 2);
			expect(state(fixture, forkId).digest).toBe(digest);
			expect(sends(capture).at(-1)).toContain(early);
			expect(sends(capture).at(-1)).not.toContain(later);
			expect(state(fixture, id).events).toEqual(before);
			scenarios.push({
				scenario,
				invariants: {
					explicitCutoffHonored: true,
					sourceEventsUnchanged: true,
				},
			});
		},
		TIMEOUT * 4,
	);

	it(
		"bounds and redacts large context and retains its seed across restart before the first send",
		async () => {
			const { fixture, browser, id, trace, restart } = await start(
				"fork-bounded-restart",
			);
			const secret = "fixture-secret-do-not-copy-2146";
			const bearer = "fixture-bearer-do-not-copy-5168";
			const environmentSecret = "fixture-secret-env";
			const awsSecret = "fixture-aws-secret-inert";
			const basicCredential = "fixture-base64-inert";
			const cookie = "fixture-cookie-inert";
			const secondCookie = "fixture-second-cookie-inert";
			const recent = `RECENT_CONTEXT: apiKey=${secret}\nCURSOR_API_KEY=${environmentSecret}\nAWS_SECRET_ACCESS_KEY=${awsSecret}\nAuthorization: Bearer ${bearer}\nAuthorization: Basic ${basicCredential}\nCookie: auth=${cookie}; session=${secondCookie}\nAlready redacted: apiKey=[REDACTED]\nPrivate path /Users/fixture-user/private-project. Preserve the final marker amber-lake.`;
			await browser.send(
				id,
				`OLD_CONTEXT_BEGIN\n${"older context ".repeat(4_000)}\n${recent}`,
				TIMEOUT,
			);
			await completed(fixture, id, 1);
			const before = state(fixture, id).events;
			freshCapturedAgent(trace);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: id,
			});
			assertLocalCreation(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			expect(digest.length).toBeLessThanOrEqual(32_000);
			expect(digest).toContain("amber-lake");
			expect(digest).not.toContain("OLD_CONTEXT_BEGIN");
			for (const privateValue of [
				secret,
				bearer,
				environmentSecret,
				awsSecret,
				basicCredential,
				cookie,
				secondCookie,
				"/Users/fixture-user",
			])
				expect(digest).not.toContain(privateValue);
			expect(digest).toContain("[REDACTED]");
			expect(digest).not.toContain("[REDACTED]]");
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId),
			).toBeUndefined();
			await fixture.kill();
			await restart();
			const reconnected = await fixture.connect();
			const prompt = "Continue using the remembered final marker.";
			await reconnected.send(forkId, prompt, TIMEOUT);
			await completed(fixture, forkId, 2);
			expect(sends(capture).at(-1)).toContain(digest);
			expect(sends(capture).at(-1)).toContain(prompt);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(false);
			await reconnected.send(forkId, "One more sentence.", TIMEOUT);
			await completed(fixture, forkId, 3);
			expect(sends(capture).at(-1)).toBe("One more sentence.");
			expect(state(fixture, id).events).toEqual(before);
			scenarios.push({
				scenario,
				digestCharacters: digest.length,
				invariants: {
					boundedIncludingFraming: true,
					secretsRedacted: true,
					recentContextRetained: true,
					seedSurvivesRestartBeforeFirstSend: true,
					seedCompletionPersisted: true,
					laterSendUnseeded: true,
					sourceEventsUnchanged: true,
				},
			});
		},
		TIMEOUT * 4,
	);

	it(
		"seeds a new input after the first fork send is rejected and its runner restarts",
		async () => {
			const { fixture, browser, id, trace, restart } = await start(
				"fork-rejected-first-send",
			);
			await browser.send(id, "Remember source context silver-orbit.", TIMEOUT);
			await completed(fixture, id, 1);
			const before = state(fixture, id).events;
			freshCapturedAgent(trace);
			creationStart = rows(capture).length;
			const { sessionId: forkId } = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: id,
			});
			assertLocalCreation(fixture, forkId);
			const digest = inheritedDigest(fixture, forkId);
			const replay = rows(trace);
			const sendIndex = replay.findIndex(({ kind }) => kind === "send.options");
			if (sendIndex < 0) throw new Error("Missing captured send");
			// Existing port error envelope, not an SDK stream variant.
			replay.splice(sendIndex + 1, 0, {
				kind: "send.error",
				data: { authRequired: true },
			});
			writeFileSync(
				trace,
				`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
			await browser.send(
				forkId,
				"First fork input, rejected by the provider.",
				TIMEOUT,
			);
			await vi.waitFor(
				() =>
					expect(state(fixture, forkId).turns).toEqual(["completed", "error"]),
				{ timeout: TIMEOUT },
			);
			expect(sends(capture).at(-1)).toContain(digest);
			expect(
				rows(capture).filter(({ kind }) => kind === "send.error"),
			).toHaveLength(1);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(true);
			writeFileSync(
				trace,
				`${replay
					.filter(({ kind }) => kind !== "send.error")
					.map((row) => JSON.stringify(row))
					.join("\n")}\n`,
			);
			const owned = fixture.marks.find(
				(mark) => mark.kind === "runner-started" && mark.sessionId === forkId,
			);
			if (owned?.kind !== "runner-started")
				throw new Error("Missing owned fork runner");
			await fixture.kill();
			process.kill(owned.pid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(owned.pid, 0)).toThrow(),
				{ timeout: TIMEOUT },
			);
			await restart();
			const reconnected = await fixture.connect();
			const next = "Try a new input using the prior source context.";
			await reconnected.send(forkId, next, TIMEOUT);
			await vi.waitFor(
				() =>
					expect(state(fixture, forkId).turns).toEqual([
						"completed",
						"error",
						"completed",
					]),
				{ timeout: TIMEOUT },
			);
			expect(sends(capture).at(-1)).toContain(digest);
			expect(sends(capture).at(-1)).toContain(next);
			expect(
				readCursorSessionIdentity(fixture.configDir, forkId)?.forkSeedPending,
			).toBe(false);
			await reconnected.send(forkId, "Continue once more.", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(state(fixture, forkId).turns).toEqual([
						"completed",
						"error",
						"completed",
						"completed",
					]),
				{ timeout: TIMEOUT },
			);
			expect(sends(capture).at(-1)).toBe("Continue once more.");
			expect(sends(capture)).toHaveLength(4);
			expect(state(fixture, id).events).toEqual(before);
			scenarios.push({
				scenario,
				invariants: {
					rejectedInputDoesNotConsumeSeed: true,
					seedSurvivesRunnerRestart: true,
					laterSendUnseeded: true,
					sourceEventsUnchanged: true,
				},
			});
		},
		TIMEOUT * 4,
	);
});
