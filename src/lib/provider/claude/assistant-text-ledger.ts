// ─── Assistant Text Ledger ──────────────────────────────────────────────────
// Who a block of assistant text IS, decided by arrival order alone.
//
// The Claude Agent SDK describes one piece of assistant text twice: as
// `content_block_delta`s on the stream, and once more, whole, in an `assistant`
// snapshot that arrives after that block's last delta and before its
// `content_block_stop`. Reconciling the two used to mean asking "which streamed
// block does this text look like?" — a bidirectional prefix match over the
// blocks seen so far.
//
// A `MessageDisplay` hook defeats that question. The SDK forwards the hook's
// rewritten text in the snapshot (the transcript on disk keeps the original,
// so the CLI honours the display-only contract in one place and not the other),
// and a prepended marker breaks the prefix in both directions: the snapshot
// stops recognising its own block, mints a second part, and every paragraph
// renders — and persists — twice. Where the indexes happened to collide, worse:
// the text was re-sliced at the old length and a fragment was spliced into the
// live part.
//
// So identity here is never derived from content, and never from an index the
// snapshot supplies (per-block snapshots restart their content array at 0, so
// the index carries no information). A snapshot block is the earliest block of
// its kind, in the current (chain, step), that no snapshot has claimed yet.
// That is a fact about order, which no rewrite can change.
//
// Emission is likewise never derived from a length: all text leaves through
// MonotoneText, which only ever yields a suffix of what it has already
// accepted. A snapshot that does not extend the stream contributes no text at
// all — the stream is authoritative, it is what the model actually produced and
// it is already rendered — and says so as a `divergence` the caller can log.
//
// The ledger is pure: it returns emissions and never touches a sink, which is
// what lets the whole reconciliation be tested through the translator's
// Provider Runtime Event interface without a fake anywhere.

import { MonotoneText } from "../monotone-text.js";

export type ContentKind = "text" | "thinking";

/** How a snapshot block failed to extend the text already streamed.
 *
 *  Note there is no "appended" relation: text a hook appends is, by
 *  construction, indistinguishable from text the model went on to produce, so
 *  it extends the stream and is emitted as an ordinary delta. Only these three
 *  shapes are detectable — and all three are dropped. */
export type DivergenceRelation =
	/** The snapshot ends with the streamed text: content was inserted in front
	 *  of it (a `[HH:MM:SS]` marker, a banner, a reformatted heading). */
	| "prepended"
	/** The streamed text starts with the snapshot: the snapshot is missing a
	 *  tail that already went out — a stale or truncated view. */
	| "truncated"
	/** Neither contains the other. */
	| "disjoint";

export type Emission =
	| {
			readonly kind: "delta";
			readonly type: ContentKind;
			readonly partId: string;
			readonly text: string;
	  }
	| { readonly kind: "thinking.start"; readonly partId: string }
	| { readonly kind: "thinking.end"; readonly partId: string }
	| {
			readonly kind: "divergence";
			readonly type: ContentKind;
			readonly partId: string;
			readonly streamed: number;
			readonly snapshot: number;
			readonly relation: DivergenceRelation;
	  };

/** Chain key for the turn's own assistant messages. Subagent frames are keyed
 *  by their `parent_tool_use_id` instead, so a subagent's text can never be
 *  elected as the main chain's next unclaimed block. */
const MAIN_CHAIN = "__main";

interface LedgerBlock {
	readonly type: ContentKind;
	readonly partId: string;
	claimed: boolean;
	thinkingStarted: boolean;
	thinkingEnded: boolean;
}

interface Chain {
	readonly blocks: LedgerBlock[];
	readonly byIndex: Map<number, LedgerBlock>;
}

function emptyChain(): Chain {
	return { blocks: [], byIndex: new Map() };
}

function relationOf(streamed: string, snapshot: string): DivergenceRelation {
	if (snapshot.endsWith(streamed)) return "prepended";
	if (streamed.startsWith(snapshot)) return "truncated";
	return "disjoint";
}

export class AssistantTextLedger {
	private readonly text = new MonotoneText();
	private readonly chains = new Map<string, Chain>();
	/** The conduit message every block of this turn belongs to. */
	private messageId = "";
	/** The SDK API message id of the round currently streaming. */
	private apiMessageId: string | undefined;
	/** Tool round within the conduit message. Each round restarts
	 *  `content_block` indexes at 0, so the step keeps a later round's blocks
	 *  off an earlier round's parts. */
	private step = 0;

