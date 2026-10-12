import { getBrowserClientId } from "../stores/client-identity.js";
import {
	getCurrentSlug,
	navigate,
	previousHistoryEntryIsSessionList,
} from "../stores/router.svelte.js";
import {
	isSessionSnoozed,
	sessionState,
	setReadMark,
	withReadMark,
} from "../stores/session.svelte.js";
import { refreshListedSessions } from "../stores/session-list.svelte.js";
import { sessionViewState } from "../stores/session-view.svelte.js";
import { showToast } from "../stores/ui.svelte.js";
import {
	markSessionReadRpc,
	markSessionUnreadRpc,
} from "../transport/ws-rpc-client.js";
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
	const foreign = projectSlug !== getCurrentSlug();
	const input = {
		projectSlug,
		sessionId: session.id,
		originId: getBrowserClientId(),
	};
	const latest = () =>
		withReadMark(
			foreign
				? session
				: (sessionState.rootSessions.find((row) => row.id === session.id) ??
						session),
		);
	// The dot moves now; the server's row replaces the mark when it lands.
	const write = async (unread: boolean) => {
		const drop = setReadMark(latest(), unread);
		try {
			await (unread ? markSessionUnreadRpc(input) : markSessionReadRpc(input));
		} catch (error) {
			drop();
			throw error;
		}
		// Rows from other projects only change on a fresh read.
		if (foreign) await refreshListedSessions().finally(drop);
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
						void write(!markUnread).catch(() => {
							showToast("Couldn't undo", { variant: "error" });
						});
					},
				},
			},
		);
	} catch {
		showToast(markUnread ? "Couldn't mark unread" : "Couldn't mark read", {
			variant: "error",
		});
	}
}
