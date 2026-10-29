import { tick } from "svelte";
import { primaryTranscript, type TranscriptView } from "./transcript.svelte.js";

export const revealedPart = $state<{
	request: {
		sessionId: string;
		uuid: string;
		counter: number;
		viewId: symbol;
	} | null;
}>({ request: null });

let revealCounter = 0;

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
	const generation = view.generation;
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
	while (!target && chat()?.historyHasMore) {
		const oldestId = chat()?.transcript?.rows[0]?.id;
		try {
			await view.loadOlder();
		} catch {
			return "missing";
		}
		if (!current()) return "missing";
		target = findTarget();
		if (!target && chat()?.transcript?.rows[0]?.id === oldestId)
			return "missing";
	}
	if (!target) return "missing";

	// Mount any newly paged turns before asking their activity panel to jump.
	await tick();
	// Prepending preserves the reading position in a frame after the DOM update.
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	if (!current()) return "missing";
	if (partUuid !== undefined) {
		const counter = ++revealCounter;
		revealedPart.request = {
			sessionId,
			uuid: partUuid,
			counter,
			viewId: view.id,
		};
		try {
			await tick();
		} finally {
			// A remounted turn must not replay an earlier jump.
			if (revealedPart.request?.counter === counter)
				revealedPart.request = null;
		}
	}
	if (!current()) return "missing";
	const scope = root ?? document.getElementById("messages");
	const element = scope?.querySelector<HTMLElement>(
		`[${partUuid === undefined ? "data-uuid" : "data-part"}="${CSS.escape(target.uuid)}"]`,
	);
	if (!element) return "missing";
	if (
		partUuid === undefined ||
		element.dataset["testid"] === "surfacing-msg-card"
	)
		element.scrollIntoView({ block: "center" });
	return "landed";
}
