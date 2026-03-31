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
 * Split messages at the fork boundary using the fork-point timestamp.
 *
 * Messages with `createdAt < forkPointTimestamp` are inherited from the parent.
 * Messages with `createdAt >= forkPointTimestamp` (or no `createdAt`, e.g. live
 * messages from SSE) are current (new in the fork).
 *
 * Falls back to forkMessageId matching for sessions without forkPointTimestamp.
 */
export function splitAtForkPoint(
	messages: ChatMessage[],
	forkMessageId?: string,
	forkPointTimestamp?: number,
): ForkSplit {
	// Primary: timestamp-based split (reliable — each message self-identifies).
	if (forkPointTimestamp != null) {
		// Find the last message that is inherited (createdAt < forkPointTimestamp).
		// Messages without createdAt (live SSE messages) are always current.
		let splitIndex = 0;
		for (let i = 0; i < messages.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: index within bounds
			const msg = messages[i]!;
			if (
				"createdAt" in msg &&
				typeof msg.createdAt === "number" &&
				msg.createdAt < forkPointTimestamp
			) {
				splitIndex = i + 1; // include this message in inherited
			}
		}
		return {
			inherited: messages.slice(0, splitIndex),
			current: messages.slice(splitIndex),
		};
	}

	// Fallback: ID-based matching for sessions created before timestamp tracking.
	if (!forkMessageId) {
		return { inherited: messages, current: [] };
	}

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
		if (messages.length > 0) {
			console.warn(
				`[fork-split] forkMessageId "${forkMessageId}" not found — all messages treated as inherited`,
			);
		}
		return { inherited: messages, current: [] };
	}

	// Include the full turn (up to next user message).
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
