import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	HistoryMessageSchema,
	SessionDetailEnvelopeSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import {
	firstQueryMark,
	type QueryMark,
} from "../../helpers/claude-process-marks.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

type DetailEnvelope = typeof SessionDetailEnvelopeSchema.Type;
type HistoryMessage = typeof HistoryMessageSchema.Type;
type NativeMessage = SessionMessage & { parentUuid?: string | null };

function queries(harness: ProcessHarness): QueryMark[] {
	return harness.marks.filter(
		(mark): mark is QueryMark => mark.kind === "query",
	);
}

/** Folds the daemon's frames through the browser's own transcript store. */
function detailState(browser: ProcessBrowser, sessionId: string) {
	const entry = browser.frames
		.map(({ message }) => message)
		.filter(
			(message) =>
				message["type"] === "session_detail" &&
				message["sessionId"] === sessionId,
		)
		.reduce<TranscriptEntry>(
			(held, message) =>
				applyTranscriptEnvelope(held, message as unknown as DetailEnvelope),
			{
				project: "process-test",
				rows: [],
				pending: [],
				hwm: null,
				hasMore: false,
				status: { _tag: "live" },
				waiting: new Map(),
				partOrder: new Map(),
			},
		);
	/** The messages the browser holds whole: a header and its parts. */
	return entry.rows
		.filter((row) => (row.parts?.length ?? 0) > 0)
		.map(({ id }) => id);
}

/** 82tn.51: a rewind lands at once as a Head Log move; there is no pending cut left to read. */
const headLog = async (browser: ProcessBrowser, sessionId: string) =>
	(await Effect.runPromise(browser.rpc.GetHeadLog({ sessionId }))).entries;

function nativeTranscript(harness: ProcessHarness, nativeSessionId: string) {
	return readFileSync(
		join(
			harness.root,
			"claude",
			`conduit-test-transcript-${nativeSessionId}.ndjson`,
		),
		"utf8",
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as NativeMessage);
}

function nativeConversation(transcript: NativeMessage[]) {
	const byUuid = new Map(transcript.map((entry) => [entry.uuid, entry]));
	const conversation: NativeMessage[] = [];
	for (
		let entry = transcript.at(-1);
		entry;
		entry = entry.parentUuid ? byUuid.get(entry.parentUuid) : undefined
	)
		conversation.unshift(entry);
	return conversation;
}

function messageText(message: HistoryMessage) {
	const text = message["text"];
	return typeof text === "string"
		? text
		: (message.parts ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("");
}

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			activeCommands: (
				db
					.prepare(
						"SELECT count(*) AS n FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' AND status IN ('pending', 'running', 'retryable_failed')",
					)
					.get(sessionId) as { n: number }
			).n,
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('head.move_started', 'head.moved', 'session.rewind_committed', 'message.removed', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			messages: db
				.prepare(
					"SELECT id FROM messages WHERE session_id = ? ORDER BY created_at, id",
				)
				.all(sessionId) as Array<{ id: string }>,
		};
	} finally {
		db.close();
	}
}

