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
	forkSessionId?: string,
): ForkSplit {
	// New forks store the Source's ordering id. Legacy Cursor forks already
	// store the copied id, so compare both in the Source's id space.
	const suffix = forkSessionId === undefined ? undefined : `_${forkSessionId}`;
	const sourceId = (id: string | undefined) =>
		suffix && id?.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
	const boundaryId = sourceId(forkMessageId);
	// Primary: timestamp-based split (reliable — each message self-identifies).
	if (forkPointTimestamp != null) {
		const inherited: ChatMessage[] = [];
		const current: ChatMessage[] = [];
		for (const msg of messages) {
			const createdAt =
				msg.messageOrder?.createdAt ??
				("createdAt" in msg ? msg.createdAt : undefined);
			const messageId = sourceId(
				msg.messageOrder?.id ??
					("messageId" in msg ? msg.messageId : undefined),
			);
			if (
				typeof createdAt === "number" &&
				(createdAt < forkPointTimestamp ||
					(createdAt === forkPointTimestamp &&
						boundaryId !== undefined &&
						typeof messageId === "string" &&
						messageId <= boundaryId))
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
		const msg = messages[i];
		if (msg === undefined) continue;
		if ("messageId" in msg && sourceId(msg.messageId) === boundaryId) {
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
