// ─── Session Store Tests ─────────────────────────────────────────────────────
// Direct legacy handler behavior checks are kept deliberately for R4/R6 deletion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionChatState,
	currentChat,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	getOrCreateSessionSlot,
	handleDelta,
	sessionActivity,
	sessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyGetAgentsResponse,
	chooseModel,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListDaemonSessionsResponse,
	applyListSessionsResponse,
	applySessionRemoved,
	applySessionSnapshot,
	applySessionUpsert,
	clearSessionState,
	completeNewSession,
	ERROR_DISPLAY_MS,
	failNewSession,
	getFilteredSessions,
	groupSessionsByAttention,
	groupSessionsByDate,
	handleSessionFamily,
	handleSessionList,
	handleSessionSwitched,
	isSessionSnoozed,
	isSessionWoken,
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
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import {
	applySessionChange,
	sessionSubscription,
} from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import type { CreateSessionRpcInput } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import * as sessionRpc from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import type {
	RelayMessage,
	SessionInfo,
} from "../../../src/lib/frontend/types.js";
import { createToolMessage } from "../../../src/lib/frontend/utils/tool-message-factory.js";
import { seedSearchResults, seedSessions } from "./session-fixtures.js";

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
	routerState.path = "/s/old-session";
	attachedProjectState.slug = "project-a";
});

it("seedSessions settles the versioned map and fills both sidebar lists", () => {
	seedSessions([
		{ id: "root", title: "Root" },
		{ id: "child", title: "Child", parentID: "root" },
	]);

	expect([...sessionSubscription.rows.keys()]).toEqual(["root", "child"]);
	expect(sessionSubscription.settled).toBe(true);
	expect(sessionState.rootSessions.map((row) => row.id)).toEqual(["root"]);
	expect(sessionState.familySessions.map((row) => row.id)).toEqual([
		"root",
		"child",
	]);
	applySessionChange({
		_tag: "upsert",
		sequence: 0,
		item: { id: "stale", title: "Stale", status: "idle" },
	});
	expect(sessionSubscription.rows.has("stale")).toBe(false);
});

it("keeps a newer root row when an older family arrives", () => {
	applySessionChange({
		_tag: "snapshot",
		sequence: 10,
		rows: [{ id: "root", title: "New title", status: "busy" }],
	});
	handleSessionFamily({
		type: "session_family",
		rootId: "root",
		sessions: [
			{ id: "root", title: "Old title", status: "idle" },
			{ id: "child", title: "Child", status: "idle", parentID: "root" },
		],
	});

	expect(sessionState.sessions.get("root")?.title).toBe("New title");
	expect(sessionState.sessions.get("root")?.status).toBe("busy");
	expect(sessionState.sessions.has("child")).toBe(false);
	expect(sessionState.familySessions.map((row) => row.id)).toEqual([
		"root",
		"child",
	]);
});

it("forgets chat and selection when the subscription snapshot omits a session", () => {
	applySessionChange({
		_tag: "snapshot",
		sequence: 10,
		rows: [{ id: "gone", title: "Gone", status: "idle" }],
	});
	getOrCreateSessionSlot("gone");
	sessionState.currentId = "gone";

	applySessionChange({ _tag: "snapshot", sequence: 11, rows: [] });

	expect(sessionState.sessions.has("gone")).toBe(false);
	expect(sessionActivity.has("gone")).toBe(false);
	expect(sessionMessages.has("gone")).toBe(false);
	expect(sessionState.currentId).toBeNull();
});

it("forgets chat and selection when the subscription removes a session", () => {
	applySessionChange({
		_tag: "upsert",
		sequence: 10,
		item: { id: "gone", title: "Gone", status: "idle" },
	});
	getOrCreateSessionSlot("gone");
	sessionState.currentId = "gone";

	applySessionChange({ _tag: "remove", sequence: 11, id: "gone" });

	expect(sessionState.sessions.has("gone")).toBe(false);
	expect(sessionActivity.has("gone")).toBe(false);
	expect(sessionMessages.has("gone")).toBe(false);
	expect(sessionState.currentId).toBeNull();
});