describe("Claude rewind through the detached runner and real relay", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async (context) => {
		if (!harness) return;
		const fixture = harness;
		harness = undefined;
		try {
			evidence["sdk"] = fixture.marks.filter(
				(mark) =>
					mark.kind === "query" ||
					mark.kind === "query-closed" ||
					mark.kind === "enqueue" ||
					mark.kind === "native-fork",
			);
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results/rewind", { recursive: true });
			writeFileSync(
				`test-results/rewind/claude-${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
			);
		}
	});

	// Failure cases: the rewind or undo touches the SDK, the warm query ignores
	// the cursor, canonical message IDs are confused with native chain UUIDs,
	// later turns reappear on reload, or the cursor is applied to every turn.
	it("undo restores the cut turns and the next send resumes inclusively at the last kept assistant UUID (82tn.51)", async () => {
		harness = await ProcessHarness.start();
		evidence = {
			tickets: [
				"conduit-test-qqqm",
				"conduit-test-bu61",
				"conduit-test-82tn.51",
			],
		};
		mkdirSync(join(harness.root, "claude"), { recursive: true });
		writeFileSync(
			join(harness.root, "claude", "conduit-test-record-forks"),
			"record",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Claude landed rewind");
		// Native cursors publish when the send command settles, after shell idle.
		for (const prompt of ["rewind-kept", "rewind-discarded", "rewind-later"]) {
			await browser.send(sessionId, prompt);
			await vi.waitFor(() =>
				expect(
					persisted(harness as ProcessHarness, sessionId).activeCommands,
				).toBe(0),
			);
		}
		const before = await browser.history(sessionId);
		const cut = before.findIndex(
			(message) =>
				message.role === "user" && messageText(message) === "rewind-discarded",
		);
		expect(cut).toBeGreaterThan(0);
		const target = before[cut];
		if (!target) throw new Error("Missing rewind target");
		const kept = before.slice(0, cut);
		const hidden = before.slice(cut);
		const lastAssistant = kept
			.filter((message) => message.role === "assistant")
			.at(-1);
		if (!lastAssistant) throw new Error("Missing kept assistant");
		const originalQuery = await firstQueryMark(harness);
		expect(queries(harness)).toHaveLength(1);
		const originalNative = nativeTranscript(harness, originalQuery.sessionId);
		const nativeAssistant = originalNative.find(
			(entry) =>
				entry.type === "assistant" &&
				(entry.message as { id?: string }).id === lastAssistant.id,
		);
		if (!nativeAssistant)
			throw new Error("Missing assistant native chain UUID");
		expect(nativeAssistant.uuid).not.toBe(lastAssistant.id);
		const second = await harness.connect(sessionId);
		const rewind = () =>
			Effect.runPromise(
				browser.rpc.RewindSession({
					sessionId,
					messageId: target.id,
				}),
			);

		await rewind();
		// 82tn.51: the rewind lands at once as a Head Log move. Claude hears of it at the next send.
		const reloadedRewound = await harness.connect(sessionId);
		await vi.waitFor(async () =>
			expect(await headLog(reloadedRewound, sessionId)).toEqual([
				expect.objectContaining({
					kind: "rewind",
					messageId: target.id,
					landed: true,
				}),
			]),
		);
		for (const tab of [browser, second, reloadedRewound])
			expect((await tab.history(sessionId)).map(({ id }) => id)).toEqual(
				kept.map(({ id }) => id),
			);
		expect(queries(harness)).toHaveLength(1);
		expect(nativeTranscript(harness, originalQuery.sessionId)).toEqual(
			originalNative,
		);
		evidence["rewound"] = persisted(harness, sessionId);

		await Effect.runPromise(second.rpc.UndoRewind({ sessionId }));
		await vi.waitFor(() => {
			// Restored live, with their parts, without a reload.
			for (const tab of [browser, second, reloadedRewound])
				expect(detailState(tab, sessionId)).toEqual(
					expect.arrayContaining(hidden.map(({ id }) => id)),
				);
		});
		expect((await second.history(sessionId)).map(({ id }) => id)).toEqual(
			before.map(({ id }) => id),
		);
		expect(queries(harness)).toHaveLength(1);
		expect(nativeTranscript(harness, originalQuery.sessionId)).toEqual(
			originalNative,
		);

		await rewind();
		await browser.send(sessionId, "rewind-committed");
		await vi.waitFor(() =>
			expect(queries(harness as ProcessHarness)).toHaveLength(2),
		);
		const committedQuery = queries(harness).at(-1);
		if (!committedQuery) throw new Error("Missing resumed query");
		expect(queries(harness)).toHaveLength(2);
		expect(committedQuery.queryId).not.toBe(originalQuery.queryId);
		expect(committedQuery.sessionId).toBe(originalQuery.sessionId);
		expect(JSON.parse(committedQuery.optionsJson) as unknown).toMatchObject({
			resumeSessionAt: nativeAssistant.uuid,
		});
		expect(harness.marks).toContainEqual(
			expect.objectContaining({
				kind: "query-closed",
				queryId: originalQuery.queryId,
			}),
		);
		expect(harness.marks).toContainEqual(
			expect.objectContaining({
				kind: "enqueue",
				queryId: committedQuery.queryId,
				prompt: "rewind-committed",
			}),
		);
		expect(harness.marks.filter((mark) => mark.kind === "native-fork")).toEqual(
			[],
		);
		const reloaded = await harness.connect(sessionId);
		const committed = await reloaded.history(sessionId);
		expect(committed.map(({ id }) => id)).toEqual(
			expect.arrayContaining(kept.map(({ id }) => id)),
		);
		for (const { id } of hidden)
			expect(committed.map((message) => message.id)).not.toContain(id);
		// 82tn.51: the Head Log keeps every move, newest first; the undo stays undoable.
		expect(
			(await headLog(reloaded, sessionId)).map(({ kind }) => kind),
		).toEqual(["rewind", "undo", "rewind"]);
		await vi.waitFor(() =>
			expect(
				persisted(harness as ProcessHarness, sessionId).activeCommands,
			).toBe(0),
		);
		await browser.send(sessionId, "rewind-after-commit");
		expect(queries(harness)).toHaveLength(2);
		const nativeFile = nativeTranscript(harness, committedQuery.sessionId);
		const nativeAfter = nativeConversation(nativeFile);
		const keptNative = originalNative.slice(
			0,
			originalNative.indexOf(nativeAssistant) + 1,
		);
		expect(nativeAfter.slice(0, keptNative.length)).toEqual(keptNative);
		const nativeText = JSON.stringify(nativeAfter);
		expect(nativeText).toContain("rewind-kept");
		expect(nativeText).toContain("rewind-committed");
		expect(nativeText).toContain("rewind-after-commit");
		expect(nativeText).not.toContain("rewind-discarded");
		expect(nativeText).not.toContain("rewind-later");
		evidence["before"] = before;
		evidence["committed"] = persisted(harness, sessionId);
		evidence["nativeAfter"] = nativeAfter;
		evidence["nativeFile"] = nativeFile;
	}, 90_000);

	it("rewinding to the first turn starts a fresh native conversation at the next send (82tn.51)", async () => {
		harness = await ProcessHarness.start();
		evidence = { ticket: "conduit-test-qqqm" };
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Claude first-turn rewind");
		await browser.send(sessionId, "rewind-first");
		await vi.waitFor(() =>
			expect(
				persisted(harness as ProcessHarness, sessionId).activeCommands,
			).toBe(0),
		);
		const before = await browser.history(sessionId);
		const first = before[0];
		if (!first) throw new Error("Missing first turn");
		expect(first.role).toBe("user");
		const original = await firstQueryMark(harness);
		const rewind = () =>
			Effect.runPromise(
				browser.rpc.RewindSession({
					sessionId,
					messageId: first.id,
				}),
			);
		await rewind();
		expect(await browser.history(sessionId)).toEqual([]);
		await Effect.runPromise(browser.rpc.UndoRewind({ sessionId }));
		expect((await browser.history(sessionId)).map(({ id }) => id)).toEqual(
			before.map(({ id }) => id),
		);
		expect(queries(harness)).toHaveLength(1);
		await rewind();
		await browser.send(sessionId, "rewind-fresh");
		await vi.waitFor(() =>
			expect(queries(harness as ProcessHarness)).toHaveLength(2),
		);
		const fresh = queries(harness).at(-1);
		if (!fresh) throw new Error("Missing fresh query");
		expect(queries(harness)).toHaveLength(2);
		expect(fresh.sessionId).not.toBe(original.sessionId);
		expect(JSON.parse(fresh.optionsJson) as unknown).not.toHaveProperty(
			"resumeSessionAt",
		);
		expect(harness.marks.filter((mark) => mark.kind === "native-fork")).toEqual(
			[],
		);
		const reloaded = await harness.connect(sessionId);
		const history = await reloaded.history(sessionId);
		for (const { id } of before)
			expect(history.map((message) => message.id)).not.toContain(id);
		evidence["fresh"] = fresh;
		evidence["history"] = history;
	}, 60_000);

	// 82tn.51: a node is one Run, so a cut at a Run's reply goes back before the Run; its typed
	// text returns to the composer and the next send resumes at the turn before.
	it("cuts the whole Run when the cut is its assistant reply (82tn.51)", async () => {
		harness = await ProcessHarness.start();
		evidence = { ticket: "conduit-test-qqqm" };
		mkdirSync(join(harness.root, "claude"), { recursive: true });
		writeFileSync(
			join(harness.root, "claude", "conduit-test-record-forks"),
			"record",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Claude assistant rewind");
		for (const prompt of ["rewind-earlier", "rewind-assistant-cut"]) {
			await browser.send(sessionId, prompt);
			await vi.waitFor(() =>
				expect(
					persisted(harness as ProcessHarness, sessionId).activeCommands,
				).toBe(0),
			);
		}
		const before = await browser.history(sessionId);
		const target = before
			.filter((message) => message.role === "assistant")
			.at(-1);
		const cutUser = before.filter((message) => message.role === "user").at(-1);
		const keptReply = before
			.filter((message) => message.role === "assistant")
			.at(-2);
		if (!target || !cutUser || !keptReply)
			throw new Error("Missing assistant cut turn");
		const original = await firstQueryMark(harness);
		const nativeReply = nativeTranscript(harness, original.sessionId).find(
			(entry) =>
				entry.type === "assistant" &&
				(entry.message as { id?: string }).id === keptReply.id,
		);
		if (!nativeReply) throw new Error("Missing kept native reply UUID");
		await Effect.runPromise(
			browser.rpc.RewindSession({
				sessionId,
				messageId: target.id,
			}),
		);
		const rewound = await browser.history(sessionId);
		expect(rewound.map(({ id }) => id)).toContain(keptReply.id);
		expect(rewound.map(({ id }) => id)).not.toContain(cutUser.id);
		expect(rewound.map(({ id }) => id)).not.toContain(target.id);
		await browser.send(sessionId, "rewind-assistant-replacement");
		await vi.waitFor(() =>
			expect(queries(harness as ProcessHarness)).toHaveLength(2),
		);
		const resumed = queries(harness).at(-1);
		if (!resumed) throw new Error("Missing resumed query");
		expect(resumed.sessionId).toBe(original.sessionId);
		expect(JSON.parse(resumed.optionsJson) as unknown).toMatchObject({
			resumeSessionAt: nativeReply.uuid,
		});
		const reloaded = await harness.connect(sessionId);
		const history = await reloaded.history(sessionId);
		expect(history.map(({ id }) => id)).toContain(keptReply.id);
		expect(history.map(({ id }) => id)).not.toContain(cutUser.id);
		expect(history.map(({ id }) => id)).not.toContain(target.id);
		evidence["resumed"] = resumed;
		evidence["history"] = history;
	}, 60_000);

	it("rebuilds kept context after the first committed turn fails", async () => {
		harness = await ProcessHarness.start();
		evidence = { ticket: "conduit-test-qqqm" };
		mkdirSync(join(harness.root, "claude"), { recursive: true });
		writeFileSync(
			join(harness.root, "claude", "conduit-test-record-forks"),
			"record",
		);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Claude failed rewind turn");
		for (const prompt of [
			"rewind-kept-before-failure",
			"rewind-discarded-before-failure",
		]) {
			await browser.send(sessionId, prompt);
			await vi.waitFor(() =>
				expect(
					persisted(harness as ProcessHarness, sessionId).activeCommands,
				).toBe(0),
			);
		}
		const before = await browser.history(sessionId);
		const target = before.find(
			(message) =>
				message.role === "user" &&
				messageText(message) === "rewind-discarded-before-failure",
		);
		if (!target) throw new Error("Missing rewind target");
		const hidden = before.slice(before.indexOf(target));
		const original = await firstQueryMark(harness);
		await Effect.runPromise(
			browser.rpc.RewindSession({
				sessionId,
				messageId: target.id,
			}),
		);
		await browser.send(sessionId, "failure-rewind-commit");
		await vi.waitFor(() =>
			expect(
				persisted(harness as ProcessHarness, sessionId).activeCommands,
			).toBe(0),
		);
		const failed = persisted(harness, sessionId);
		expect(failed.events.map(({ type }) => type)).toContain("turn.error");
		for (const { id } of hidden)
			expect(failed.messages.map((message) => message.id)).not.toContain(id);
		const retried = await browser.send(sessionId, "rewind-retry-after-failure");
		expect(retried.done["status"]).toBe("idle");
		await vi.waitFor(() =>
			expect(queries(harness as ProcessHarness)).toHaveLength(3),
		);
		const retryQuery = queries(harness).at(-1);
		if (!retryQuery) throw new Error("Missing recovery query");
		expect(retryQuery.sessionId).not.toBe(original.sessionId);
		expect(JSON.parse(retryQuery.optionsJson) as unknown).not.toHaveProperty(
			"resumeSessionAt",
		);
		const retryContext = JSON.stringify(
			nativeConversation(nativeTranscript(harness, retryQuery.sessionId)),
		);
		expect(retryContext).toContain("rewind-kept-before-failure");
		expect(retryContext).toContain("rewind-retry-after-failure");
		expect(retryContext).not.toContain("rewind-discarded-before-failure");
		const reloaded = await harness.connect(sessionId);
		const history = await reloaded.history(sessionId);
		for (const { id } of hidden)
			expect(history.map((message) => message.id)).not.toContain(id);
		evidence["failed"] = failed;
		evidence["retryContext"] = retryContext;
		evidence["history"] = history;
	}, 60_000);
});
