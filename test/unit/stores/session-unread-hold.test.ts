import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSession } from "../../../src/lib/frontend/stories/mocks.js";

function memoryStorage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: (key) => entries.get(key) ?? null,
		key: (index) => [...entries.keys()][index] ?? null,
		removeItem: (key) => entries.delete(key),
		setItem: (key, value) => entries.set(key, value),
	};
}

async function setup() {
	const [
		hold,
		{ attachedProjectState },
		{ sessionState },
		{ sessionViewState },
	] = await Promise.all([
		import("../../../src/lib/frontend/stores/session-unread-hold.svelte.js"),
		import("../../../src/lib/frontend/stores/router.svelte.js"),
		import("../../../src/lib/frontend/stores/session.svelte.js"),
		import("../../../src/lib/frontend/stores/session-view.svelte.js"),
	]);
	const session = { ...mockSession, id: "held", projectSlug: "project-a" };
	attachedProjectState.slug = "project-a";
	sessionState.currentId = session.id;
	sessionState.rootSessions = [session];
	sessionState.familySessions = [session];
	sessionViewState.compact = false;
	return {
		hold,
		session,
		sessionState,
		sessionViewState,
		attachedProjectState,
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("sessionStorage", memoryStorage());
});

afterEach(() => vi.unstubAllGlobals());

describe("session unread hold", () => {
	it("holds only the current desktop session in the current project", async () => {
		const { hold, session, sessionState } = await setup();
		hold.noteReadStateChanged({ ...session, id: "other" }, true);
		expect(hold.isSessionUnreadHeld("other")).toBe(false);
		hold.noteReadStateChanged({ ...session, projectSlug: "project-b" }, true);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		sessionState.currentId = "other";
		hold.noteReadStateChanged(session, true);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		sessionState.currentId = session.id;
		hold.noteReadStateChanged(session, true);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(true);
		expect(hold.noteSessionOpened(session.id)).toEqual({ skipMarkRead: true });
	});

	it("releases on another session opening, send, and mark read", async () => {
		const { hold, session } = await setup();
		const markUnread = () => hold.noteReadStateChanged(session, true);
		markUnread();
		expect(hold.noteSessionOpened("other")).toEqual({});
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		markUnread();
		hold.noteMessageSent("other");
		expect(hold.isSessionUnreadHeld(session.id)).toBe(true);
		hold.noteMessageSent(session.id);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		markUnread();
		hold.noteReadStateChanged(session, false);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
	});

	it("waits for an unread snapshot before trusting a read snapshot", async () => {
		const { hold, session } = await setup();
		hold.noteReadStateChanged(session, true);
		hold.noteSessionSnapshot(session.id, undefined);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(true);
		hold.noteSessionSnapshot(session.id, true);
		hold.noteSessionSnapshot(session.id, undefined);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		expect(hold.noteSessionOpened(session.id)).toEqual({});
	});

	it("reconciles a restored hold with the next read snapshot", async () => {
		const { hold, session } = await setup();
		hold.noteReadStateChanged(session, true);
		expect(sessionStorage.getItem("session-unread-hold")).toBe(session.id);
		vi.resetModules();
		const restored = await setup();
		expect(restored.hold.isSessionUnreadHeld(session.id)).toBe(true);
		restored.hold.noteSessionSnapshot(session.id, undefined);
		expect(restored.hold.isSessionUnreadHeld(session.id)).toBe(false);
		expect(sessionStorage.getItem("session-unread-hold")).toBeNull();
	});

	it("never reports a hold on phones, including after returning to desktop", async () => {
		const { hold, session, sessionViewState } = await setup();
		sessionViewState.compact = true;
		hold.noteReadStateChanged(session, true);
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		sessionViewState.compact = false;
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		hold.noteReadStateChanged(session, true);
		sessionViewState.compact = true;
		expect(hold.isSessionUnreadHeld(session.id)).toBe(false);
		expect(hold.noteSessionOpened(session.id)).toEqual({});
		sessionViewState.compact = false;
		expect(hold.isSessionUnreadHeld(session.id)).toBe(true);
	});
});
