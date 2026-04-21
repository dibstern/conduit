// ─── Session Store Tests ─────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionState,
	completeNewSession,
	ERROR_DISPLAY_MS,
	failNewSession,
	getFilteredSessions,
	groupSessionsByDate,
	handleSessionForked,
	handleSessionList,
	handleSessionSwitched,
	NEW_SESSION_TIMEOUT_MS,
	requestNewSession,
	resetSessionCreation,
	sendNewSession,
	sessionCreation,
	sessionState,
	setCurrentSession,
	setSearchQuery,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import type {
	RelayMessage,
	SessionInfo,
} from "../../../src/lib/frontend/types.js";

// ─── Helper: cast incomplete test data to the expected type ─────────────────
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(
	overrides: Partial<SessionInfo> & { id: string },
): SessionInfo {
	return {
		title: `Session ${overrides.id}`,
		...overrides,
	};
}

/** Create a Date for "today at hour H" relative to a reference date. */
function todayAt(ref: Date, hour: number): Date {
	const d = new Date(ref);
	d.setHours(hour, 0, 0, 0);
	return d;
}

/** Create a Date for "yesterday at hour H" relative to a reference date. */
function yesterdayAt(ref: Date, hour: number): Date {
	const d = new Date(ref);
	d.setDate(d.getDate() - 1);
	d.setHours(hour, 0, 0, 0);
	return d;
}

/** Create a Date for N days ago at hour H relative to a reference date. */
function daysAgoAt(ref: Date, days: number, hour: number): Date {
	const d = new Date(ref);
	d.setDate(d.getDate() - days);
	d.setHours(hour, 0, 0, 0);
	return d;
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
});

// ─── groupSessionsByDate (pure function) ────────────────────────────────────

describe("groupSessionsByDate", () => {
	// Use a reference "now" at noon local time to avoid edge cases
	const now = new Date();
	now.setHours(12, 0, 0, 0);

	it("puts sessions updated today into the 'today' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: todayAt(now, 10).toISOString() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(1);
		expect(groups.yesterday).toHaveLength(0);
		expect(groups.older).toHaveLength(0);
	});

	it("puts sessions from yesterday into the 'yesterday' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: yesterdayAt(now, 15).toISOString() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(0);
		expect(groups.yesterday).toHaveLength(1);
		expect(groups.older).toHaveLength(0);
	});

	it("puts older sessions into the 'older' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: daysAgoAt(now, 5, 10).toISOString() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(0);
		expect(groups.yesterday).toHaveLength(0);
		expect(groups.older).toHaveLength(1);
	});

	it("falls back to createdAt when updatedAt is missing", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", createdAt: todayAt(now, 8).toISOString() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(1);
	});

	it("falls back to epoch 0 when both timestamps are missing", () => {
		const sessions: SessionInfo[] = [makeSession({ id: "1" })];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.older).toHaveLength(1);
	});

	it("handles empty array", () => {
		const groups = groupSessionsByDate([]);
		expect(groups.today).toHaveLength(0);
		expect(groups.yesterday).toHaveLength(0);
		expect(groups.older).toHaveLength(0);
	});

	it("distributes mixed timestamps correctly", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "t", updatedAt: todayAt(now, 9).toISOString() }),
			makeSession({ id: "y", updatedAt: yesterdayAt(now, 14).toISOString() }),
			makeSession({ id: "o", updatedAt: daysAgoAt(now, 30, 10).toISOString() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(1);
		expect(groups.yesterday).toHaveLength(1);
		expect(groups.older).toHaveLength(1);
	});
});

// ─── handleSessionList ──────────────────────────────────────────────────────

describe("handleSessionList", () => {
	it("sets rootSessions when roots is true", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: true });
		expect(sessionState.rootSessions).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(sessionState.rootSessions[0]!.id).toBe("a");
	});

	it("sets allSessions when roots is false", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: false });
		expect(sessionState.allSessions).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(sessionState.allSessions[0]!.id).toBe("a");
	});

	it("ignores non-array sessions payload", () => {
		sessionState.rootSessions = [makeSession({ id: "existing" })];
		handleSessionList(
			msg({ type: "session_list", sessions: "not-array", roots: true }),
		);
		expect(sessionState.rootSessions).toHaveLength(1);
	});

	it("backward-compat: untagged session_list populates both arrays", () => {
		const root = makeSession({ id: "root1" });
		const child = makeSession({ id: "child1", parentID: "root1" });
		// Simulate an untagged message (no `roots` field) — e.g. from legacy sources
		handleSessionList(msg({ type: "session_list", sessions: [root, child] }));
		// rootSessions should contain only non-subagent sessions
		expect(sessionState.rootSessions).toHaveLength(1);
		expect(sessionState.rootSessions[0]?.id).toBe("root1");
		// allSessions should contain everything
		expect(sessionState.allSessions).toHaveLength(2);
	});
});

