import type { SessionActivityView } from "../../shared-types.js";
import { replaceRoute } from "../stores/router.svelte.js";
import { selection } from "../stores/selection.svelte.js";
import {
	applyFamilyChange,
	findSession,
	sessionState,
} from "../stores/session.svelte.js";
import { applySessionChange } from "../transport/session-subscription.svelte.js";
import type { SessionInfo } from "../types.js";

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

/** A row's activity while its foreground Run is working. */
export const WORKING_ACTIVITY: SessionActivityView = {
	foreground: "working",
	background: "none",
	label: "working",
};
const IDLE: SessionActivityView = {
	foreground: "idle",
	background: "none",
	label: "idle",
};

/** Set a session's foreground Run for test or story setup, through the feed that carries its
 *  row: the shell for a root, the family for a child. A session with no row gains a shell row. */
export function setSessionWorkingForSetup(
	sessionId: string,
	working: boolean,
	projectSlug = "myapp",
): void {
	const activity = working ? WORKING_ACTIVITY : IDLE;
	const withActivity = (row: SessionInfo): SessionInfo =>
		row.id === sessionId ? { ...row, activity } : row;
	const familyOnly =
		!sessionState.liveSessions.has(sessionId) &&
		sessionState.familySessions.some((row) => row.id === sessionId);
	// Setup snapshots avoid competing with another fixture's feed sequence.
	if (familyOnly) {
		applyFamilyChange({
			_tag: "snapshot",
			sequence: 0,
			rows: sessionState.familySessions.map(withActivity),
		});
		return;
	}
	const row: SessionInfo = findSession(sessionId) ?? {
		id: sessionId,
		title: sessionId,
		projectSlug,
		accountId: null,
		status: "idle",
	};
	applySessionChange({
		_tag: "snapshot",
		sequence: 0,
		rows: [
			...[...sessionState.liveSessions.values()].filter(
				(live) => live.id !== sessionId,
			),
			{ ...row, activity },
		],
	});
}
