// ─── Session Store Tests ─────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionChatState,
	currentChat,
	getOrCreateSessionSlot,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	chooseModel,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	routerState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListSessionsResponse,
	applySessionSnapshot,
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
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { CreateSessionRpcInput } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import type {
	RelayMessage,
	SessionInfo,
} from "../../../src/lib/frontend/types.js";
import { createToolMessage } from "../../../src/lib/frontend/utils/tool-message-factory.js";

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
		status: "idle",
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
	clearSessionState();
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	clearDiscoveryState();
	routerState.path = "/p/project-a/s/old-session";
	syncSlugState(routerState.path);
});

describe("switchToSession", () => {
	it("views the session through RPC after changing local state", () => {
		const viewSession = vi.fn();
		sessionState.currentId = "old-session";
		routerState.path = "/p/project-a/s/new-session";
		syncSlugState(routerState.path);

		switchToSession("new-session", viewSession);

		expect(viewSession).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "new-session",
			originId: expect.any(String),
		});
	});

	it("keeps cached target session messages visible while loading fresh history", () => {
		const viewSession = vi.fn();
		const target = getOrCreateSessionSlot("parent-with-subagents");
		setMessages(target.messages, [
			createToolMessage({
				uuid: "tool-uuid",
				id: "task-tool-1",
				name: "Task",
				status: "completed",
				metadata: { childSessionId: "claude-subagent-abc" },
			}),
		]);
		sessionState.currentId = "child-subagent";
		routerState.path = "/p/project-a/s/parent-with-subagents";
		syncSlugState(routerState.path);

		switchToSession("parent-with-subagents", viewSession);

		const tool = currentChat().messages.find((m) => m.type === "tool");
		expect(tool?.type).toBe("tool");
		if (tool?.type !== "tool") throw new Error("expected tool message");
		expect(tool.metadata?.["childSessionId"]).toBe("claude-subagent-abc");
		expect(tool.status).toBe("completed");

		clearSessionChatState("parent-with-subagents");
		clearSessionChatState("child-subagent");
	});
});

// ─── groupSessionsByDate (pure function) ────────────────────────────────────

describe("groupSessionsByDate", () => {
	// Use a reference "now" at noon local time to avoid edge cases
	const now = new Date();
	now.setHours(12, 0, 0, 0);

	it("puts sessions updated today into the 'today' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: todayAt(now, 10).getTime() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(1);
		expect(groups.yesterday).toHaveLength(0);
		expect(groups.older).toHaveLength(0);
	});

	it("puts sessions from yesterday into the 'yesterday' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: yesterdayAt(now, 15).getTime() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(0);
		expect(groups.yesterday).toHaveLength(1);
		expect(groups.older).toHaveLength(0);
	});

	it("puts older sessions into the 'older' group", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", updatedAt: daysAgoAt(now, 5, 10).getTime() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(0);
		expect(groups.yesterday).toHaveLength(0);
		expect(groups.older).toHaveLength(1);
	});

	it("falls back to createdAt when updatedAt is missing", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "1", createdAt: todayAt(now, 8).getTime() }),
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
			makeSession({ id: "t", updatedAt: todayAt(now, 9).getTime() }),
			makeSession({ id: "y", updatedAt: yesterdayAt(now, 14).getTime() }),
			makeSession({ id: "o", updatedAt: daysAgoAt(now, 30, 10).getTime() }),
		];
		const groups = groupSessionsByDate(sessions, now);
		expect(groups.today).toHaveLength(1);
		expect(groups.yesterday).toHaveLength(1);
		expect(groups.older).toHaveLength(1);
	});
});

// ─── handleSessionList ──────────────────────────────────────────────────────

