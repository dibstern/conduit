// ─── Message Poller Synthesis (Pure Functions) ───────────────────────────────
// Pure diff/synthesize logic for converting REST message snapshots into relay
// events. These functions compare current messages against previous state and
// emit synthetic RelayMessages (delta, tool_start, tool_executing, tool_result,
// thinking_*, result, done, etc.).
//
// Used by the message poller implementation and tested independently.

import type { Message } from "../instance/sdk-types.js";
import type { UntaggedRelayMessage } from "../shared-types.js";
import { mapToolName } from "./event-translator.js";

// ─── Part Snapshot ───────────────────────────────────────────────────────────

export interface PartSnapshot {
	type: string;
	/** For text/reasoning parts: last-seen text length */
	textLength: number;
	/** For text/reasoning parts: full text (needed for diff) */
	text: string;
	/** For tool parts: last-seen status */
	toolStatus?: string;
	/** For tool parts: whether we emitted tool_executing */
	emittedExecuting: boolean;
	/** For tool parts: whether we emitted tool_result */
	emittedResult: boolean;
	/** For reasoning parts: whether we emitted thinking_stop */
	emittedStop: boolean;
	/** Tool name (mapped) */
	toolName?: string;
	/** Tool callID or part id */
	callID?: string;
}

export interface MessageSnapshot {
	id: string;
	role: string;
	parts: Map<string, PartSnapshot>;
	/** Whether we already emitted a result event for this message */
	emittedResult: boolean;
}

// ─── Extracted Pure Functions ────────────────────────────────────────────────

/**
 * Synthesize delta events for text and reasoning parts.
 * Text parts only grow (append-only), so we emit the new suffix.
 */
export function synthesizeTextPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	events: UntaggedRelayMessage[],
	messageId: string,
	deltaType: "delta" | "thinking_delta",
): void {
	const currentText = (part["text"] as string) ?? "";
	const prevLength = snap.textLength;

	// New reasoning part → emit thinking_start
	if (deltaType === "thinking_delta" && prevLength === 0 && currentText) {
		events.push({ type: "thinking_start", messageId });
	}

	// Emit new text as delta
	if (currentText.length > prevLength) {
		const newText = currentText.slice(prevLength);
		events.push({ type: deltaType, text: newText, messageId });
	}

	// Check if reasoning is done (has end time)
	if (deltaType === "thinking_delta" && !snap.emittedStop) {
		const time = part["time"] as { start?: number; end?: number } | undefined;
		if (
			time?.end !== undefined &&
			time.end !== null &&
			currentText.length > 0
		) {
			// Emit thinking_stop when the reasoning part is complete:
			// - First pass (prevLength === 0): part already finished, emit immediately.
			//   Without this, thinking_stop is deferred to the next poll cycle because
			//   the old condition (snap.textLength > 0) is always false on first pass.
			// - Subsequent passes: only emit when text has settled (no new content),
			//   to avoid premature stop while the part is still streaming.
			if (prevLength === 0 || currentText.length === prevLength) {
				events.push({ type: "thinking_stop", messageId });
				snap.emittedStop = true;
			}
		}
	}

	snap.textLength = currentText.length;
	snap.text = currentText;
}

/**
 * Synthesize events for tool parts based on status transitions.
 */