// ─── handleSessionSwitched ──────────────────────────────────────────────────

describe("handleSessionSwitched", () => {
	it("sets currentId from message id field (server sends 'id')", () => {
		handleSessionSwitched({
			type: "session_switched",
			id: "abc",
			sessionId: "abc",
		});
		expect(sessionState.currentId).toBe("abc");
	});

	it("ignores missing id", () => {
		sessionState.currentId = "existing";
		handleSessionSwitched(msg({ type: "session_switched" }));
		expect(sessionState.currentId).toBe("existing");
	});
});

// ─── setSearchQuery ─────────────────────────────────────────────────────────

describe("setSearchQuery", () => {
	it("updates searchQuery state", () => {
		setSearchQuery("hello");
		expect(sessionState.searchQuery).toBe("hello");
	});

	it("can clear search query", () => {
		setSearchQuery("something");
		setSearchQuery("");
		expect(sessionState.searchQuery).toBe("");
	});
});

// ─── setCurrentSession ──────────────────────────────────────────────────────

describe("setCurrentSession", () => {
	it("sets currentId", () => {
		setCurrentSession("sess-1");
		expect(sessionState.currentId).toBe("sess-1");
	});

	it("can set to null", () => {
		sessionState.currentId = "something";
		setCurrentSession(null);
		expect(sessionState.currentId).toBeNull();
	});
});

// ─── handleSessionForked (ticket 5.3) ───────────────────────────────────────

describe("handleSessionForked (ticket 5.3)", () => {
	it("adds the forked session to the session list", () => {
		sessionState.allSessions = [
			{ id: "ses_original", title: "Original", updatedAt: 1000 },
		];

		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.allSessions).toHaveLength(2);
		const forked = sessionState.allSessions.find(
			(s: SessionInfo) => s.id === "ses_forked",
		);
		expect(forked).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(forked!.parentID).toBe("ses_original");
	});

	it("does not duplicate if session already exists", () => {
		sessionState.allSessions = [
			{ id: "ses_forked", title: "Already Here", updatedAt: 1000 },
		];

		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.allSessions).toHaveLength(1);
	});

	it("preserves forkMessageId on forked session", () => {
		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "fork-1",
				title: "Forked",
				updatedAt: Date.now(),
				parentID: "parent-1",
				forkMessageId: "msg_42",
			},
			parentId: "parent-1",
			parentTitle: "Parent",
		});
		const found = sessionState.allSessions.find((s) => s.id === "fork-1");
		expect(found?.forkMessageId).toBe("msg_42");
	});
});

// ─── getFilteredSessions — subagent toggle ──────────────────────────────────

describe("getFilteredSessions — hideSubagentSessions toggle", () => {
	beforeEach(() => {
		uiState.hideSubagentSessions = true; // reset to default
	});

	it("excludes subagent sessions when hideSubagentSessions is true", () => {
		sessionState.rootSessions = [
			makeSession({ id: "a", title: "Parent", updatedAt: 1000 }),
		];
		uiState.hideSubagentSessions = true;
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a"]);
	});

	it("includes subagent sessions when hideSubagentSessions is false", () => {
		sessionState.allSessions = [
			makeSession({ id: "a", title: "Parent", updatedAt: 1000 }),
			makeSession({ id: "b", title: "Child", parentID: "a", updatedAt: 2000 }),
		];
		uiState.hideSubagentSessions = false;
		const ids = getFilteredSessions().map((s) => s.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b");
	});

	it("still applies search filter when subagents are visible", () => {
		sessionState.allSessions = [
			makeSession({ id: "a", title: "Parent Session", updatedAt: 1000 }),
			makeSession({
				id: "b",
				title: "Child Session",
				parentID: "a",
				updatedAt: 2000,
			}),
		];
		uiState.hideSubagentSessions = false;
		sessionState.searchQuery = "child";
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["b"]);
	});
});