describe("handleSessionList", () => {
	it("holds the sessions a roots-only list carries", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: true });
		expect([...sessionState.sessions.keys()]).toEqual(["a", "b"]);
	});

	it("holds the sessions an all-sessions list carries", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: false });
		expect([...sessionState.sessions.keys()]).toEqual(["a", "b"]);
	});

	it("applies ListSessions RPC responses through the same session-list path", () => {
		const session = {
			id: "rpc-root",
			title: "RPC Root",
			status: "busy",
			updatedAt: 123,
		} as const;

		applyListSessionsResponse({
			projectSlug: "project-a",
			roots: true,
			sessions: [session],
		});

		// Server and browser share one session type (ni8.5 T-1), so what the RPC
		// decoded is what the store holds — nothing is copied field by field.
		expect(sessionState.sessions.get("rpc-root")).toEqual(session);
	});

	it("ignores non-array sessions payload", () => {
		applySessionSnapshot([makeSession({ id: "existing" })], "complete");
		handleSessionList(
			msg({ type: "session_list", sessions: "not-array", roots: true }),
		);
		expect(sessionState.sessions.size).toBe(1);
	});

	it("takes an untagged list as covering every session", () => {
		const root = makeSession({ id: "root1" });
		const child = makeSession({ id: "child1", parentID: "root1" });
		// Simulate an untagged message (no `roots` field) — e.g. from legacy sources
		handleSessionList(msg({ type: "session_list", sessions: [root, child] }));
		expect(sessionState.sessions.size).toBe(2);
		uiState.hideSubagentSessions = true;
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["root1"]);
	});

	it("shows a rename delivered by an all-sessions list in the roots view", () => {
		uiState.hideSubagentSessions = true;
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a", title: "Old" })],
			roots: true,
		});
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a", title: "New" })],
			roots: false,
		});
		expect(getFilteredSessions().map((s) => s.title)).toEqual(["New"]);
	});

	it("orders the sidebar by last change, newest first", () => {
		uiState.hideSubagentSessions = true;
		handleSessionList({
			type: "session_list",
			sessions: [
				makeSession({ id: "a", updatedAt: 1000 }),
				makeSession({ id: "b", updatedAt: 2000 }),
			],
			roots: false,
		});
		// `a` is used, so the server now reports it as the most recent.
		handleSessionList({
			type: "session_list",
			sessions: [
				makeSession({ id: "a", updatedAt: 3000 }),
				makeSession({ id: "b", updatedAt: 2000 }),
			],
			roots: false,
		});
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("drops a session an all-sessions list no longer carries", () => {
		applySessionSnapshot(
			[makeSession({ id: "a" }), makeSession({ id: "b" })],
			"complete",
		);
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a" })],
			roots: false,
		});
		expect([...sessionState.sessions.keys()]).toEqual(["a"]);
	});

	it("keeps a session a roots-only list omits", () => {
		applySessionSnapshot(
			[makeSession({ id: "a" }), makeSession({ id: "b" })],
			"complete",
		);
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a" })],
			roots: true,
		});
		expect([...sessionState.sessions.keys()]).toEqual(["a", "b"]);
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

	it("does not invent a session row for a session the server never listed", () => {
		handleSessionSwitched(
			msg({
				type: "session_switched",
				id: "child-session",
				sessionId: "child-session",
				parentID: "parent-session",
			}),
		);

		expect(sessionState.sessions.has("child-session")).toBe(false);
		expect(getFilteredSessions()).toEqual([]);
	});

	it("records the parent on a session the server has listed", () => {
		applySessionSnapshot(
			[makeSession({ id: "child-session", title: "Child" })],
			"complete",
		);
		handleSessionSwitched(
			msg({
				type: "session_switched",
				id: "child-session",
				sessionId: "child-session",
				parentID: "parent-session",
			}),
		);

		expect(sessionState.sessions.get("child-session")).toEqual({
			id: "child-session",
			title: "Child",
			status: "idle",
			parentID: "parent-session",
		});
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
		applySessionSnapshot(
			[
				{
					id: "ses_original",
					title: "Original",
					status: "idle",
					updatedAt: 1000,
				},
			],
			"complete",
		);

		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				status: "idle",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.sessions.size).toBe(2);
		expect(sessionState.sessions.get("ses_forked")?.parentID).toBe(
			"ses_original",
		);
	});

	it("replaces the row when the session is already known", () => {
		applySessionSnapshot(
			[
				{
					id: "ses_forked",
					title: "Already Here",
					status: "idle",
					updatedAt: 1000,
				},
			],
			"complete",
		);

		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "ses_forked",
				title: "Forked from Original",
				status: "idle",
				updatedAt: 2000,
				parentID: "ses_original",
			},
			parentId: "ses_original",
			parentTitle: "Original",
		});

		expect(sessionState.sessions.size).toBe(1);
		expect(sessionState.sessions.get("ses_forked")?.title).toBe(
			"Forked from Original",
		);
	});

	it("preserves forkMessageId on forked session", () => {
		handleSessionForked({
			type: "session_forked",
			sessionId: "s1",
			session: {
				id: "fork-1",
				title: "Forked",
				status: "idle",
				updatedAt: Date.now(),
				parentID: "parent-1",
				forkMessageId: "msg_42",
			},
			parentId: "parent-1",
			parentTitle: "Parent",
		});
		expect(sessionState.sessions.get("fork-1")?.forkMessageId).toBe("msg_42");
	});
});

