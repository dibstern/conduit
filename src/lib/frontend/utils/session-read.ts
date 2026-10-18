import { getBrowserClientId } from "../stores/client-identity.js";
import {
	navigate,
	previousHistoryEntryIsSessionList,
} from "../stores/router.svelte.js";
import {
	isSessionSnoozed,
	sessionState,
	setReadMark,
	withReadMark,
} from "../stores/session.svelte.js";
import { sessionViewState } from "../stores/session-view.svelte.js";
import { showToast } from "../stores/ui.svelte.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";

export function backToSessions(): void {
	if (previousHistoryEntryIsSessionList()) {
		window.history.back();
	} else {
		navigate("/");
	}
}

export async function toggleSessionRead(session: SessionInfo): Promise<void> {
	if (session.settledAt != null || isSessionSnoozed(session, sessionState.now))
		return;
	const projectSlug = session.projectSlug;
	if (!projectSlug) return;
	const input = {
		sessionId: session.id,
		originId: getBrowserClientId(),
	};
	const latest = () =>
		withReadMark(
			sessionState.rootSessions.find((row) => row.id === session.id) ?? session,
		);
	// The dot moves now; the server's row replaces the mark when it lands.
	const write = async (unread: boolean) => {
		const drop = setReadMark(latest(), unread);
		try {
			await (unread
				? rpc("MarkSessionUnread", input)
				: rpc("MarkSessionRead", input));
		} catch (error) {
			drop();
			throw error;
		}
	};
	const markUnread = !latest().unread;
	if (
		markUnread &&
		sessionViewState.compact &&
		sessionState.currentId === session.id
	)
		backToSessions();
	try {
		await write(markUnread);
		showToast(
			`Marked ${markUnread ? "unread" : "read"} “${session.title || "New Session"}”`,
			{
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void write(!markUnread).catch(toastFailure("Couldn't undo"));
					},
				},
			},
		);
	} catch (error) {
		toastFailure(markUnread ? "Couldn't mark unread" : "Couldn't mark read")(
			error,
		);
	}
}
