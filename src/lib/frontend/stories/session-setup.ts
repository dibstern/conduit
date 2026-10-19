import { replaceRoute } from "../stores/router.svelte.js";
import { selection } from "../stores/selection.svelte.js";
import { sessionState } from "../stores/session.svelte.js";
import { applySessionChange } from "../transport/session-subscription.svelte.js";

/** Open a live session for test or story setup; null returns to the session list. */
export function openSessionForSetup(
	sessionId: string | null,
	projectSlug = "myapp",
): void {
	if (sessionId === null) {
		replaceRoute("/");
		return;
	}
	if (
		!sessionState.liveSessions.has(sessionId) &&
		!sessionState.familySessions.some((row) => row.id === sessionId)
	) {
		// A setup snapshot avoids competing with another fixture's feed sequence.
		applySessionChange({
			_tag: "snapshot",
			sequence: 0,
			rows: [
				...sessionState.liveSessions.values(),
				{
					id: sessionId,
					title: sessionId,
					projectSlug,
					accountId: null,
					status: "idle",
				},
			],
		});
	}
	selection.open(sessionId);
}
