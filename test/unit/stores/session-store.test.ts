import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSessionChatState,
	currentChat,
	getOrCreateSessionSlot,
	inputSyncState,
	sessionActivity,
	sessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyGetAgentsResponse,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { projectState } from "../../../src/lib/frontend/stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyFamilyChange,
	applyListDaemonSessionsResponse,
	clearSessionState,
	findSession,
	getFilteredSessions,
	groupSessionsByAttention,
	groupSessionsByDate,
	isSessionBusy,
	isSessionSnoozed,
	isSessionWoken,
	parentOf,
	sessionState,
	setCurrentSession,
	setSearchQuery,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { todoState } from "../../../src/lib/frontend/stores/todo.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import {
	applySessionChange,
	sessionSubscription,
} from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import * as sessionRpc from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";
import { createToolMessage } from "../../../src/lib/frontend/utils/tool-message-factory.js";
import {
	applySessionRemoved,
	applySessionSnapshot,
	applySessionUpsert,
	seedSearchResults,
	seedSessions,
} from "./session-fixtures.js";

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

beforeEach(() => {
	clearSessionState();
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	clearDiscoveryState();
	routerState.path = "/s/old-session";
	routerState.search = "";
	attachedProjectState.slug = "project-a";
});

it("seedSessions settles the versioned map and derives sidebar roots", () => {
	seedSessions([
		{ id: "root", title: "Root" },
		{ id: "child", title: "Child", parentID: "root" },
	]);

	expect([...sessionSubscription.rows.keys()]).toEqual(["root", "child"]);
	expect(sessionSubscription.settled).toBe(true);
	expect(sessionState.rootSessions.map((row) => row.id)).toEqual(["root"]);
	expect(sessionState.familySessions).toEqual([]);
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
	applyFamilyChange({
		_tag: "snapshot",
		sequence: 8,
		rows: [
			{ id: "root", title: "Old title", status: "idle" },
			{ id: "child", title: "Child", status: "idle", parentID: "root" },
		],
	});

	expect(sessionState.sessions.get("root")?.title).toBe("New title");
	expect(findSession("root")?.title).toBe("New title");
	expect(findSession("root")?.status).toBe("busy");
	expect(sessionState.sessions.has("child")).toBe(false);
	expect(sessionState.familySessions.map((row) => row.id)).toEqual([
		"root",
		"child",
	]);
});

it("keeps a newer family row when an older family upsert arrives", () => {
	applyFamilyChange({
		_tag: "snapshot",
		sequence: 10,
		rows: [
			{ id: "root", title: "Root", status: "idle" },
			{ id: "child", title: "New child", status: "busy", parentID: "root" },
		],
	});
	applyFamilyChange({ _tag: "synchronized" });
	applyFamilyChange({
		_tag: "upsert",
		sequence: 9,
		item: { id: "child", title: "Old child", status: "idle", parentID: "root" },
	});

	expect(findSession("child")?.title).toBe("New child");
	expect(isSessionBusy("child")).toBe(true);
});

