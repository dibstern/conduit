import { tick } from "svelte";
import { currentChat } from "./chat.svelte.js";
import { sessionState } from "./session.svelte.js";
import { loadOlderTranscript } from "./transcript.svelte.js";

export const revealedPart = $state<{
	request: { uuid: string; counter: number } | null;
}>({ request: null });

let revealCounter = 0;

/** Land on a message or activity step in the open session, paging if needed. */
export async function reveal(anchor: {
	messageId: string;
	partId?: string | undefined;
}): Promise<"landed" | "missing"> {
	const sessionId = sessionState.currentId;
	if (!sessionId) return "missing";
	const partUuid =
		anchor.partId === undefined
			? undefined
			: `${anchor.messageId}/${anchor.partId}`;
	const findTarget = () =>
		currentChat().messages.find((message) =>
			partUuid === undefined
				? message.type === "user" && message.messageId === anchor.messageId
				: message.uuid === partUuid,
		);
	let target = findTarget();
	while (!target && currentChat().historyHasMore) {
		const oldestId = currentChat().transcript?.rows[0]?.id;
		try {
			await loadOlderTranscript(sessionId);
		} catch {
			return "missing";
		}
		if (sessionState.currentId !== sessionId) return "missing";
		target = findTarget();
		if (!target && currentChat().transcript?.rows[0]?.id === oldestId)
			return "missing";
	}
	if (!target) return "missing";

	// Mount any newly paged turns before asking their activity panel to jump.
	await tick();
	// Prepending preserves the reading position in a frame after the DOM update.
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	if (sessionState.currentId !== sessionId) return "missing";
	if (partUuid !== undefined) {
		const counter = ++revealCounter;
		revealedPart.request = { uuid: partUuid, counter };
		try {
			await tick();
		} finally {
			// A remounted turn must not replay an earlier jump.
			if (revealedPart.request?.counter === counter)
				revealedPart.request = null;
		}
	}
	if (sessionState.currentId !== sessionId) return "missing";
	const element = document.querySelector<HTMLElement>(
		`[${partUuid === undefined ? "data-uuid" : "data-part"}="${CSS.escape(target.uuid)}"]`,
	);
	if (!element) return "missing";
	if (partUuid === undefined) element.scrollIntoView({ block: "center" });
	return "landed";
}
