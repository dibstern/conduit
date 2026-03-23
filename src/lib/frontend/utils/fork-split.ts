// Fork Split Utility
// Splits a ChatMessage array at the fork point for rendering inherited
// vs new messages in a forked session.

import type { ChatMessage } from "../types.js";

export interface ForkSplit {
	/** Messages inherited from the parent session (before and including the fork point). */
	inherited: ChatMessage[];
	/** New messages created in this fork (after the fork point). */
	current: ChatMessage[];
}

/**
 * Split messages at the fork point identified by forkMessageId.
 * Scans for the last ChatMessage whose messageId matches forkMessageId.
 * Returns all messages up to and including that point as "inherited",
 * and the rest as "current".
 *
 * If forkMessageId is not found in the messages (e.g. messages haven't
 * loaded yet), all messages are returned as "inherited" (conservative).
 */
export function splitAtForkPoint(
	messages: ChatMessage[],
	forkMessageId: string,
): ForkSplit {
	// Find the last index where any message has this messageId.
	let splitIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: index within bounds
		const msg = messages[i]!;
		if ("messageId" in msg && msg.messageId === forkMessageId) {
			splitIndex = i;
			break;
		}
	}

	if (splitIndex === -1) {
		// Fork point not found — treat all as inherited (conservative)
		return { inherited: messages, current: [] };
	}

	// Include all messages in the same "turn" after the matched message.
	// A turn ends when we hit the next user message or the end of the array.
	let endOfTurn = splitIndex;
	for (let i = splitIndex + 1; i < messages.length; i++) {
		if (messages[i]?.type === "user") break;
		endOfTurn = i;
	}

	return {
		inherited: messages.slice(0, endOfTurn + 1),
		current: messages.slice(endOfTurn + 1),
	};
}
