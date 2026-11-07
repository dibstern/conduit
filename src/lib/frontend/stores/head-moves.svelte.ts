// Head moves from the transcript (82tn.51): the Head Log dialog's open state, and the one
// preview-then-commit path every move control uses. Components name the move; the wire's
// intent stays here, out of their vocabulary.
import { FilesRefused } from "../../contracts/limit-recovery.js";
import type { MoveIntent } from "../../contracts/ws-rpc.js";
import { failureLine, toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import { getBrowserClientId } from "./client-identity.js";
import { selection } from "./selection.svelte.js";
import { followFork, sessionState } from "./session.svelte.js";
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
 *  each folder's prefixed when there are several, or why the files cannot go back, and whether
 *  they can go into a new worktree instead (82tn.54): only files still kept there can. */
export const planRewindFiles = (
	sessionId: string,
	messageId: string,
): Promise<
	| { paths: string[] }
	| { refused: string; branchable: boolean; before?: string }
> =>
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
		async (error: unknown) => {
			const refused = failureLine(error, "The files could not be checked.");
			if (
				!(error instanceof FilesRefused) ||
				(error.reason !== "other_session" && error.reason !== "changed")
			)
				return { refused, branchable: false };
			// A branch starts where the rewind would land: before the first message of the picked
			// message's Run, which only the planner knows. The conversation-only preview names it.
			const before = await rpc("PreviewHeadMove", {
				sessionId,
				intent: { _tag: "rewind", messageId },
			}).then(
				(preview) => preview.before,
				() => undefined,
			);
			return before === undefined
				? { refused, branchable: false }
				: { refused, branchable: true, before };
		},
	);

/** A fork from before a message into a new worktree holding the files kept there (82tn.54);
 *  the conversation here stays where it is. */
export const branchIntoWorktree = (sessionId: string, messageId: string) => {
	const from = selection.scope;
	void rpc("ForkSession", {
		sessionId,
		originId: getBrowserClientId(),
		messageId,
		files: true,
	})
		.then((response) => followFork(from, response))
		.catch(toastFailure("Could not branch into a worktree."));
};

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