// ─── SessionCreationStatus state machine ────────────────────────────────────

describe("SessionCreationStatus state machine", () => {
	beforeEach(() => {
		resetSessionCreation();
	});

	it("starts in idle phase", () => {
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("transitions idle -> creating with requestId", () => {
		const requestId = requestNewSession();
		expect(requestId).toMatch(/^[0-9a-f-]+$/); // UUID format
		expect(sessionCreation.value.phase).toBe("creating");
		if (sessionCreation.value.phase === "creating") {
			expect(sessionCreation.value.requestId).toBe(requestId);
			expect(sessionCreation.value.startedAt).toBeGreaterThan(0);
		}
	});

	it("rejects requestNewSession when not idle", () => {
		requestNewSession();
		const second = requestNewSession();
		expect(second).toBeNull(); // Guard: already creating
	});

	it("transitions creating -> idle on completeNewSession with matching requestId", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		completeNewSession(requestId);
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("ignores completeNewSession with non-matching requestId", () => {
		requestNewSession();
		completeNewSession("wrong-id");
		expect(sessionCreation.value.phase).toBe("creating"); // Still creating
	});

	it("transitions creating -> error on failNewSession", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		failNewSession(requestId, "API timeout");
		expect(sessionCreation.value.phase).toBe("error");
		if (sessionCreation.value.phase === "error") {
			expect(sessionCreation.value.message).toBe("API timeout");
		}
	});

	it("transitions error -> idle on resetSessionCreation", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		failNewSession(requestId, "fail");
		expect(sessionCreation.value.phase).toBe("error");
		resetSessionCreation();
		expect(sessionCreation.value.phase).toBe("idle");
	});

	// ─── Edge cases (no-ops) ────────────────────────────────────────────

	it("completeNewSession is a no-op when phase is idle", () => {
		completeNewSession("any-id");
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("completeNewSession is a no-op when phase is error", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		failNewSession(requestId, "fail");
		completeNewSession(requestId);
		expect(sessionCreation.value.phase).toBe("error"); // Still error
	});

	it("failNewSession is a no-op when phase is idle", () => {
		failNewSession("any-id", "shouldn't matter");
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("failNewSession is a no-op with wrong requestId", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		failNewSession("wrong-id", "shouldn't matter");
		expect(sessionCreation.value.phase).toBe("creating");
		if (sessionCreation.value.phase === "creating") {
			expect(sessionCreation.value.requestId).toBe(requestId);
		}
	});

	it("supports re-entrant create/complete cycles", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const id1 = requestNewSession()!;
		completeNewSession(id1);
		expect(sessionCreation.value.phase).toBe("idle");

		// biome-ignore lint/style/noNonNullAssertion: safe — back to idle after complete
		const id2 = requestNewSession()!;
		expect(id2).not.toBe(id1);
		expect(sessionCreation.value.phase).toBe("creating");
		completeNewSession(id2);
		expect(sessionCreation.value.phase).toBe("idle");
	});

	// ─── Timeout (store-level, using exported constants) ────────────────

	it("auto-fails after timeout", () => {
		vi.useFakeTimers();
		requestNewSession();
		expect(sessionCreation.value.phase).toBe("creating");

		vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS);
		expect(sessionCreation.value.phase).toBe("error");
		if (sessionCreation.value.phase === "error") {
			expect(sessionCreation.value.message).toContain("timed out");
		}

		// Auto-resets to idle after ERROR_DISPLAY_MS
		vi.advanceTimersByTime(ERROR_DISPLAY_MS);
		expect(sessionCreation.value.phase).toBe("idle");

		vi.useRealTimers();
	});

	it("timeout is cancelled when session completes before deadline", () => {
		vi.useFakeTimers();
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;

		vi.advanceTimersByTime(1000); // Not yet timed out
		completeNewSession(requestId);
		expect(sessionCreation.value.phase).toBe("idle");

		vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS); // Past the original deadline
		expect(sessionCreation.value.phase).toBe("idle"); // Should stay idle

		vi.useRealTimers();
	});

	// ─── clearSessionState integration (project switch safety) ──────────

	it("clearSessionState resets creation state (project switch cancels in-flight creation)", () => {
		vi.useFakeTimers();
		requestNewSession();
		expect(sessionCreation.value.phase).toBe("creating");

		clearSessionState();
		expect(sessionCreation.value.phase).toBe("idle");

		// Timeout timer should also be cancelled — advancing past deadline
		// should NOT transition to error
		vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS + 1000);
		expect(sessionCreation.value.phase).toBe("idle");

		vi.useRealTimers();
	});
});

