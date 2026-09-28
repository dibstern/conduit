// A desktop hold starts when the current session is marked unread. It ends on
// mark read, another session opening, a send, or a confirmed server read.
// Fresh holds await an unread snapshot so an older read snapshot cannot clear
// them. The ID survives reloads in this tab's sessionStorage, never in the URL;
// restored holds accept the next read snapshot as authoritative.

import type { SessionInfo } from "../types.js";
import { getCurrentSlug } from "./router.svelte.js";
import { sessionState } from "./session.svelte.js";
import { sessionViewState } from "./session-view.svelte.js";

const STORAGE_KEY = "session-unread-hold";

function readHeldSessionId(): string | null {
	try {
		const id = sessionStorage.getItem(STORAGE_KEY);
		return id && id.trim() === id && id.length <= 512 ? id : null;
	} catch {
		return null;
	}
}

const restoredSessionId = readHeldSessionId();
const unreadHold = $state({
	sessionId: restoredSessionId,
	confirmed: restoredSessionId !== null,
});

function holdSessionUnread(sessionId: string, confirmed: boolean): void {
	unreadHold.sessionId = sessionId;
	unreadHold.confirmed = confirmed;
	try {
		sessionStorage.setItem(STORAGE_KEY, sessionId);
	} catch {
		// The hold still works until this tab reloads if storage is unavailable.
	}
}

function releaseSessionUnreadHold(): void {
	if (unreadHold.sessionId === null) return;
	unreadHold.sessionId = null;
	unreadHold.confirmed = false;
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage may be unavailable in a private or restricted context.
	}
}

export function isSessionUnreadHeld(sessionId: string): boolean {
	return !sessionViewState.compact && unreadHold.sessionId === sessionId;
}

export function noteReadStateChanged(
	session: SessionInfo,
	unread: boolean,
): void {
	const currentSlug = getCurrentSlug();
	if (
		unread &&
		!sessionViewState.compact &&
		currentSlug != null &&
		(session.projectSlug ?? currentSlug) === currentSlug &&
		sessionState.currentId === session.id
	) {
		const snapshot =
			sessionState.rootSessions.find((row) => row.id === session.id) ??
			sessionState.familySessions.find((row) => row.id === session.id);
		holdSessionUnread(session.id, snapshot?.unread === true);
	} else if (unreadHold.sessionId === session.id) {
		releaseSessionUnreadHold();
	}
}

export function noteSessionOpened(sessionId: string): { skipMarkRead?: true } {
	if (unreadHold.sessionId !== null && unreadHold.sessionId !== sessionId) {
		releaseSessionUnreadHold();
	}
	return isSessionUnreadHeld(sessionId) ? { skipMarkRead: true } : {};
}

export function noteMessageSent(sessionId: string): void {
	if (unreadHold.sessionId === sessionId) releaseSessionUnreadHold();
}

export function noteSessionSnapshot(
	sessionId: string,
	unread: boolean | undefined,
): void {
	if (unreadHold.sessionId !== sessionId) return;
	if (unread === true) unreadHold.confirmed = true;
	else if (unreadHold.confirmed) releaseSessionUnreadHold();
}
