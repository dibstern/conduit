import { tick } from "svelte";
import { pendingMessage } from "../utils/turn-stops.js";
import { segmentTurns, turnLog } from "../utils/turns.js";
import { getSessionPhase } from "./chat.svelte.js";
import {
	messageSurfacing,
	sessionJevEnabled,
} from "./message-surfacing.svelte.js";
import { findSession } from "./session.svelte.js";
import { primaryTranscript, type TranscriptView } from "./transcript.svelte.js";
import { revealTurnTarget } from "./turn-panel.svelte.js";

/** Land in the viewed session, defaulting to the primary transcript, paging if needed.
 *  A loaded part can be named by its uuid: live parts have no message id yet. */
export async function reveal(
	anchor: { sessionId?: string | undefined } & (
		| { messageId: string; partId?: string | undefined }
		| { uuid: string }
	),
	view: TranscriptView = primaryTranscript,
	root?: HTMLElement,
): Promise<"landed" | "missing"> {
	const sessionId = anchor.sessionId ?? view.sessionId;
	if (!sessionId || sessionId !== view.sessionId) return "missing";
	let generation = view.generation;
	const current = () =>
		view.sessionId === sessionId && view.generation === generation;
	const chat = () => view.chat;
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
	if ("messageId" in anchor) {
		const loading = view.loadMessage(anchor.messageId);
		generation = view.generation;
		try {
			await loading;
		} catch {
			return "missing";
		}
		if (!current()) return "missing";
		paged = true;
		target = findTarget();
		if (!target) return "missing";
	}
	while (!target && chat()?.historyHasMore) {
		const oldestId = chat()?.transcript?.rows[0]?.id;
		try {
			const loading = view.loadOlder();
			generation = view.generation;
			await loading;
			paged = true;
		} catch {
			return "missing";
		}
		if (!current()) return "missing";
		target = findTarget();
		if (!target && chat()?.transcript?.rows[0]?.id === oldestId)
			return "missing";
	}
	if (!target) return "missing";

	if (paged) {
		// Let prepending preserve the reading position before the destination scrolls.
		await tick();
		if (!current()) return "missing";
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	}
	if (!current()) return "missing";
	const turns = segmentTurns(
		chat()?.messages ?? [],
		getSessionPhase(sessionId) !== "idle" && view.window.kind === "latest",
	);
	const turn = turns.find((turn) =>
		turnLog(turn).segment.activity.some((part) => part.uuid === target.uuid),
	);
	if (turn) {
		const jev = sessionJevEnabled(
			findSession(sessionId),
			messageSurfacing.status,
		);
		const result = await revealTurnTarget(
			view.id,
			turn.id,
			jev &&
				target.type === "assistant" &&
				(target.surfacingProbabilities != null ||
					!!target.surfacingMark ||
					pendingMessage(turnLog(turn).segment.activity, turn.live) === target)
				? { kind: "message", uuid: target.uuid }
				: { kind: "step", id: target.uuid },
		);
		return current() ? result : "missing";
	}
	// User messages and the Turn's trailing reply live outside the panel.
	const scope = root ?? document.getElementById("messages");
	for (let frame = 0; frame <= 2; frame++) {
		if (!current()) return "missing";
		const element = scope?.querySelector<HTMLElement>(
			`[data-uuid="${CSS.escape(target.uuid)}"]`,
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
