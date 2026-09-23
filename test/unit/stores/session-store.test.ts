// ─── Session Store Tests ─────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionChatState,
	currentChat,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { discoveryState } from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListDaemonSessionsResponse,
	applyListSessionsResponse,
	clearSessionState,
	completeNewSession,
	ERROR_DISPLAY_MS,
	failNewSession,
	findSession,
	getFilteredSessions,
	groupSessionsByAttention,
	handleSessionFamily,
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
import type { CreateSessionRpcInput } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import * as sessionRpc from "../../../src/lib/frontend/transport/ws-rpc-client.js";
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
		...overrides,
	};
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	attachedProjectState.slug = null;
	sessionState.sessions.clear();
	sessionState.rootSessions = [];
	sessionState.familySessions = [];
	sessionState.daemonSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.daemonHasMore = false;
	sessionState.daemonCursor = null;
	discoveryState.currentProviderId = "";
	discoveryState.currentModelId = "";
	discoveryState.defaultProviderId = "";
	discoveryState.defaultModelId = "";
	routerState.path = "/p/project-a/s/old-session";
});

describe("clearSessionState", () => {
	it("clears evicted activity, replay generations and timers on project reset", () => {
		vi.useFakeTimers();
		try {
			for (const id of new Set([
				...sessionActivity.keys(),
				...sessionMessages.keys(),
			]))
				clearSessionChatState(id);
			const evicted = getOrCreateSessionSlot("evicted");
			evicted.activity.replayGeneration = 7;
			const render = vi.fn();
			evicted.activity.renderTimer = setTimeout(() => render(), 100);
			for (let i = 0; i < 21; i++) getOrCreateSessionSlot(`visited-${i}`);
			const activityOnly = getOrCreateSessionActivity("activity-only");
			activityOnly.renderTimer = setTimeout(() => render(), 100);
			getOrCreateSessionMessages("messages-only");
			expect(sessionMessages.has("evicted")).toBe(false);
			expect(sessionActivity.has("evicted")).toBe(true);

			clearSessionState();

			expect(sessionActivity.size).toBe(0);
			expect(sessionMessages.size).toBe(0);
			expect(evicted.activity.replayGeneration).toBe(8);
			expect(activityOnly.replayGeneration).toBe(1);
			vi.advanceTimersByTime(100);
			expect(render).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("switchToSession", () => {
	it("builds the session route and RPC from the attached project", () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		const viewSession = vi.fn();
		attachedProjectState.slug = "attached-project";
		routerState.path = "/p/pending-project/";
		switchToSession("new-session", viewSession);
		expect(routerState.path).toBe("/p/attached-project/s/new-session");
		expect(viewSession).toHaveBeenCalledWith({
			projectSlug: "attached-project",
			sessionId: "new-session",
			originId: expect.any(String),
		});
		vi.unstubAllGlobals();
	});
	it("ignores session discovery returned after attaching another project", async () => {
		let finish: (
			response: Awaited<ReturnType<typeof sessionRpc.getAgentsRpc>>,
		) => void = () => {};
		const spy = vi.spyOn(sessionRpc, "getAgentsRpc").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		attachedProjectState.slug = "project-a";
		routerState.path = "/p/project-a/s/session-a";
		switchToSession("session-a", vi.fn());
		attachedProjectState.slug = "project-b";
		clearSessionState();
		discoveryState.activeAgentId = "agent-b";
		finish({
			projectSlug: "project-a",
			providerScope: { id: "a", name: "A" },
			agents: [],
			activeAgentId: "agent-a",
		});
		await Promise.resolve();
		expect(discoveryState.activeAgentId).toBe("agent-b");
		spy.mockRestore();
	});

	it("views the session through RPC after changing local state", () => {
		const viewSession = vi.fn();
		sessionState.currentId = "old-session";
		routerState.path = "/p/project-a/s/new-session";

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

// ─── groupSessionsByAttention (pure function) ───────────────────────────────

describe("groupSessionsByAttention", () => {
	it("files each tier under its section", () => {
		const groups = groupSessionsByAttention([
			makeSession({ id: "approve", attention: "needs-approval" }),
			makeSession({ id: "reply", attention: "needs-reply" }),
			makeSession({ id: "failed", attention: "error" }),
			makeSession({ id: "busy", attention: "working" }),
			makeSession({ id: "unread", attention: "done-unread" }),
			makeSession({ id: "quiet", attention: "idle" }),
		]);

		expect(groups.needsYou.map((s) => s.id)).toEqual([
			"approve",
			"reply",
			"failed",
		]);
		expect(groups.running.map((s) => s.id)).toEqual(["busy"]);
		expect(groups.doneUnread.map((s) => s.id)).toEqual(["unread"]);
		expect(groups.idle.map((s) => s.id)).toEqual(["quiet"]);
	});

	it("orders 'Needs you' by tier, approvals first", () => {
		const groups = groupSessionsByAttention([
			makeSession({ id: "failed", attention: "error" }),
			makeSession({ id: "reply", attention: "needs-reply" }),
			makeSession({ id: "approve", attention: "needs-approval" }),
		]);

		expect(groups.needsYou.map((s) => s.id)).toEqual([
			"approve",
			"reply",
			"failed",
		]);
	});

	// The list arrives sorted by recency and the tier sort must not disturb that
	// within a tier, or the newest thing needing you could sink below the oldest.
	it("keeps the incoming order between two sessions of the same tier", () => {
		const groups = groupSessionsByAttention([
			makeSession({ id: "newer", attention: "needs-reply" }),
			makeSession({ id: "older", attention: "needs-reply" }),
		]);

		expect(groups.needsYou.map((s) => s.id)).toEqual(["newer", "older"]);
	});

	it("treats a session with no attention field as idle", () => {
		const groups = groupSessionsByAttention([makeSession({ id: "legacy" })]);

		expect(groups.idle.map((s) => s.id)).toEqual(["legacy"]);
		expect(groups.needsYou).toHaveLength(0);
	});

	it("handles empty array", () => {
		const groups = groupSessionsByAttention([]);

		expect(groups.needsYou).toHaveLength(0);
		expect(groups.running).toHaveLength(0);
		expect(groups.doneUnread).toHaveLength(0);
		expect(groups.idle).toHaveLength(0);
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

	it("ignores obsolete all-session lists", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: false });
		expect(sessionState.familySessions).toEqual([]);
	});

	it("applies ListSessions RPC responses through the same session-list path", () => {
		applyListSessionsResponse({
			projectSlug: "project-a",
			roots: true,
			sessions: [
				{
					id: "rpc-root",
					title: "RPC Root",
					updatedAt: 123,
					pendingQuestionCount: 2,
					pendingPermissionCount: 1,
					attention: "needs-approval",
				},
			],
		});

		expect(sessionState.rootSessions).toEqual([
			{
				id: "rpc-root",
				title: "RPC Root",
				updatedAt: 123,
				pendingQuestionCount: 2,
				pendingPermissionCount: 1,
				attention: "needs-approval",
			},
		]);
		expect(sessionState.sessions.get("rpc-root")?.title).toBe("RPC Root");
	});

	it("ignores non-array sessions payload", () => {
		sessionState.rootSessions = [makeSession({ id: "existing" })];
		handleSessionList(
			msg({ type: "session_list", sessions: "not-array", roots: true }),
		);
		expect(sessionState.rootSessions).toHaveLength(1);
	});

	it("untagged session_list only populates roots", () => {
		const root = makeSession({ id: "root1" });
		const child = makeSession({ id: "child1", parentID: "root1" });
		// Simulate an untagged message (no `roots` field) — e.g. from legacy sources
		handleSessionList(msg({ type: "session_list", sessions: [root, child] }));
		// rootSessions should contain only non-subagent sessions
		expect(sessionState.rootSessions).toHaveLength(1);
		expect(sessionState.rootSessions[0]?.id).toBe("root1");
		// Family membership only comes from session_family.
		expect(sessionState.familySessions).toEqual([]);
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

	it("records selected subagent metadata without changing the family", () => {
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
			title: "",
			parentID: "parent-session",
		});
		expect(findSession("child-session")?.parentID).toBe("parent-session");
	});

	it("does not add a parent-less switched session to familySessions", () => {
		handleSessionSwitched({
			type: "session_switched",
			id: "root-session",
			sessionId: "root-session",
		});

		expect(sessionState.familySessions).toEqual([]);
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
	it("does not insert a fork outside the supplied family", () => {
		sessionState.familySessions = [
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

		expect(sessionState.familySessions).toHaveLength(1);
	});

	it("does not duplicate if session already exists", () => {
		sessionState.familySessions = [
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

		expect(sessionState.familySessions).toHaveLength(1);
	});

	it("preserves forkMessageId on the selected fork", () => {
		sessionState.currentId = "fork-1";
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
		const found = findSession("fork-1");
		expect(found?.forkMessageId).toBe("msg_42");
	});
});

// ─── getFilteredSessions — subagent toggle ──────────────────────────────────

describe("roots-only sidebar", () => {
	it("never shows family children, including search results", () => {
		const root = makeSession({ id: "root", title: "Parent" });
		const child = makeSession({
			id: "child",
			title: "Child",
			parentID: "root",
		});
		handleSessionList({ type: "session_list", roots: true, sessions: [root] });
		handleSessionFamily({
			type: "session_family",
			rootId: "root",
			sessions: [root, child],
		});
		expect(getFilteredSessions()).toEqual([root]);
		sessionState.searchResults = [root, child, makeSession({ id: "deleted" })];
		expect(getFilteredSessions()).toEqual([root]);
	});
});

describe("getFilteredSessions — daemon sessions", () => {
	beforeEach(() => {
		sessionState.daemonSessions = [];
		sessionState.searchResults = null;
		sessionState.searchQuery = "";
		sessionState.sessions.clear();
		routerState.path = "/p/project-a/";
	});

	it("includes foreign project sessions", () => {
		sessionState.rootSessions = [makeSession({ id: "local" })];
		sessionState.daemonSessions = [
			makeSession({ id: "foreign", projectSlug: "project-b" }),
			makeSession({ id: "missing-slug" }),
		];

		expect(getFilteredSessions().map((session) => session.id)).toEqual([
			"local",
			"foreign",
		]);
	});

	it("does not duplicate the warm local row from the daemon response", () => {
		sessionState.rootSessions = [
			makeSession({ id: "local", title: "Warm title" }),
		];
		sessionState.daemonSessions = [
			makeSession({
				id: "local",
				title: "Cold title",
				projectSlug: "project-a",
			}),
		];

		expect(getFilteredSessions()).toEqual([
			expect.objectContaining({ id: "local", title: "Warm title" }),
		]);
	});

	it("orders local and foreign sessions by updatedAt then createdAt", () => {
		sessionState.rootSessions = [
			makeSession({ id: "local-old", updatedAt: 100 }),
			makeSession({ id: "local-created", createdAt: 300 }),
		];
		sessionState.daemonSessions = [
			makeSession({
				id: "foreign-new",
				projectSlug: "project-b",
				updatedAt: 400,
			}),
			makeSession({ id: "foreign-undated", projectSlug: "project-b" }),
		];

		expect(getFilteredSessions().map((session) => session.id)).toEqual([
			"foreign-new",
			"local-created",
			"local-old",
			"foreign-undated",
		]);
	});

	it("filters foreign child sessions when subagents are hidden", () => {
		sessionState.daemonSessions = [
			makeSession({ id: "foreign-root", projectSlug: "project-b" }),
			makeSession({
				id: "foreign-child",
				projectSlug: "project-b",
				parentID: "foreign-root",
			}),
		];

		expect(getFilteredSessions().map((session) => session.id)).toEqual([
			"foreign-root",
		]);
	});

	it("returns only reconciled server results during an active search", () => {
		const result = makeSession({ id: "search-result", title: "Match" });
		sessionState.searchQuery = "match";
		sessionState.searchResults = [result];
		sessionState.rootSessions = [result];
		sessionState.daemonSessions = [
			makeSession({
				id: "foreign-match",
				title: "Match abroad",
				projectSlug: "project-b",
			}),
		];

		expect(getFilteredSessions().map((session) => session.id)).toEqual([
			"search-result",
		]);
	});

	it("renders an applied daemon response without matching project metadata", () => {
		projectState.projects = [];
		applyListDaemonSessionsResponse({
			projectSlug: "project-a",
			sessions: [
				{
					id: "foreign",
					title: "Foreign session",
					projectSlug: "unknown-project",
				},
			],
			availability: [{ projectSlug: "unknown-project", available: true }],
			hasMore: false,
			nextCursor: null,
		});

		expect(getFilteredSessions().map((session) => session.id)).toContain(
			"foreign",
		);
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
		discoveryState.currentProviderId = "claude";
		discoveryState.currentModelId = "claude-sonnet-4-5";

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
		discoveryState.currentProviderId = "claude";

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