// ─── getFilteredSessions — subagent toggle ──────────────────────────────────

describe("getFilteredSessions — hideSubagentSessions toggle", () => {
	beforeEach(() => {
		uiState.hideSubagentSessions = true; // reset to default
	});

	it("excludes subagent sessions when hideSubagentSessions is true", () => {
		applySessionSnapshot(
			[makeSession({ id: "a", title: "Parent", updatedAt: 1000 })],
			"complete",
		);
		uiState.hideSubagentSessions = true;
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a"]);
	});

	it("includes subagent sessions when hideSubagentSessions is false", () => {
		applySessionSnapshot(
			[
				makeSession({ id: "a", title: "Parent", updatedAt: 1000 }),
				makeSession({
					id: "b",
					title: "Child",
					parentID: "a",
					updatedAt: 2000,
				}),
			],
			"complete",
		);
		uiState.hideSubagentSessions = false;
		const ids = getFilteredSessions().map((s) => s.id);
		expect(ids).toContain("a");
		expect(ids).toContain("b");
	});

	it("still applies search filter when subagents are visible", () => {
		applySessionSnapshot(
			[
				makeSession({ id: "a", title: "Parent Session", updatedAt: 1000 }),
				makeSession({
					id: "b",
					title: "Child Session",
					parentID: "a",
					updatedAt: 2000,
				}),
			],
			"complete",
		);
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
	const mockStart = (data: CreateSessionRpcInput) =>
		sent.push(data as unknown as Record<string, unknown>);

	beforeEach(() => {
		sent = [];
		resetSessionCreation();
		discoveryState.selectedInstanceId = null;
	});

	it("sends CreateSession input with requestId and returns requestId", () => {
		const requestId = sendNewSession(mockStart);
		expect(requestId).not.toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			projectSlug: "project-a",
			requestId,
			originId: expect.any(String),
			instanceId: expect.any(String),
		});
	});

	it("binds the session to the harness derived from the active provider", () => {
		discoveryState.selectedInstanceId = null;
		chooseModel({ modelId: "claude-sonnet-4-5", providerId: "claude" });

		const requestId = sendNewSession(mockStart);

		expect(requestId).not.toBeNull();
		expect(sent).toEqual([
			{
				projectSlug: "project-a",
				requestId,
				originId: expect.any(String),
				instanceId: "claude",
			},
		]);
	});

	it("binds the session to the selected harness instance draft", () => {
		discoveryState.selectedInstanceId = "opencode";
		chooseModel({ modelId: "", providerId: "claude" });

		const requestId = sendNewSession(mockStart);

		expect(requestId).not.toBeNull();
		expect(sent).toEqual([
			{
				projectSlug: "project-a",
				requestId,
				originId: expect.any(String),
				instanceId: "opencode",
			},
		]);
	});

	it("transitions to creating phase", () => {
		sendNewSession(mockStart);
		expect(sessionCreation.value.phase).toBe("creating");
	});

	it("returns null and sends nothing when already creating", () => {
		sendNewSession(mockStart);
		sent = [];
		const result = sendNewSession(mockStart);
		expect(result).toBeNull();
		expect(sent).toHaveLength(0);
	});

	// ─── Component guard lifecycle (mirrors Sidebar/SessionList) ────────

	it("mirrors Sidebar button guard: disabled when creating, re-enabled after complete", () => {
		// First click — succeeds, button should be disabled
		// biome-ignore lint/style/noNonNullAssertion: safe — first call from idle
		const requestId = sendNewSession(mockStart)!;
		expect(sessionCreation.value.phase === "creating").toBe(true);

		// Second click while creating — guard blocks
		expect(sendNewSession(mockStart)).toBeNull();

		// Server responds — button should re-enable
		completeNewSession(requestId);
		expect(sessionCreation.value.phase === "creating").toBe(false);

		// Third click — succeeds again
		sent = [];
		expect(sendNewSession(mockStart)).not.toBeNull();
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
