// Head moves from the transcript (82tn.51): the Head Log dialog's open state, and the one
// preview-then-commit path every move control uses. Components name the move; the wire's
// intent stays here, out of their vocabulary.
import type { MoveIntent } from "../../contracts/ws-rpc.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import { showToast } from "./ui.svelte.js";

/** The session whose Head Log dialog is open, if any. */
export const headLog = $state<{ sessionId: string | undefined }>({
	sessionId: undefined,
});

export type { HeadFork, HeadLogEntry } from "../../contracts/ws-rpc.js";

/** Back to before a message, sending nothing: the rewind dialog's move. The dialog has already
 *  said whether the files there were pruned, so the move does not say it again. */
export const rewindTo = (
	sessionId: string,
	messageId: string,
): Promise<boolean> =>
	moveHead(sessionId, { _tag: "rewind", messageId }, { saysPruned: false });

/** Back to before a message, sending `resend` from there: edit-and-resend, or regenerate. */
export const resendFrom = (
	sessionId: string,
	messageId: string,
	resend: string,
): Promise<boolean> =>
	moveHead(sessionId, { _tag: "rewind", messageId, resend });

/** Back to where the move before `moveId` left the conversation; the undo is a new entry. */
export const undoMove = (sessionId: string, moveId: string): Promise<boolean> =>
	moveHead(sessionId, { _tag: "undo", moveId });

/** To another branch's tip. */
export const switchBranch = (
	sessionId: string,
	nodeId: string,
): Promise<boolean> => moveHead(sessionId, { _tag: "switch", nodeId });

/** Previews and commits one move with the preview's id, so another device confirming the same
 *  proposal lands the same move. Resolves whether it landed; a refusal is toasted. */
async function moveHead(
	sessionId: string,
	intent: MoveIntent,
	{ saysPruned = true } = {},
): Promise<boolean> {
	try {
		const { moveId, files } = await rpc("PreviewHeadMove", {
			sessionId,
			intent,
		});
		await rpc("CommitHeadMove", { sessionId, intent, moveId });
		// Conversation-only moves go into pruned history; only the files there are gone.
		if (saysPruned && files === "pruned")
			showToast("Files from this point were pruned.");
		return true;
	} catch (error) {
		toastFailure("Could not move the conversation.", "warn")(error);
		return false;
	}
}