// ─── sendNewSession (centralized guard + send) ──────────────────────────────

describe("sendNewSession", () => {
	let sent: Record<string, unknown>[];
	const mockSend = (data: Record<string, unknown>) => sent.push(data);

	beforeEach(() => {
		sent = [];
		resetSessionCreation();
	});

	it("sends new_session with requestId and returns requestId", () => {
		const requestId = sendNewSession(mockSend);
		expect(requestId).not.toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({ type: "new_session", requestId });
	});

	it("transitions to creating phase", () => {
		sendNewSession(mockSend);
		expect(sessionCreation.value.phase).toBe("creating");
	});

	it("returns null and sends nothing when already creating", () => {
		sendNewSession(mockSend);
		sent = [];
		const result = sendNewSession(mockSend);
		expect(result).toBeNull();
		expect(sent).toHaveLength(0);
	});

	// ─── Component guard lifecycle (mirrors Sidebar/SessionList) ────────

	it("mirrors Sidebar button guard: disabled when creating, re-enabled after complete", () => {
		// First click — succeeds, button should be disabled
		// biome-ignore lint/style/noNonNullAssertion: safe — first call from idle
		const requestId = sendNewSession(mockSend)!;
		expect(sessionCreation.value.phase === "creating").toBe(true);

		// Second click while creating — guard blocks
		expect(sendNewSession(mockSend)).toBeNull();

		// Server responds — button should re-enable
		completeNewSession(requestId);
		expect(sessionCreation.value.phase === "creating").toBe(false);

		// Third click — succeeds again
		sent = [];
		expect(sendNewSession(mockSend)).not.toBeNull();
		expect(sent).toHaveLength(1);
	});
});

// ─── handleSessionSwitched — requestId completion (co-located) ──────────────

describe("handleSessionSwitched — requestId completion", () => {
	beforeEach(() => {
		resetSessionCreation();
		sessionState.currentId = null;
	});

	it("completes session creation when requestId matches", () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — tested idle->creating above
		const requestId = requestNewSession()!;
		expect(sessionCreation.value.phase).toBe("creating");

		handleSessionSwitched({
			type: "session_switched",
			id: "new-sess",
			sessionId: "new-sess",
			requestId,
		});

		expect(sessionState.currentId).toBe("new-sess");
		expect(sessionCreation.value.phase).toBe("idle");
	});

	it("leaves creation state alone when requestId is absent", () => {
		requestNewSession();
		expect(sessionCreation.value.phase).toBe("creating");

		handleSessionSwitched({
			type: "session_switched",
			id: "other-sess",
			sessionId: "other-sess",
		});

		expect(sessionState.currentId).toBe("other-sess");
		expect(sessionCreation.value.phase).toBe("creating"); // NOT completed
	});

	it("leaves creation state alone when requestId doesn't match", () => {
		requestNewSession();
		expect(sessionCreation.value.phase).toBe("creating");

		handleSessionSwitched({
			type: "session_switched",
			id: "other-sess",
			sessionId: "other-sess",
			requestId:
				"wrong-id" as import("../../../src/lib/shared-types.js").RequestId,
		});

		expect(sessionState.currentId).toBe("other-sess");
		expect(sessionCreation.value.phase).toBe("creating"); // NOT completed
	});

	it("is a no-op for creation state when not in creating phase", () => {
		// Not creating — requestId on msg should be harmless
		handleSessionSwitched({
			type: "session_switched",
			id: "sess-1",
			sessionId: "sess-1",
			requestId:
				"some-id" as import("../../../src/lib/shared-types.js").RequestId,
		});

		expect(sessionState.currentId).toBe("sess-1");
		expect(sessionCreation.value.phase).toBe("idle"); // Still idle
	});
});