it("a project switch forgets the family, and the next project's family applies", () => {
	applyFamilyChange({
		_tag: "snapshot",
		sequence: 10,
		rows: [
			{ id: "root", title: "Root", status: "idle" },
			{ id: "child", title: "Child", status: "idle", parentID: "root" },
		],
	});
	applyFamilyChange({ _tag: "synchronized" });

	clearSessionState();
	expect(sessionState.familySessions).toEqual([]);
	expect(parentOf("child")).toBeNull();

	// Another project's read model has its own versions, which can be lower.
	applyFamilyChange({
		_tag: "snapshot",
		sequence: 3,
		rows: [{ id: "other", title: "Other", status: "idle" }],
	});
	expect(sessionState.familySessions.map((row) => row.id)).toEqual(["other"]);
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

it("keeps the family list owned by the family feed", () => {
	const original = {
		id: "root",
		title: "Family title",
		status: "idle",
	} as const;
	applyFamilyChange({ _tag: "snapshot", sequence: 1, rows: [original] });
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

describe("switchToSession", () => {
	it("keeps the list query when the URL already names the session", () => {
		const pushState = vi.fn();
		vi.stubGlobal("window", { history: { pushState } });
		try {
			routerState.path = "/s/current";
			routerState.search = "?group=project";
			switchToSession(
				"current",
				"project-a",
				vi.fn().mockResolvedValue({ ok: true }),
			);
			expect(routerState.search).toBe("?group=project");
			expect(pushState).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

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
			switchToSession(
				"session-a",
				undefined,
				vi.fn().mockResolvedValue({ ok: true }),
			);
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
			const viewSession = vi.fn().mockResolvedValue({ ok: true });
			attachedProjectState.slug = "attached-project";
			routerState.path = "/";
			switchToSession("new-session", undefined, viewSession);
			expect(routerState.path).toBe("/s/new-session");
			expect(viewSession).toHaveBeenCalledWith({
				projectSlug: "attached-project",
				sessionId: "new-session",
				originId: expect.any(String),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("views a foreign row through its explicit project", () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		try {
			const viewSession = vi.fn().mockResolvedValue({ ok: true });
			switchToSession("foreign", "project-b", viewSession);
			expect(viewSession).toHaveBeenCalledWith({
				projectSlug: "project-b",
				sessionId: "foreign",
				originId: expect.any(String),
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("views the session through RPC after changing local state", () => {
		const viewSession = vi.fn().mockResolvedValue({ ok: true });
		sessionState.currentId = "old-session";
		routerState.path = "/s/new-session";
		attachedProjectState.slug = "project-a";

		switchToSession("new-session", "project-a", viewSession);

		expect(viewSession).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "new-session",
			originId: expect.any(String),
		});
	});

	it("keeps cached target session messages visible while loading fresh history", () => {
		const viewSession = vi.fn().mockResolvedValue({ ok: true });
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

	it("applies the returned draft and flushes a pending permission mode", async () => {
		vi.stubGlobal("window", { history: { pushState: vi.fn() } });
		const sendMode = vi
			.spyOn(sessionRpc, "switchPermissionModeRpc")
			.mockResolvedValue({ projectSlug: "project-a", mode: "acceptEdits" });
		try {
			discoveryState.pendingPermissionMode = "acceptEdits";
			switchToSession("draft-session", "project-a", () =>
				Promise.resolve({ ok: true, draft: "saved text" }),
			);
			await Promise.resolve();
			expect(inputSyncState.text).toBe("saved text");
			expect(discoveryState.pendingPermissionMode).toBeNull();
			expect(sendMode).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: "draft-session",
					projectSlug: "project-a",
					mode: "acceptEdits",
				}),
			);
		} finally {
			sendMode.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it("replaces a superseded session URL and resets session chrome", () => {
		const replaceState = vi.fn();
		vi.stubGlobal("window", { history: { replaceState, pushState: vi.fn() } });
		try {
			sessionState.currentId = "old-session";
			routerState.path = "/s/old-session";
			uiState.contextPercent = 70;
			todoState.items = [{ id: "one", subject: "old", status: "pending" }];
			switchToSession(
				"replacement",
				"project-a",
				() => Promise.resolve({ ok: true }),
				{ replace: true },
			);
			expect(sessionState.currentId).toBe("replacement");
			expect(routerState.path).toBe("/s/replacement");
			expect(replaceState).toHaveBeenCalledTimes(1);
			expect(uiState.contextPercent).toBe(0);
			expect(todoState.items).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// groupSessionsByDate (pure function)

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
		seedSessions([
			makeSession({ id: "local", title: "Warm title", updatedAt: 100 }),
		]);
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
		seedSessions([root]);
		applyFamilyChange({ _tag: "snapshot", sequence: 1, rows: [root, child] });
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

describe("getFilteredSessions root view", () => {
	it("shows roots while the family view contains descendants", () => {
		const root = makeSession({ id: "a", title: "Parent", updatedAt: 1000 });
		const child = makeSession({
			id: "b",
			title: "Child",
			parentID: "a",
			updatedAt: 2000,
		});
		seedSessions([root]);
		applyFamilyChange({ _tag: "snapshot", sequence: 1, rows: [root, child] });
		expect(getFilteredSessions().map((session) => session.id)).toEqual(["a"]);
		expect(sessionState.familySessions.map((session) => session.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("an omitted family member does not leave a row in the session map", () => {
		const root = makeSession({ id: "a" });
		const child = makeSession({ id: "b", parentID: "a" });
		applyFamilyChange({ _tag: "snapshot", sequence: 1, rows: [root, child] });
		applyFamilyChange({ _tag: "snapshot", sequence: 2, rows: [root] });
		expect(sessionState.familySessions.map((session) => session.id)).toEqual([
			"a",
		]);
		expect(sessionState.sessions.has("b")).toBe(false);
	});
});