	/** Open the scope a block belongs to. A new conduit message id starts a
	 *  fresh scope; a new SDK message id within it opens the next step. Both a
	 *  `message_start` and an `assistant` snapshot may call this — a turn
	 *  without partial messages only ever sees the latter. */
	messageStart(messageId: string, apiMessageId: string): void {
		if (messageId !== this.messageId) {
			this.endTurn();
			this.messageId = messageId;
			this.apiMessageId = apiMessageId;
			return;
		}
		if (apiMessageId === this.apiMessageId) return;
		this.apiMessageId = apiMessageId;
		this.step += 1;
		this.chains.set(MAIN_CHAIN, emptyChain());
	}

	/** Record a streamed block at its wire `content_block` index. Safe to call
	 *  again for an index already open with the same kind, so a delta that
	 *  arrives without a preceding `content_block_start` can open its own
	 *  block. */
	blockStart(index: number, type: ContentKind, partId: string): Emission[] {
		const chain = this.chain(MAIN_CHAIN);
		const open = chain.byIndex.get(index);
		if (open?.type === type) return [];

		const block: LedgerBlock = {
			type,
			partId,
			claimed: false,
			thinkingStarted: false,
			thinkingEnded: false,
		};
		chain.blocks.push(block);
		chain.byIndex.set(index, block);
		return type === "thinking" ? this.startThinking(block) : [];
	}

	blockDelta(index: number, chunk: string): Emission[] {
		const block = this.chain(MAIN_CHAIN).byIndex.get(index);
		if (!block || chunk.length === 0) return [];
		return [
			{
				kind: "delta",
				type: block.type,
				partId: block.partId,
				text: this.text.append(block.partId, chunk),
			},
		];
	}

	blockStop(index: number): Emission[] {
		const block = this.chain(MAIN_CHAIN).byIndex.get(index);
		if (!block) return [];
		return this.endThinking(block);
	}

	/** Reconcile the whole text a snapshot reports for one block. */
	snapshot(block: {
		readonly parentToolUseId: string | null;
		readonly type: ContentKind;
		readonly text: string;
	}): Emission[] {
		const chain = this.chain(block.parentToolUseId ?? MAIN_CHAIN);
		const elected = chain.blocks.find(
			(candidate) => candidate.type === block.type && !candidate.claimed,
		);
		if (!elected) {
			return block.text.length === 0
				? []
				: this.adopt(chain, block.parentToolUseId, block.type, block.text);
		}

		elected.claimed = true;
		const emissions: Emission[] = this.startThinking(elected);
		if (block.text.length > 0) {
			emissions.push(...this.offer(elected, block.text));
		}
		emissions.push(...this.endThinking(elected));
		return emissions;
	}

	/** Drop every block of the turn. */
	endTurn(): void {
		for (const chain of this.chains.values()) {
			for (const block of chain.blocks) this.text.forget(block.partId);
		}
		this.chains.clear();
		this.messageId = "";
		this.apiMessageId = undefined;
		this.step = 0;
	}

	/** Mint a block for snapshot text that never streamed — a subagent frame
	 *  (those arrive only as snapshots) or a turn without partial messages.
	 *  The id is derived from the scope and the block's ordinal within it, so
	 *  replaying the same turn mints the same ids. */
	private adopt(
		chain: Chain,
		parentToolUseId: string | null,
		type: ContentKind,
		text: string,
	): Emission[] {
		const ordinal = chain.blocks.filter((b) => b.type === type).length;
		const scope = parentToolUseId ?? `${this.messageId}:${this.step}`;
		const block: LedgerBlock = {
			type,
			partId: `${scope}:${type}:${ordinal}`,
			claimed: true,
			thinkingStarted: false,
			thinkingEnded: false,
		};
		chain.blocks.push(block);
		return [
			...this.startThinking(block),
			...this.offer(block, text),
			...this.endThinking(block),
		];
	}

	private offer(block: LedgerBlock, text: string): Emission[] {
		const offered = this.text.offer(block.partId, text);
		if (offered.kind === "noop") return [];
		if (offered.kind === "emit") {
			return [
				{
					kind: "delta",
					type: block.type,
					partId: block.partId,
					text: offered.suffix,
				},
			];
		}
		return [
			{
				kind: "divergence",
				type: block.type,
				partId: block.partId,
				streamed: offered.accepted.length,
				snapshot: text.length,
				relation: relationOf(offered.accepted, text),
			},
		];
	}

	private startThinking(block: LedgerBlock): Emission[] {
		if (block.type !== "thinking" || block.thinkingStarted) return [];
		block.thinkingStarted = true;
		return [{ kind: "thinking.start", partId: block.partId }];
	}

	private endThinking(block: LedgerBlock): Emission[] {
		if (block.type !== "thinking" || block.thinkingEnded) return [];
		block.thinkingEnded = true;
		return [{ kind: "thinking.end", partId: block.partId }];
	}

	private chain(key: string): Chain {
		const existing = this.chains.get(key);
		if (existing) return existing;
		const created = emptyChain();
		this.chains.set(key, created);
		return created;
	}
}
