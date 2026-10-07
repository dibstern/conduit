// Diff/synthesize logic for converting REST message snapshots into relay
// events. These functions compare current messages against previous state and
// emit synthetic RelayMessages (delta, tool_start, tool_result,
// thinking_*, result, done, etc.).
//
// Used by the message poller implementation and tested independently.

import type { Message } from "../instance/sdk-types.js";
import type { UntaggedRelayMessage } from "../shared-types.js";
import {
	endsOpenCodeTurn,
	mapToolName,
	openCodeTurnTotals,
} from "./event-translator.js";

export interface PartSnapshot {
	type: string;
	/** For text/reasoning parts: last-seen text length */
	textLength: number;
	/** For text/reasoning parts: full text (needed for diff) */
	text: string;
	/** For tool parts: last-seen status */
	toolStatus?: string;
	/** Tool progress already counted as activity. */
	runningObserved?: boolean;
	/** Reasoning completion already counted as activity. */
	reasoningEnded?: boolean;
	/** For tool parts: whether we emitted tool_result */
	emittedResult: boolean;
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
): boolean {
	const currentText = (part["text"] as string) ?? "";
	const prevLength = snap.textLength;

	// New reasoning part → emit thinking_start
	if (deltaType === "thinking_delta" && prevLength === 0 && currentText) {
		events.push({ type: "thinking_start", messageId });
	}

	// Emit new text as delta
	if (currentText.length > prevLength) {
		const newText = currentText.slice(prevLength);
		if (deltaType === "thinking_delta") {
			events.push({ type: "thinking_delta", text: newText, messageId });
		} else {
			events.push({ type: "delta", text: newText, messageId });
		}
	}

	const time = part["time"] as { end?: number } | undefined;
	const reasoningEnded =
		deltaType === "thinking_delta" &&
		!snap.reasoningEnded &&
		time?.end != null &&
		currentText.length > 0 &&
		(prevLength === 0 || currentText.length === prevLength);
	if (reasoningEnded) snap.reasoningEnded = true;
	snap.textLength = currentText.length;
	snap.text = currentText;
	return reasoningEnded;
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
): boolean {
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
	const runningObserved =
		!snap.runningObserved &&
		(status === "running" || status === "completed" || status === "error");
	if (runningObserved) snap.runningObserved = true;
	const toolName = mapToolName((part["tool"] as string) ?? "");
	const callID = (part["callID"] as string) ?? part.id;

	snap.toolName = toolName;
	snap.callID = callID;
	if (status != null) {
		snap.toolStatus = status;
	}

	const isNew = !prev;

	// New tool part with pending status → tool_start
	if (isNew && (status === "pending" || status === "running")) {
		events.push({
			type: "tool_start",
			id: callID,
			name: toolName,
			messageId,
		});
	}

	// Transition to completed/error → tool_result (only once)
	if ((status === "completed" || status === "error") && !snap.emittedResult) {
		// If we missed previous states, emit tool_start first
		if (!prev) {
			events.push({
				type: "tool_start",
				id: callID,
				name: toolName,
				messageId,
			});
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
	return runningObserved;
}

/**
 * Synthesize events for a single message part by comparing against previous state.
 */
export function synthesizePartEvents(
	part: { id: string; type: string; [key: string]: unknown },
	prev: PartSnapshot | null,
	messageId: string,
): {
	events: UntaggedRelayMessage[];
	snapshot: PartSnapshot;
	hasActivity: boolean;
} {
	const events: UntaggedRelayMessage[] = [];
	let hasActivity = false;
	const partType = part.type;

	// Build current snapshot
	const snap: PartSnapshot = {
		type: partType,
		textLength: prev?.textLength ?? 0,
		text: prev?.text ?? "",
		...(prev?.toolStatus != null && { toolStatus: prev.toolStatus }),
		runningObserved: prev?.runningObserved ?? false,
		reasoningEnded: prev?.reasoningEnded ?? false,
		emittedResult: prev?.emittedResult ?? false,
		...(prev?.toolName != null && { toolName: prev.toolName }),
		...(prev?.callID != null && { callID: prev.callID }),
	};

	if (partType === "text") {
		synthesizeTextPart(part, snap, events, messageId, "delta");
	} else if (partType === "reasoning") {
		hasActivity = synthesizeTextPart(
			part,
			snap,
			events,
			messageId,
			"thinking_delta",
		);
	} else if (partType === "tool") {
		hasActivity = synthesizeToolPart(part, snap, prev, events, messageId);
	}
	// Other part types (step_start, step_finish, snapshot, agent) are skipped
	// — they have no visual representation in the relay UI.

	return { events, snapshot: snap, hasActivity };
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
 * Synthesize the result for a completed assistant step. The step that ends
 * its turn bills for the whole turn; an earlier step only reports usage for
 * the context meter (`midTurn`). See `endsOpenCodeTurn`.
 */
function synthesizeResultEvent(
	msg: Message,
	messages: readonly Message[],
): UntaggedRelayMessage | null {
	if (msg.time?.completed === undefined) return null;

	const turnSteps =
		msg.parentID === undefined
			? [msg]
			: messages.filter(
					(m) => m.role === "assistant" && m.parentID === msg.parentID,
				);

	return {
		type: "result",
		usage: {
			input: msg.tokens?.input ?? 0,
			output: msg.tokens?.output ?? 0,
			cache_read: msg.tokens?.cache?.read ?? 0,
			cache_creation: msg.tokens?.cache?.write ?? 0,
			...(msg.tokens?.contextWindow
				? { context_window: msg.tokens.contextWindow }
				: {}),
		},
		...openCodeTurnTotals(msg, turnSteps),
		sessionId: msg.sessionID,
		...(msg.id != null && { messageId: msg.id }),
		...(!endsOpenCodeTurn(msg) && { midTurn: true as const }),
	};
}

/**
 * Compare current messages against previous snapshot, synthesize events
 * for any changes detected. Returns a new snapshot without mutating the old
 * snapshot. New user messages also resolve their pending send's owner.
 */
export function diffAndSynthesize(
	previousSnapshot: Map<string, MessageSnapshot>,
	messages: Message[],
	resolveOrigin?: (
		sessionId: string | undefined,
		messageId: string | undefined,
		text: string,
	) => string | undefined,
): {
	events: UntaggedRelayMessage[];
	newSnapshot: Map<string, MessageSnapshot>;
	hasActivity: boolean;
} {
	const events: UntaggedRelayMessage[] = [];
	let hasActivity = false;
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
				const originId = resolveOrigin?.(msg.sessionID, msgId, text);
				events.push({
					type: "user_message",
					text,
					messageId: msgId,
					...(originId != null ? { originId } : {}),
				});
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
				hasActivity ||= synthesized.hasActivity;
				events.push(...synthesized.events);
				msgSnap.parts.set(partId, synthesized.snapshot);
			}
		}

		// Emit a result once each assistant step completes
		if (msg.role === "assistant" && !msgSnap.emittedResult) {
			const resultEvent = synthesizeResultEvent(msg, messages);
			if (resultEvent) {
				events.push(resultEvent);
				msgSnap.emittedResult = true;
			}
		}

		newSnapshot.set(msgId, msgSnap);
	}

	return { events, newSnapshot, hasActivity };
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
			// A completed step has already had its result
			emittedResult: msg.time?.completed !== undefined,
		};

		for (const part of msg.parts ?? []) {
			const partType = part.type;
			const snap: PartSnapshot = {
				type: partType,
				textLength: 0,
				text: "",
				runningObserved: false,
				reasoningEnded: false,
				emittedResult: false,
			};

			if (partType === "text" || partType === "reasoning") {
				const text = (part["text"] as string) ?? "";
				snap.textLength = text.length;
				snap.text = text;
				if (partType === "reasoning") {
					const time = part["time"] as { end?: number } | undefined;
					snap.reasoningEnded = time?.end != null;
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
					snap.runningObserved = true;
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
