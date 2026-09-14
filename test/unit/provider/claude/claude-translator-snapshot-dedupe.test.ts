// ─── Snapshot/stream dedupe regressions ─────────────────────────────────────
// Replays the captured incident from .conduit/events.db (session ses_dd151774,
// 2026-07-15): with includePartialMessages the SDK emits per-block assistant
// snapshot messages whose content-array index does NOT match the wire
// content_block index (the stream had thinking at 0 / text at 1; the text-only
// snapshot indexed its text block at 0). Keying dedupe state by (messageId,
// index) therefore missed the streamed text state and re-emitted the full text
// as a second part — the user saw every assistant paragraph twice.
//
// Also covered here:
// - content_block_stop for a plain text block used to emit tool.completed with
//   messageId = the part's own uuid, which the ingress pipeline expanded into a
//   phantom "Unknown" tool and a phantom empty assistant message row.
// - Queued sends: the SDK holds one long streaming turn open across queued user
//   prompts (no `result` in between), so the translator funnelled the reply to
//   a queued message into the PREVIOUS turn's assistant message. Enqueueing a
//   prompt now marks a boundary on the session context; the next message_start
//   starts a fresh assistant message.

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { Logger } from "../../../../src/lib/logger.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { assertProviderRuntimeStreamInvariants } from "../../../helpers/provider-runtime-stream-invariants.js";

function dataOf(event: ProviderRuntimeEvent): Record<string, unknown> {
	return event.data as unknown as Record<string, unknown>;
}