export function synthesizeToolPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	prev: PartSnapshot | null,
	events: UntaggedRelayMessage[],
	messageId: string,
): void {
	const state = part["state"] as
		| {
				status?: string;
				input?: unknown;
				output?: string;
				error?: string;
				metadata?: Record<string, unknown>;
		  }
		| undefined;
	const status = state?.status;
	const metadata = state?.metadata;
	const toolName = mapToolName((part["tool"] as string) ?? "");
	const callID = (part["callID"] as string) ?? part.id;

	snap.toolName = toolName;
	snap.callID = callID;
	if (status != null) {
		snap.toolStatus = status;
	}

	const isNew = !prev;
	const prevStatus = prev?.toolStatus;

	// New tool part with pending status → tool_start
	if (isNew && (status === "pending" || status === "running")) {
		events.push({
			type: "tool_start",
			id: callID,
			name: toolName,
			messageId,
		});
	}

	// Transition to running → tool_executing (only once)
	if (status === "running" && !snap.emittedExecuting) {
		// If we missed the pending state, emit tool_start first
		if (isNew || (!prev?.emittedExecuting && prevStatus !== "pending")) {
			if (!isNew || status !== "running") {
				// Already emitted tool_start above for new parts
			}
		}
		events.push({
			type: "tool_executing",
			id: callID,
			name: toolName,
			input: state?.input as Record<string, unknown> | undefined,
			...(metadata != null && { metadata }),
			messageId,
		});
		snap.emittedExecuting = true;
	}

	// Transition to completed/error → tool_result (only once)
	if ((status === "completed" || status === "error") && !snap.emittedResult) {
		// If we missed previous states, emit tool_start + tool_executing first
		if (!prev) {
			events.push({
				type: "tool_start",
				id: callID,
				name: toolName,
				messageId,
			});
		}
		if (!snap.emittedExecuting) {
			events.push({
				type: "tool_executing",
				id: callID,
				name: toolName,
				input: state?.input as Record<string, unknown> | undefined,
				...(metadata != null && { metadata }),
				messageId,
			});
			snap.emittedExecuting = true;
		}

		const isError = status === "error";
		events.push({
			type: "tool_result",
			id: callID,
			content: isError
				? (state?.error ?? "Unknown error")
				: (state?.output ?? ""),
			is_error: isError,
			messageId,
		});
		snap.emittedResult = true;
	}
}

/**
 * Synthesize events for a single message part by comparing against previous state.
 */
export function synthesizePartEvents(
	part: { id: string; type: string; [key: string]: unknown },
	prev: PartSnapshot | null,
	messageId: string,
): { events: UntaggedRelayMessage[]; snapshot: PartSnapshot } {
	const events: UntaggedRelayMessage[] = [];
	const partType = part.type;

	// Build current snapshot
	const snap: PartSnapshot = {
		type: partType,
		textLength: prev?.textLength ?? 0,
		text: prev?.text ?? "",
		...(prev?.toolStatus != null && { toolStatus: prev.toolStatus }),
		emittedExecuting: prev?.emittedExecuting ?? false,
		emittedResult: prev?.emittedResult ?? false,
		emittedStop: prev?.emittedStop ?? false,
		...(prev?.toolName != null && { toolName: prev.toolName }),
		...(prev?.callID != null && { callID: prev.callID }),
	};

	if (partType === "text") {
		synthesizeTextPart(part, snap, events, messageId, "delta");
	} else if (partType === "reasoning") {
		synthesizeTextPart(part, snap, events, messageId, "thinking_delta");
	} else if (partType === "tool") {
		synthesizeToolPart(part, snap, prev, events, messageId);
	}
	// Other part types (step_start, step_finish, snapshot, agent) are skipped
	// — they have no visual representation in the relay UI.

	return { events, snapshot: snap };
}

/** Extract text from a user message's parts. */
function extractUserText(msg: Message): string {
	if (!msg.parts) return "";
	return msg.parts
		.filter((p) => p.type === "text")
		.map((p) => (p["text"] as string) ?? "")
		.join("\n");
}

/**
 * Synthesize a result event from an assistant message's cost/token metadata.
 * Only emits when the message has been completed (has cost or token data).
 */
function synthesizeResultEvent(msg: Message): UntaggedRelayMessage | null {
	const hasCost = msg.cost !== undefined && msg.cost > 0;
	const hasTokens =
		msg.tokens?.input !== undefined || msg.tokens?.output !== undefined;

	if (!hasCost && !hasTokens) return null;

	const duration =
		msg.time?.created !== undefined && msg.time?.completed !== undefined
			? msg.time.completed - msg.time.created
			: 0;

	return {
		type: "result",
		usage: {
			input: msg.tokens?.input ?? 0,
			output: msg.tokens?.output ?? 0,
			cache_read: msg.tokens?.cache?.read ?? 0,
			cache_creation: msg.tokens?.cache?.write ?? 0,
		},
		cost: msg.cost ?? 0,
		duration,
		sessionId: msg.sessionID,
		...(msg.id != null && { messageId: msg.id }),
	};
}

/**
 * Compare current messages against previous snapshot, synthesize events
 * for any changes detected. Pure function — returns new snapshot instead
 * of mutating state.
 */
