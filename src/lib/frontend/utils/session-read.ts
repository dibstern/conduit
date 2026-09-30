import { getBrowserClientId } from "../stores/client-identity.js";
import {
	getCurrentSlug,
	navigate,
	previousHistoryEntryIsSessionList,
} from "../stores/router.svelte.js";
import {
	isSessionSnoozed,
	loadDaemonSessions,
	searchSessions,
	sessionState,
} from "../stores/session.svelte.js";
import { noteReadStateChanged } from "../stores/session-unread-hold.svelte.js";
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
	const projectSlug = session.projectSlug ?? getCurrentSlug();
	if (!projectSlug) return;
	const foreign = projectSlug !== getCurrentSlug();
	const refreshForeign = () =>
		sessionState.searchResults === null
			? loadDaemonSessions()
			: searchSessions(sessionState.searchQuery, true);
	const input = {
		projectSlug,
		sessionId: session.id,
		originId: getBrowserClientId(),
	};
	const currentSession = foreign
		? session
		: (sessionState.rootSessions.find((row) => row.id === session.id) ??
			session);
	const markUnread = !currentSession.unread;
	try {
		await (markUnread
			? markSessionUnreadRpc(input)
			: markSessionReadRpc(input));
		noteReadStateChanged(session, markUnread);
		if (foreign) await refreshForeign();
		if (
			markUnread &&
			sessionViewState.compact &&
			sessionState.currentId === session.id
		) {
			backToSessions();
		}
		showToast(
			`Marked ${markUnread ? "unread" : "read"} “${session.title || "New Session"}”`,
			{
				duration: 5000,
				action: {
					label: "Undo",
					run: () => {
						void (
							markUnread
								? markSessionReadRpc(input)
								: markSessionUnreadRpc(input)
						)
							.then(async () => {
								noteReadStateChanged(session, !markUnread);
								if (foreign) await refreshForeign();
							})
							.catch(() => {
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