it("does not write a row from a fork notice", () => {
	applySessionChange({
		_tag: "snapshot",
		sequence: 10,
		rows: [{ id: "ses_original", title: "Original", status: "idle" }],
	});
	handleMessage({
		type: "session_forked",
		sessionId: "ses_original",
		session: {
			id: "fork",
			title: "Forked",
			status: "idle",
			parentID: "ses_original",
		},
		parentId: "ses_original",
		parentTitle: "Original",
	});

	expect(sessionState.sessions.has("fork")).toBe(false);
	expect(sessionState.sessions.get("ses_original")?.title).toBe("Original");
});

it("keeps the family list owned by session_family messages", () => {
	const original = {
		id: "root",
		title: "Family title",
		status: "idle",
	} as const;
	handleSessionFamily({
		type: "session_family",
		rootId: "root",
		sessions: [original],
	});
	applySessionSnapshot(
		[{ id: "root", title: "Snapshot title", status: "idle" }],
		"complete",
	);
	expect(sessionState.familySessions).toEqual([original]);
	applySessionUpsert({ id: "root", title: "Upsert title", status: "idle" });
	expect(sessionState.familySessions).toEqual([original]);
	applySessionRemoved("root");
	expect(sessionState.familySessions).toEqual([original]);
});

describe("clearSessionState", () => {
	it("clears evicted activity, replay generations and timers on project reset", () => {
		vi.useFakeTimers();
		try {
			const evicted = getOrCreateSessionSlot("evicted");
			evicted.activity.replayGeneration = 7;
			handleDelta(evicted.activity, evicted.messages, {
				type: "delta",
				sessionId: "evicted",
				text: "pending",
			});
			for (let index = 0; index < 21; index += 1)
				getOrCreateSessionSlot(`visited-${index}`);
			const activityOnly = getOrCreateSessionActivity("activity-only");
			handleDelta(activityOnly, getOrCreateSessionMessages("activity-only"), {
				type: "delta",
				sessionId: "activity-only",
				text: "pending",
			});
			getOrCreateSessionMessages("messages-only");
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
			expect(sessionMessages.has("evicted")).toBe(false);
			expect(sessionActivity.has("evicted")).toBe(true);
			clearSessionState();
			expect(sessionActivity.size).toBe(0);
			expect(sessionMessages.size).toBe(0);
			expect(evicted.activity.replayGeneration).toBe(8);
			expect(activityOnly.replayGeneration).toBe(1);
			expect(clearTimeoutSpy).toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(100);
			expect(vi.getTimerCount()).toBe(0);
			clearTimeoutSpy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("switchToSession", () => {
	it("ignores session discovery returned after attaching another project", async () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		let finish: (
			response: Awaited<ReturnType<typeof sessionRpc.getAgentsRpc>>,
		) => void = () => {};
		const spy = vi.spyOn(sessionRpc, "getAgentsRpc").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		try {
			attachedProjectState.slug = "project-a";
			switchToSession("session-a", undefined, vi.fn());
			attachedProjectState.slug = "project-b";
			clearSessionState();
			applyGetAgentsResponse({
				projectSlug: "project-b",
				providerScope: { id: "b", name: "B" },
				agents: [],
				activeAgentId: "agent-b",
			});
			finish({
				projectSlug: "project-a",
				providerScope: { id: "a", name: "A" },
				agents: [],
				activeAgentId: "agent-a",
			});
			await Promise.resolve();
			expect(discoveryState.activeAgentId).toBe("agent-b");
		} finally {
			spy.mockRestore();
			vi.unstubAllGlobals();
		}
	});
	it("builds the session route and RPC from the attached project", () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		try {
			const viewSession = vi.fn();
			attachedProjectState.slug = "attached-project";
			routerState.path = "/";
			switchToSession("new-session", undefined, viewSession);
			expect(routerState.path).toBe("/s/new-session");
			expect(viewSession).toHaveBeenCalledWith({
				projectSlug: "attached-project",
				sessionId: "new-session",
				originId: expect.any(String),
				requestId: expect.any(String),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("views a foreign row through its explicit project", () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		try {
			const viewSession = vi.fn();
			switchToSession("foreign", "project-b", viewSession);
			expect(viewSession).toHaveBeenCalledWith({
				projectSlug: "project-b",
				sessionId: "foreign",
				originId: expect.any(String),
				requestId: expect.any(String),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("views the session through RPC after changing local state", () => {
		const viewSession = vi.fn();
		sessionState.currentId = "old-session";
		routerState.path = "/s/new-session";
		attachedProjectState.slug = "project-a";

		switchToSession("new-session", "project-a", viewSession);

		expect(viewSession).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "new-session",
			originId: expect.any(String),
			requestId: expect.any(String),
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
		routerState.path = "/s/parent-with-subagents";
		attachedProjectState.slug = "project-a";

		switchToSession("parent-with-subagents", "project-a", viewSession);

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

describe("attention placement and daemon rows", () => {
	it("files each tier under its section and orders approvals before replies", () => {
		const groups = groupSessionsByAttention([
			makeSession({ id: "failed", attention: "error" }),
			makeSession({ id: "reply", attention: "needs-reply" }),
			makeSession({ id: "approve", attention: "needs-approval" }),
			makeSession({ id: "busy", attention: "working" }),
			makeSession({ id: "unread", attention: "done-unread" }),
			makeSession({ id: "quiet", attention: "idle" }),
			makeSession({ id: "legacy" }),
		]);
		expect(groups.needsYou.map((row) => row.id)).toEqual([
			"approve",
			"reply",
			"failed",
		]);
		expect(groups.running.map((row) => row.id)).toEqual(["busy"]);
		expect(groups.doneUnread.map((row) => row.id)).toEqual(["unread"]);
		expect(groups.idle.map((row) => row.id)).toEqual(["quiet", "legacy"]);
	});

	it("keeps incoming order within a tier and shelves pinned, settled, and snoozed rows", () => {
		const groups = groupSessionsByAttention(
			[
				makeSession({ id: "newer", attention: "needs-reply" }),
				makeSession({ id: "older", attention: "needs-reply" }),
				makeSession({ id: "pin", pinnedAt: 10, attention: "needs-approval" }),
				makeSession({ id: "settled", settledAt: 20, attention: "error" }),
				makeSession({ id: "later", snoozedAt: 1, snoozedUntil: 3000 }),
				makeSession({ id: "soon", snoozedAt: 1, snoozedUntil: 2000 }),
				makeSession({ id: "indefinite", snoozedAt: 1 }),
			],
			1000,
		);
		expect(groups.needsYou.map((row) => row.id)).toEqual(["newer", "older"]);
		expect(groups.pinned.map((row) => row.id)).toEqual(["pin"]);
		expect(groups.settled.map((row) => row.id)).toEqual(["settled"]);
		expect(groups.snoozed.map((row) => row.id)).toEqual([
			"soon",
			"later",
			"indefinite",
		]);
	});

	it("keeps an indefinite snooze asleep and wakes a timed snooze at its deadline", () => {
		const indefinite = makeSession({ id: "indefinite", snoozedAt: 1 });
		const timed = makeSession({ id: "timed", snoozedAt: 1, snoozedUntil: 100 });
		expect(isSessionSnoozed(indefinite, 1000)).toBe(true);
		expect(isSessionWoken(indefinite, 1000)).toBe(false);
		expect(isSessionSnoozed(timed, 99)).toBe(true);
		expect(isSessionSnoozed(timed, 100)).toBe(false);
		expect(isSessionWoken(timed, 100)).toBe(true);
	});

	it("combines local roots with foreign daemon roots without duplicating local rows", () => {
		projectState.projects = [];
		handleSessionList({
			type: "session_list",
			roots: true,
			sessions: [
				makeSession({ id: "local", title: "Warm title", updatedAt: 100 }),
			],
		});
		applyListDaemonSessionsResponse({
			projectSlug: "project-a",
			sessions: [
				makeSession({
					id: "local",
					title: "Cold title",
					projectSlug: "project-a",
				}),
				makeSession({
					id: "foreign",
					projectSlug: "project-b",
					updatedAt: 400,
				}),
				makeSession({
					id: "foreign-created",
					projectSlug: "project-b",
					createdAt: 300,
				}),
				makeSession({
					id: "foreign-child",
					parentID: "foreign",
					projectSlug: "project-b",
					updatedAt: 500,
				}),
			],
			availability: [{ projectSlug: "project-b", available: true }],
			hasMore: false,
			nextCursor: null,
		});
		expect(getFilteredSessions().map((row) => row.id)).toEqual([
			"foreign",
			"foreign-created",
			"local",
		]);
		expect(getFilteredSessions().find((row) => row.id === "local")?.title).toBe(
			"Warm title",
		);
	});

	it("returns only reconciled root search results, never family children", () => {
		const root = makeSession({ id: "root", title: "Match" });
		const child = makeSession({
			id: "child",
			title: "Match child",
			parentID: "root",
		});
		handleSessionList({ type: "session_list", roots: true, sessions: [root] });
		handleSessionFamily({
			type: "session_family",
			rootId: "root",
			sessions: [root, child],
		});
		applyListDaemonSessionsResponse({
			projectSlug: "project-a",
			sessions: [
				makeSession({
					id: "foreign-match",
					title: "Match abroad",
					projectSlug: "project-b",
				}),
			],
			availability: [{ projectSlug: "project-b", available: true }],
			hasMore: false,
			nextCursor: null,
		});
		sessionState.searchQuery = "match";
		seedSearchResults([root, child]);
		expect(getFilteredSessions().map((row) => row.id)).toEqual(["root"]);
	});
});

// ─── handleSessionList ──────────────────────────────────────────────────────

describe("handleSessionList", () => {
	it("keeps git context through ListSessions RPC responses", () => {
		applyListSessionsResponse({
			projectSlug: "project-a",
			roots: true,
			sessions: [
				makeSession({
					id: "git",
					git: { branch: "feature", head: "abc1234", merged: false },
				}),
			],
		});
		expect(sessionState.rootSessions[0]?.git).toEqual({
			branch: "feature",
			head: "abc1234",
			merged: false,
		});
	});

	it("keeps pin, settle, snooze and wake fields through ListSessions RPC responses", () => {
		applyListSessionsResponse({
			projectSlug: "project-a",
			roots: true,
			sessions: [
				makeSession({ id: "pinned", pinnedAt: 10 }),
				makeSession({ id: "settled", settledAt: 20 }),
				makeSession({ id: "snoozed", snoozedAt: 30, snoozedUntil: 40 }),
				makeSession({ id: "woken", wokenAt: 50, wokeBecause: "approval" }),
			],
		});
		expect(sessionState.rootSessions).toEqual([
			makeSession({ id: "pinned", pinnedAt: 10 }),
			makeSession({ id: "settled", settledAt: 20 }),
			makeSession({ id: "snoozed", snoozedAt: 30, snoozedUntil: 40 }),
			makeSession({ id: "woken", wokenAt: 50, wokeBecause: "approval" }),
		]);
	});
	it("holds the sessions a roots-only list carries", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: true });
		expect([...sessionState.sessions.keys()]).toEqual(["a", "b"]);
	});

	it("ignores the deferred all-session list", () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
		handleSessionList({ type: "session_list", sessions, roots: false });
		expect([...sessionState.sessions.keys()]).toEqual([]);
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

	it("ignores an untagged list that has no declared scope", () => {
		const root = makeSession({ id: "root1" });
		const child = makeSession({ id: "child1", parentID: "root1" });
		// Simulate an untagged message (no `roots` field) — e.g. from legacy sources
		handleSessionList(msg({ type: "session_list", sessions: [root, child] }));
		expect(sessionState.sessions.size).toBe(0);
		expect(getFilteredSessions()).toEqual([]);
	});

	it("shows a rename delivered by the root view", () => {
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a", title: "Old" })],
			roots: true,
		});
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a", title: "New" })],
			roots: true,
		});
		expect(getFilteredSessions().map((s) => s.title)).toEqual(["New"]);
	});

	it("orders the sidebar by last change, newest first", () => {
		handleSessionList({
			type: "session_list",
			sessions: [
				makeSession({ id: "a", updatedAt: 1000 }),
				makeSession({ id: "b", updatedAt: 2000 }),
			],
			roots: true,
		});
		// `a` is used, so the server now reports it as the most recent.
		handleSessionList({
			type: "session_list",
			sessions: [
				makeSession({ id: "a", updatedAt: 3000 }),
				makeSession({ id: "b", updatedAt: 2000 }),
			],
			roots: true,
		});
		expect(getFilteredSessions().map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("keeps a session omitted from a different list scope", () => {
		applySessionSnapshot(
			[makeSession({ id: "a" }), makeSession({ id: "b" })],
			"complete",
		);
		handleSessionList({
			type: "session_list",
			sessions: [makeSession({ id: "a" })],
			roots: false,
		});
		expect([...sessionState.sessions.keys()]).toEqual(["a", "b"]);
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
		expect(sessionState.familySessions).toEqual([]);
		expect(getFilteredSessions()).toEqual([]);
		expect(sessionState.currentParentId).toBe("parent-session");
	});

	it("uses announced lineage only for the current unlisted session, then yields to a row", () => {
		handleSessionSwitched(
			msg({ type: "session_switched", id: "child", parentID: "first-parent" }),
		);
		expect(sessionState.currentParentId).toBe("first-parent");
		applySessionSnapshot(
			[makeSession({ id: "child", parentID: "row-parent" })],
			"complete",
		);
		expect(sessionState.currentParentId).toBe("row-parent");
		handleSessionSwitched(msg({ type: "session_switched", id: "other" }));
		expect(sessionState.currentParentId).toBeNull();
	});

	it("uses the announced parent without rewriting a listed row", () => {
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
		});
		expect(sessionState.currentParentId).toBe("parent-session");
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

// ─── Root subscription view ──────────────────────────────────────────────────

describe("getFilteredSessions root view", () => {
	it("shows roots while the family view contains descendants", () => {
		const root = makeSession({ id: "a", title: "Parent", updatedAt: 1000 });
		const child = makeSession({
			id: "b",
			title: "Child",
			parentID: "a",
			updatedAt: 2000,
		});
		handleSessionList({ type: "session_list", roots: true, sessions: [root] });
		handleSessionFamily({
			type: "session_family",
			rootId: "a",
			sessions: [root, child],
		});
		expect(getFilteredSessions().map((session) => session.id)).toEqual(["a"]);
		expect(sessionState.familySessions.map((session) => session.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("an omitted family member does not leave a row in the session map", () => {
		const root = makeSession({ id: "a" });
		const child = makeSession({ id: "b", parentID: "a" });
		handleSessionFamily({
			type: "session_family",
			rootId: "a",
			sessions: [root, child],
		});
		handleSessionFamily({
			type: "session_family",
			rootId: "a",
			sessions: [root],
		});
		expect(sessionState.familySessions.map((session) => session.id)).toEqual([
			"a",
		]);
		expect(sessionState.sessions.has("b")).toBe(false);
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
