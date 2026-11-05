// Head moves from the transcript (82tn.51): the Head Log dialog's open state, and the one
// preview-then-commit path every move control uses. Components name the move; the wire's
// intent stays here, out of their vocabulary.
import type { MoveIntent } from "../../contracts/ws-rpc.js";
import { failureLine, toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import { sessionState } from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";

/** The session whose Head Log dialog is open, if any. */
export const headLog = $state<{ sessionId: string | undefined }>({
	sessionId: undefined,
});

export type { HeadFork, HeadLogEntry } from "../../contracts/ws-rpc.js";

/** Back to before a message, sending nothing: the rewind dialog's move, with the files there
 *  too when `withFiles` (82tn.53). The dialog has already said whether the files there are kept,
 *  so the move does not say it again. */
export const rewindTo = (
	sessionId: string,
	messageId: string,
	withFiles = false,
): Promise<boolean> =>
	moveHead(
		sessionId,
		withFiles
			? { _tag: "rewind", messageId, withFiles }
			: { _tag: "rewind", messageId },
		{ saysFiles: false },
	);

/** What a rewind with files to before a message would do (82tn.53): the paths that change,
 *  each folder's prefixed when there are several, or why the files cannot go back. */
export const planRewindFiles = (
	sessionId: string,
	messageId: string,
): Promise<{ paths: string[] } | { refused: string }> =>
	rpc("PreviewHeadMove", {
		sessionId,
		intent: { _tag: "rewind", messageId, withFiles: true },
	}).then(
		({ restore }) => {
			const folders = restore?.folders ?? [];
			return {
				paths: folders.flatMap(({ directory, changes }) =>
					changes.map(({ path }) =>
						folders.length > 1 ? `${directory}/${path}` : path,
					),
				),
			};
		},
		(error: unknown) => ({
			refused: failureLine(error, "The files could not be checked."),
		}),
	);

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
 *  proposal lands the same move. Resolves whether it landed; a refusal is toasted while the
 *  session is still the one shown. */
async function moveHead(
	sessionId: string,
	intent: MoveIntent,
	{ saysFiles = true } = {},
): Promise<boolean> {
	try {
		const { moveId, files } = await rpc("PreviewHeadMove", {
			sessionId,
			intent,
		});
		await rpc("CommitHeadMove", { sessionId, intent, moveId });
		// Conversation-only moves go into pruned history; only the files there are gone.
		if (saysFiles && files === "pruned")
			showToast("Files from this point were pruned.");
		if (saysFiles && files === "not_available")
			showToast("Files from this point are not available.");
		return true;
	} catch (error) {
		if (sessionState.currentId === sessionId)
			toastFailure("Could not move the conversation.", "warn")(error);
		return false;
	}
}