function makeStubSink(): EventSink & { events: ProviderRuntimeEvent[] } {
	const events: ProviderRuntimeEvent[] = [];
	return {
		events,
		push: vi.fn((event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-07-15T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		session_id: "sdk-sess",
		parent_tool_use_id: null,
		uuid: "se-uuid",
	} as unknown as SDKMessage;
}

function assistantSnapshot(
	messageId: string,
	content: ReadonlyArray<Record<string, unknown>>,
): SDKMessage {
	return {
		type: "assistant",
		message: { id: messageId, content },
		parent_tool_use_id: null,
		uuid: `uuid-${messageId}`,
		session_id: "sdk-sess",
	} as unknown as SDKMessage;
}

function subagentSnapshot(
	messageId: string,
	parentToolUseId: string,
	content: ReadonlyArray<Record<string, unknown>>,
): SDKMessage {
	return {
		type: "assistant",
		message: { id: messageId, content },
		parent_tool_use_id: parentToolUseId,
		uuid: `uuid-${messageId}`,
		session_id: "sdk-sess",
	} as unknown as SDKMessage;
}

const THINKING = "Scoping the domain first.";
const TEXT = "I'll follow the diagnose discipline.";

describe("assistant snapshot vs stream dedupe", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;
	let warnings: string[];

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		warnings = [];
		const logger: Logger = {
			debug: () => {},
			verbose: () => {},
			info: () => {},
			warn: (...args: unknown[]) => {
				warnings.push(args.map((arg) => JSON.stringify(arg)).join(" "));
			},
			error: () => {},
			child: () => logger,
		};
		translator = new ClaudeEventTranslator({ getSink: () => sink, logger });
	});

	afterEach(() => {
		assertProviderRuntimeStreamInvariants(sink.events);
	});

	async function feed(...messages: SDKMessage[]): Promise<void> {
		for (const message of messages) {
			await Effect.runPromise(translator.translate(ctx, message));
		}
	}

	/** Concatenated text.delta payloads grouped by partId, for one message. */
	function textPartsOf(messageId: string): Map<string, string> {
		const parts = new Map<string, string>();
		for (const event of sink.events) {
			if (event.type !== "text.delta") continue;
			const data = dataOf(event);
			if (data["messageId"] !== messageId) continue;
			const partId = data["partId"] as string;
			parts.set(partId, (parts.get(partId) ?? "") + (data["text"] as string));
		}
		return parts;
	}

	/** The captured incident: per-block snapshots with mismatched indexes. */
	async function replayIncidentTurn(messageId: string): Promise<void> {
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			// thinking block at wire index 0
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING },
			}),
			// per-block snapshot #1: thinking only (array index 0 — matches)
			assistantSnapshot(messageId, [{ type: "thinking", thinking: THINKING }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
			// text block at wire index 1
			streamEvent({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: TEXT.slice(0, 12) },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: TEXT.slice(12) },
			}),
			streamEvent({ type: "content_block_stop", index: 1 }),
			// per-block snapshot #2: text only — at array index 0, NOT wire index 1
			assistantSnapshot(messageId, [{ type: "text", text: TEXT }]),
		);
	}

	it("emits streamed text exactly once when the snapshot indexes blocks differently", async () => {
		await replayIncidentTurn("msg_A");

		const parts = textPartsOf("msg_A");
		expect([...parts.values()]).toEqual([TEXT]);
	});

	it("does not emit phantom tool events for completed text blocks", async () => {
		await replayIncidentTurn("msg_A");

		const phantom = sink.events.filter((event) => {
			if (event.type !== "tool.started" && event.type !== "tool.completed") {
				return false;
			}
			const partId = dataOf(event)["partId"];
			return typeof partId === "string" && partId.startsWith("part-stop-");
		});
		expect(phantom).toEqual([]);

		// Every event must be attributed to the real assistant message — the
		// phantom empty message row came from tool.completed carrying the
		// text part's own uuid as messageId.
		for (const event of sink.events) {
			const messageId = dataOf(event)["messageId"];
			if (typeof messageId === "string" && messageId.length > 0) {
				expect(messageId).toBe("msg_A");
			}
		}
	});

	it("starts a new assistant message after a queued prompt boundary", async () => {
		await replayIncidentTurn("msg_A");

		// No `result` arrives between turns (the SDK holds the streaming turn
		// open for queued input). Enqueueing the next prompt marks the boundary.
		ctx.pendingAssistantBoundary = true;

		await feed(
			streamEvent({ type: "message_start", message: { id: "msg_B" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Re-running the gathering." },
			}),
		);

		const partsB = textPartsOf("msg_B");
		expect([...partsB.values()]).toEqual(["Re-running the gathering."]);
		// Turn 1's message must not have absorbed turn 2's text.
		const partsA = textPartsOf("msg_A");
		expect([...partsA.values()]).toEqual([TEXT]);
	});

	// ── conduit-test-r5xu ───────────────────────────────────────────────
	// A MessageDisplay hook (the message-timestamps plugin) rewrites assistant
	// text before it reaches the SDK consumer, PREPENDING a "[HH:MM:SS]"
	// marker. Reconciliation matches on a bidirectional prefix, which a
	// prepended marker defeats in both directions, so the snapshot stopped
	// recognising its own streamed block.
	//
	// Two distinct corruptions followed, one per index alignment. Both are
	// covered here because they fail in visibly different ways.

	// Snapshot index == wire index: the mint fell through to the EXISTING
	// streamed state and emitTextSuffixForState sliced at its textLength,
	// splicing a fragment into the live part ("…discipline.discipline.").
	it("emits streamed text once when a display hook prepends a marker to the snapshot", async () => {
		const messageId = "msg_HOOK";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: TEXT },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			assistantSnapshot(messageId, [
				{ type: "text", text: `[12:11:38] ${TEXT}` },
			]),
		);

		const parts = textPartsOf(messageId);
		expect([...parts.values()]).toEqual([TEXT]);
	});

	// Snapshot index != wire index (the production shape, captured in
	// .conduit/events.db): a separate `<messageId>-0` part was minted and the
	// whole paragraph was emitted — and persisted — twice.
	it("emits streamed text once when a marked snapshot also indexes blocks differently", async () => {
		const messageId = "msg_HOOK2";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: TEXT },
			}),
			streamEvent({ type: "content_block_stop", index: 1 }),
			assistantSnapshot(messageId, [
				{ type: "text", text: `[12:11:38] ${TEXT}` },
			]),
		);

		const parts = textPartsOf(messageId);
		expect([...parts.values()]).toEqual([TEXT]);
	});

	// The healing path must survive the fix: when a block never streamed at
	// all (partial messages off, or a dropped content_block_start), the
	// snapshot is the only source and must still mint its own part.
	it("still mints a part for a snapshot block that never streamed", async () => {
		const messageId = "msg_NOSTREAM";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			assistantSnapshot(messageId, [{ type: "text", text: TEXT }]),
		);

		const parts = textPartsOf(messageId);
		expect([...parts.values()]).toEqual([TEXT]);
	});

	/** Stream one complete text block, then hand the snapshot whatever a hook
	 *  turned it into. */
	async function streamThenSnapshot(
		messageId: string,
		streamed: string,
		snapshot: string,
	): Promise<void> {
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: streamed },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			assistantSnapshot(messageId, [{ type: "text", text: snapshot }]),
		);
	}

	it("drops a snapshot that shares no text with the stream, and says so", async () => {
		const messageId = "msg_DISJOINT";
		await streamThenSnapshot(messageId, TEXT, "Something else entirely.");

		expect([...textPartsOf(messageId).values()]).toEqual([TEXT]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("(disjoint)");
		expect(warnings[0]).toContain(`"streamedCharacters":${TEXT.length}`);
		expect(warnings[0]).toContain('"snapshotCharacters":24');
	});

	it("drops a snapshot missing a tail the stream already sent, and says so", async () => {
		const messageId = "msg_TRUNCATED";
		await streamThenSnapshot(messageId, TEXT, TEXT.slice(0, 12));

		expect([...textPartsOf(messageId).values()]).toEqual([TEXT]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("(truncated)");
	});

	// A truncated stream — the SDK dropped deltas, or partial messages were
	// switched on mid-block — is the one case where the snapshot knows more
	// than the stream. It heals by exactly the missing tail, and only once.
	it("heals a truncated stream with the missing tail, exactly once", async () => {
		const messageId = "msg_HEAL";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: TEXT.slice(0, 12) },
			}),
			assistantSnapshot(messageId, [{ type: "text", text: TEXT }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
		);

		const deltas = sink.events
			.filter((event) => event.type === "text.delta")
			.map((event) => dataOf(event)["text"]);
		expect(deltas).toEqual([TEXT.slice(0, 12), TEXT.slice(12)]);
		expect(warnings).toEqual([]);
	});

	// Per ADR-0002 the snapshot normally precedes content_block_stop, but a
	// late one must still find its own block rather than the next one.
	it("elects the same block when the snapshot arrives after the block stopped", async () => {
		const messageId = "msg_LATE";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "First. " },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "Second." },
			}),
			// Late snapshot for the FIRST block, while the second is open.
			assistantSnapshot(messageId, [{ type: "text", text: "First. more" }]),
			streamEvent({ type: "content_block_stop", index: 1 }),
		);

		expect([...textPartsOf(messageId).values()]).toEqual([
			"First. more",
			"Second.",
		]);
	});

	it("keeps each tool round on its own part, in order", async () => {
		const messageId = "msg_ROUND1";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Before the tool." },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			assistantSnapshot(messageId, [
				{ type: "text", text: "Before the tool." },
			]),
			// Second API round: content_block indexes restart at 0.
			streamEvent({ type: "message_start", message: { id: "msg_ROUND2" } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "After the tool." },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			assistantSnapshot("msg_ROUND2", [
				{ type: "text", text: "After the tool." },
			]),
		);

		expect([...textPartsOf(messageId).values()]).toEqual([
			"Before the tool.",
			"After the tool.",
		]);
	});

	it("treats a rewritten thinking snapshot the same way", async () => {
		const messageId = "msg_THINK";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING },
			}),
			assistantSnapshot(messageId, [
				{ type: "thinking", thinking: `[12:11:38] ${THINKING}` },
			]),
			streamEvent({ type: "content_block_stop", index: 0 }),
		);

		const thinking = sink.events
			.filter((event) => event.type === "thinking.delta")
			.map((event) => dataOf(event)["text"]);
		expect(thinking).toEqual([THINKING]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("(prepended)");
		expect(
			sink.events.filter((event) => event.type === "thinking.end"),
		).toHaveLength(1);
	});

	/** Every (partId, text) pair the turn produced, in emission order. */
	function allParts(): [string, string][] {
		const parts = new Map<string, string>();
		for (const event of sink.events) {
			if (event.type !== "text.delta" && event.type !== "thinking.delta") {
				continue;
			}
			const data = dataOf(event);
			const partId = data["partId"] as string;
			parts.set(partId, (parts.get(partId) ?? "") + (data["text"] as string));
		}
		return [...parts.entries()];
	}

	// Without partial messages there is no stream to reconcile against, so
	// every block is adopted. Both blocks used to mint `<messageId>-0` — the
	// second then re-sliced the first at its own length and spliced.
	it("adopts each block of a stream-less message as its own part", async () => {
		const messageId = "msg_ADOPT";
		await feed(
			assistantSnapshot(messageId, [
				{ type: "text", text: "First paragraph." },
				{ type: "text", text: "Second paragraph." },
			]),
		);

		expect(allParts()).toEqual([
			[`${messageId}:0:text:0`, "First paragraph."],
			[`${messageId}:0:text:1`, "Second paragraph."],
		]);
	});

	it("mints the same part ids when the same turn is replayed", async () => {
		const messageId = "msg_ADOPT";
		const snapshot = assistantSnapshot(messageId, [
			{ type: "text", text: "First paragraph." },
			{ type: "text", text: "Second paragraph." },
		]);
		await feed(snapshot);
		const first = allParts();

		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({ getSink: () => sink });
		await feed(snapshot);

		expect(allParts()).toEqual(first);
	});

	it("brackets an adopted thinking block with start and end", async () => {
		const messageId = "msg_ADOPT_THINK";
		await feed(
			assistantSnapshot(messageId, [{ type: "thinking", thinking: THINKING }]),
		);

		expect(
			sink.events
				.filter((event) => event.type.startsWith("thinking."))
				.map((event) => [event.type, dataOf(event)["partId"]]),
		).toEqual([
			["thinking.start", `${messageId}:0:thinking:0`],
			["thinking.delta", `${messageId}:0:thinking:0`],
			["thinking.end", `${messageId}:0:thinking:0`],
		]);
	});

	// Each subagent is its own chain. Sharing the main chain's blocks is how a
	// subagent frame could be elected as the main chain's next unclaimed
	// block — swallowing the subagent's text and stealing the main part.
	it("keeps each subagent chain isolated from the other and from the main chain", async () => {
		const messageId = "msg_MAIN";
		await feed(
			streamEvent({ type: "message_start", message: { id: messageId } }),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: TEXT },
			}),
			subagentSnapshot("msg_S1", "toolu_one", [
				{ type: "text", text: "Subagent one reporting." },
			]),
			subagentSnapshot("msg_S2", "toolu_two", [
				{ type: "text", text: "Subagent two reporting." },
			]),
			assistantSnapshot(messageId, [{ type: "text", text: TEXT }]),
			streamEvent({ type: "content_block_stop", index: 0 }),
		);

		expect(allParts().map(([, text]) => text)).toEqual([
			TEXT,
			"Subagent one reporting.",
			"Subagent two reporting.",
		]);
		expect(
			allParts()
				.map(([partId]) => partId)
				.slice(1),
		).toEqual(["toolu_one:text:0", "toolu_two:text:0"]);
		expect(warnings).toEqual([]);
	});
});
