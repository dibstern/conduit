import { tick } from "svelte";
import { pendingMessage } from "../utils/turn-stops.js";
import { segmentTurns, turnLog } from "../utils/turns.js";
import { getSessionPhase, sessionMessages } from "./chat.svelte.js";
import {
	messageSurfacing,
	sessionJevEnabled,
} from "./message-surfacing.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { loadOlderTranscript } from "./transcript.svelte.js";
import { revealTurnTarget } from "./turn-panel.svelte.js";

/** Land in the viewed session, defaulting to the primary transcript, paging if needed.
 *  A loaded part can be named by its uuid: live parts have no message id yet. */
export async function reveal(
	anchor: { sessionId?: string | undefined } & (
		| { messageId: string; partId?: string | undefined }
		| { uuid: string }
	),
): Promise<"landed" | "missing"> {
	const primarySessionId = sessionState.currentId;
	const sessionId = anchor.sessionId ?? primarySessionId;
	if (!sessionId) return "missing";
	const chat = () => sessionMessages.get(sessionId);
	const partUuid =
		"uuid" in anchor
			? anchor.uuid
			: anchor.partId === undefined
				? undefined
				: `${anchor.messageId}/${anchor.partId}`;
	const findTarget = () =>
		chat()?.messages.find((message) =>
			partUuid === undefined
				? message.type === "user" &&
					"messageId" in anchor &&
					message.messageId === anchor.messageId
				: message.uuid === partUuid,
		);
	let target = findTarget();
	let paged = false;
	while (!target && chat()?.historyHasMore) {
		const oldestId = chat()?.transcript?.rows[0]?.id;
		try {
			await loadOlderTranscript(sessionId);
			paged = true;
		} catch {
			return "missing";
		}
		if (sessionState.currentId !== primarySessionId) return "missing";
		target = findTarget();
		if (!target && chat()?.transcript?.rows[0]?.id === oldestId)
			return "missing";
	}
	if (!target) return "missing";

	if (paged) {
		// Let prepending preserve the reading position before the destination scrolls.
		await tick();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	}
	if (sessionState.currentId !== primarySessionId) return "missing";
	const turns = segmentTurns(
		chat()?.messages ?? [],
		getSessionPhase(sessionId) !== "idle",
	);
	const turn = turns.find((turn) =>
		turnLog(turn).segment.activity.some((part) => part.uuid === target.uuid),
	);
	if (turn) {
		const jev = sessionJevEnabled(
			findSession(sessionId),
			messageSurfacing.status,
		);
		return revealTurnTarget(
			sessionId,
			turn.id,
			jev &&
				target.type === "assistant" &&
				(target.surfacingProbabilities != null ||
					!!target.surfacingMark ||
					pendingMessage(turnLog(turn).segment.activity, turn.live) === target)
				? { kind: "message", uuid: target.uuid }
				: { kind: "step", id: target.uuid },
		);
	}
	// User messages and the Turn's trailing reply live outside the panel.
	for (let frame = 0; frame <= 2; frame++) {
		if (sessionState.currentId !== primarySessionId) return "missing";
		const element = document.querySelector<HTMLElement>(
			`[data-session-id="${CSS.escape(sessionId)}"] [data-uuid="${CSS.escape(target.uuid)}"]`,
		);
		if (element) {
			element.scrollIntoView({ block: "center" });
			return "landed";
		}
		if (frame < 2)
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
	}
	return "missing";
}
