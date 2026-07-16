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
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

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

const THINKING = "Scoping the domain first.";
const TEXT = "I'll follow the diagnose discipline.";

describe("assistant snapshot vs stream dedupe", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({ getSink: () => sink });
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
});