export function diffAndSynthesize(
	previousSnapshot: Map<string, MessageSnapshot>,
	messages: Message[],
): {
	events: UntaggedRelayMessage[];
	newSnapshot: Map<string, MessageSnapshot>;
} {
	const events: UntaggedRelayMessage[] = [];
	const newSnapshot = new Map<string, MessageSnapshot>();

	for (const msg of messages) {
		const msgId = msg.id;
		const prevMsg = previousSnapshot.get(msgId);

		const msgSnap: MessageSnapshot = {
			id: msgId,
			role: msg.role,
			parts: new Map(),
			emittedResult: prevMsg?.emittedResult ?? false,
		};

		// Handle user messages we haven't seen before
		if (!prevMsg && msg.role === "user") {
			const text = extractUserText(msg);
			if (text) {
				events.push({ type: "user_message", text });
			}
		}

		// Process each part (skip user messages — their text is already
		// handled above as a user_message event, and synthesizePartEvents
		// would incorrectly emit delta events for user text parts, which
		// the client appends to the current assistant message).
		if (msg.role !== "user") {
			for (const part of msg.parts ?? []) {
				const partId = part.id;
				const prevPart = prevMsg?.parts.get(partId);

				const synthesized = synthesizePartEvents(part, prevPart ?? null, msgId);
				events.push(...synthesized.events);
				msgSnap.parts.set(partId, synthesized.snapshot);
			}
		}

		// Emit result event for assistant messages with cost/token info
		if (msg.role === "assistant" && !msgSnap.emittedResult) {
			const resultEvent = synthesizeResultEvent(msg);
			if (resultEvent) {
				events.push(resultEvent);
				msgSnap.emittedResult = true;
			}
		}

		newSnapshot.set(msgId, msgSnap);
	}

	return { events, newSnapshot };
}

/**
 * Build the initial snapshot baseline from existing messages.
 * Returns the snapshot map instead of assigning to instance state.
 *
 * Walks each message's parts and records them as if they were already
 * seen in a previous poll cycle — marking text lengths, tool statuses,
 * and result emission flags so diffAndSynthesize() skips them.
 */
export function buildSeedSnapshot(
	messages: Message[],
): Map<string, MessageSnapshot> {
	const snapshot = new Map<string, MessageSnapshot>();

	for (const msg of messages) {
		const msgSnap: MessageSnapshot = {
			id: msg.id,
			role: msg.role,
			parts: new Map(),
			// Mark result as already emitted if the message has cost/token data
			emittedResult:
				(msg.cost !== undefined && msg.cost > 0) ||
				msg.tokens?.input !== undefined ||
				msg.tokens?.output !== undefined,
		};

		for (const part of msg.parts ?? []) {
			const partType = part.type;
			const snap: PartSnapshot = {
				type: partType,
				textLength: 0,
				text: "",
				emittedExecuting: false,
				emittedResult: false,
				emittedStop: false,
			};

			if (partType === "text" || partType === "reasoning") {
				const text = (part["text"] as string) ?? "";
				snap.textLength = text.length;
				snap.text = text;
				// For reasoning parts, mark thinking_stop as already emitted if
				// the part has an end time (it's already completed)
				if (partType === "reasoning") {
					const time = part["time"] as
						| { start?: number; end?: number }
						| undefined;
					if (time?.end !== undefined && time.end !== null) {
						snap.emittedStop = true;
					}
				}
			} else if (partType === "tool") {
				const state = part["state"] as
					| {
							status?: string;
							input?: unknown;
							output?: string;
							error?: string;
					  }
					| undefined;
				const status = state?.status;
				snap.toolName = mapToolName((part["tool"] as string) ?? "");
				snap.callID = (part["callID"] as string) ?? part.id;
				if (status != null) {
					snap.toolStatus = status;
				}
				// Mark lifecycle events as already emitted based on current status
				if (
					status === "running" ||
					status === "completed" ||
					status === "error"
				) {
					snap.emittedExecuting = true;
				}
				if (status === "completed" || status === "error") {
					snap.emittedResult = true;
				}
			}

			msgSnap.parts.set(part.id, snap);
		}

		snapshot.set(msg.id, msgSnap);
	}

	return snapshot;
}
