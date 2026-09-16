// ─── Snapshot↔stream reconciliation, checked mechanically ───────────────────
// The example tests next door pin the shapes we have actually seen on the
// wire. This one asks the question the examples can't: for ANY turn — any
// number of blocks, any kind, any chunking of the deltas, any rewrite a
// MessageDisplay hook might apply, and the snapshot landing on either side of
// content_block_stop — does every block still arrive exactly once, byte for
// byte, in wire order, with nothing invented?
//
// The property is the whole design in one line: the stream is authoritative.
// A snapshot may only extend it. Text a hook appended is indistinguishable
// from text the model went on to produce, so it lands; every other rewrite is
// a non-extension and contributes nothing.

import { Effect } from "effect";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { assertProviderRuntimeStreamInvariants } from "../../../helpers/provider-runtime-stream-invariants.js";

/** A hook marker built from characters the generated text cannot contain, so
 *  no rewrite can accidentally look like a legitimate extension. */
const MARK = "«12:00:00»";

const REWRITES = [
	"identity",
	"prepend",
	"append",
	"wrap",
	"replace",
	"truncate",
] as const;
type Rewrite = (typeof REWRITES)[number];

type Block = {
	readonly kind: "text" | "thinking";
	readonly text: string;
	readonly chunks: number;
	readonly rewrite: Rewrite;
	readonly snapshotAfterStop: boolean;
};

function rewritten(block: Block): string {
	switch (block.rewrite) {
		case "identity":
			return block.text;
		case "prepend":
			return MARK + block.text;
		case "append":
			return block.text + MARK;
		case "wrap":
			return MARK + block.text + MARK;
		case "replace":
			return `${MARK}entirely different`;
		case "truncate":
			return block.text.slice(0, Math.floor(block.text.length / 2));
	}
}

/** What the part must end up holding. An appended rewrite extends the stream
 *  and is therefore emitted; every other rewrite is dropped. */
function expected(block: Block): { kind: Block["kind"]; text: string } {
	return {
		kind: block.kind,
		text: block.rewrite === "append" ? block.text + MARK : block.text,
	};
}

function chunksOf(text: string, count: number): string[] {
	const size = Math.ceil(text.length / count);
	const chunks: string[] = [];
	for (let at = 0; at < text.length; at += size) {
		chunks.push(text.slice(at, at + size));
	}
	return chunks;
}

const MESSAGE_ID = "msg_property";

/** The SDK frames a turn of these blocks would produce. */
function framesOf(blocks: readonly Block[]): SDKMessage[] {
	const stream = (event: Record<string, unknown>): SDKMessage =>
		({
			type: "stream_event",
			event,
			session_id: "sdk-sess",
			parent_tool_use_id: null,
			uuid: "se-uuid",
		}) as unknown as SDKMessage;

	const frames: SDKMessage[] = [
		stream({ type: "message_start", message: { id: MESSAGE_ID } }),
	];
	blocks.forEach((block, index) => {
		const field = block.kind === "text" ? "text" : "thinking";
		const snapshot = {
			type: "assistant",
			message: {
				id: MESSAGE_ID,
				content: [{ type: block.kind, [field]: rewritten(block) }],
			},
			parent_tool_use_id: null,
			uuid: `uuid-${index}`,
			session_id: "sdk-sess",
		} as unknown as SDKMessage;

		frames.push(
			stream({
				type: "content_block_start",
				index,
				content_block: { type: block.kind, [field]: "" },
			}),
		);
		for (const chunk of chunksOf(block.text, block.chunks)) {
			frames.push(
				stream({
					type: "content_block_delta",
					index,
					delta: {
						type: block.kind === "text" ? "text_delta" : "thinking_delta",
						[field]: chunk,
					},
				}),
			);
		}
		if (block.snapshotAfterStop) {
			frames.push(stream({ type: "content_block_stop", index }), snapshot);
		} else {
			frames.push(snapshot, stream({ type: "content_block_stop", index }));
		}
	});
	return frames;
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
		sessionId: "property-session",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-07-16T00:00:00.000Z",
		promptQueue: {} as unknown as ClaudeSessionContext["promptQueue"],
		query: {} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-fable-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

/** The assistant text that actually left, one entry per part in the order the
 *  parts first produced text. */
function emittedParts(
	events: readonly ProviderRuntimeEvent[],
): { kind: Block["kind"]; text: string }[] {
	const byPart = new Map<string, { kind: Block["kind"]; text: string }>();
	for (const event of events) {
		if (event.type !== "text.delta" && event.type !== "thinking.delta") {
			continue;
		}
		const data = event.data as { partId: string; text: string };
		const existing = byPart.get(data.partId);
		if (existing) {
			existing.text += data.text;
			continue;
		}
		byPart.set(data.partId, {
			kind: event.type === "text.delta" ? "text" : "thinking",
			text: data.text,
		});
	}
	return [...byPart.values()];
}

const blockArb: fc.Arbitrary<Block> = fc.record({
	kind: fc.constantFrom("text" as const, "thinking" as const),
	text: fc.string({
		minLength: 1,
		maxLength: 40,
		unit: fc.constantFrom("a", "b", "c", "z", " ", ".", "\n"),
	}),
	chunks: fc.integer({ min: 1, max: 4 }),
	rewrite: fc.constantFrom(...REWRITES),
	snapshotAfterStop: fc.boolean(),
});

describe("assistant text reconciliation (property)", () => {
	it("delivers every block exactly once, byte-equal, in wire order", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(blockArb, { minLength: 1, maxLength: 5 }),
				async (blocks) => {
					const sink = makeStubSink();
					const ctx = makeCtx();
					const translator = new ClaudeEventTranslator({ getSink: () => sink });
					const frames = framesOf(blocks);

					for (const frame of frames) {
						await Effect.runPromise(translator.translate(ctx, frame));
					}

					try {
						assertProviderRuntimeStreamInvariants(sink.events);
						expect(emittedParts(sink.events)).toEqual(blocks.map(expected));
					} catch (cause) {
						throw new Error(
							`${cause instanceof Error ? cause.message : String(cause)}\n\nframes:\n${frames
								.map((frame) => JSON.stringify(frame))
								.join("\n")}`,
						);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
