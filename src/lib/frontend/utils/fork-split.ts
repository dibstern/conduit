// Fork Split Utility
// Splits a ChatMessage array at the fork point for rendering inherited
// vs new messages in a forked session.

import type { ChatMessage } from "../types.js";
import { createFrontendLogger } from "./logger.js";

const log = createFrontendLogger("fork-split");

export interface ForkSplit {
	/** Messages inherited from the parent session (before and including the fork point). */
	inherited: ChatMessage[];
	/** New messages created in this fork (after the fork point). */
	current: ChatMessage[];
}

/**
 * Split messages at the fork boundary using the fork-point timestamp.
 *
 * Compare the same (created_at, id) pair used to order persisted transcripts.
 * The boundary itself is inherited. Messages without createdAt are live.
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
		const inherited: ChatMessage[] = [];
		const current: ChatMessage[] = [];
		for (const msg of messages) {
			const createdAt =
				msg.messageOrder?.createdAt ??
				("createdAt" in msg ? msg.createdAt : undefined);
			const messageId =
				msg.messageOrder?.id ??
				("messageId" in msg ? msg.messageId : undefined);
			if (
				typeof createdAt === "number" &&
				(createdAt < forkPointTimestamp ||
					(createdAt === forkPointTimestamp &&
						forkMessageId !== undefined &&
						typeof messageId === "string" &&
						messageId <= forkMessageId))
			) {
				inherited.push(msg);
			} else {
				current.push(msg);
			}
		}
		return { inherited, current };
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
			log.warn(
				`forkMessageId "${forkMessageId}" not found — all messages treated as inherited`,
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
