// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionMessages } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	isSessionBusy,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	connect,
	disconnect,
} from "../../../src/lib/frontend/stores/ws.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import { applySessionChange, seedFamilySessions } from "./session-fixtures.js";

beforeEach(() => clearSessionState());
afterEach(() => {
	clearSessionState();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("routes family-only child activity and propagates busy to its parent", () => {
	seedFamilySessions([
		{ id: "root", title: "Root", status: "idle" },
		{ id: "child", title: "Child", status: "idle", parentID: "root" },
	]);
	sessionState.currentId = "root";
	handleMessage({ type: "delta", sessionId: "child", text: "working" });

	expect(sessionMessages.has("child")).toBe(true);
	expect(isSessionBusy("child")).toBe(true);
	expect(isSessionBusy("root")).toBe(true);
	sessionState.currentId = "child";
	expect(sessionState.currentParentId).toBe("root");
});

it("rolls a Side Thread's subagents into it without making its parent busy", () => {
	seedFamilySessions([
		{ id: "root", title: "Root", status: "idle" },
		{
			id: "side",
			title: "Side Thread",
			status: "idle",
			parentID: "root",
			sideThread: true,
		},
		{ id: "agent", title: "Agent", status: "idle", parentID: "side" },
	]);
	sessionState.currentId = "side";
	handleMessage({ type: "delta", sessionId: "agent", text: "working" });
	expect(isSessionBusy("agent")).toBe(true);
	expect(isSessionBusy("side")).toBe(true);
	expect(isSessionBusy("root")).toBe(false);
	expect(sessionState.currentParentId).toBe("root");
	applySessionChange({
		_tag: "upsert",
		item: { id: "root", title: "Root", status: "busy" },
	});
	expect(isSessionBusy("root")).toBe(true);
});

it.each([
	1_000_000, -1_000_000,
])("orders activity and idle rows by arrival with server clock offset %i", (offset) => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
	sessionState.currentId = "s";
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{ id: "s", title: "s", status: "idle", updatedAt: 100_000 + offset },
		],
	});
	handleMessage({ type: "delta", sessionId: "s", text: "working" });
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "idle", updatedAt: 100_001 + offset },
	});
	expect(isSessionBusy("s")).toBe(false);
});

it("drops late activity after snapshot omission and accepts it after reappearance", () => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	applySessionChange({
		_tag: "snapshot",
		rows: [{ id: "s", title: "s", status: "idle" }],
	});
	handleMessage({ type: "delta", sessionId: "s", text: "working" });
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({ _tag: "snapshot", rows: [] });
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "still working" });
	expect(isSessionBusy("s")).toBe(false);
	applySessionChange({
		_tag: "snapshot",
		rows: [{ id: "s", title: "s", status: "idle" }],
	});
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "next turn" });
	expect(isSessionBusy("s")).toBe(true);
});

it("retires snapshot-omitted activity even before the session has its first row", () => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	handleMessage({ type: "delta", sessionId: "s", text: "working" });
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({ _tag: "snapshot", rows: [] });
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "next observation" });
	expect(isSessionBusy("s")).toBe(true);
});

it.each([
	"snapshot",
	"upsert",
] as const)("clears an explicit removal tombstone when the id reappears via %s", (tag) => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	applySessionChange({ _tag: "remove", id: "s" });
	handleMessage({ type: "delta", sessionId: "s", text: "late" });
	expect(isSessionBusy("s")).toBe(false);
	applySessionChange({ _tag: "snapshot", rows: [] });
	handleMessage({ type: "delta", sessionId: "s", text: "still removed" });
	expect(isSessionBusy("s")).toBe(false);
	const row = { id: "s", title: "s", status: "idle" } as const;
	applySessionChange(
		tag === "snapshot"
			? { _tag: "snapshot", rows: [row] }
			: { _tag: "upsert", item: row },
	);
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "next turn" });
	expect(isSessionBusy("s")).toBe(true);
});

it("clears pending activity and its ticker when the socket drops before reconnect", () => {
	vi.useFakeTimers();
	const sockets: EventTarget[] = [];
	class Socket extends EventTarget {
		static readonly OPEN = 1;
		readyState = 1;
		constructor() {
			super();
			sockets.push(this);
		}
		close() {
			this.dispatchEvent(new Event("close"));
		}
	}
	vi.stubGlobal("WebSocket", Socket);
	const clearInterval = vi.spyOn(globalThis, "clearInterval");
	try {
		connect();
		sessionState.currentId = "s";
		handleMessage({ type: "delta", sessionId: "s", text: "working" });
		expect(isSessionBusy("s")).toBe(true);
		sockets[0]?.dispatchEvent(new Event("close"));
		expect(isSessionBusy("s")).toBe(false);
		expect(clearInterval).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2_000);
		expect(sockets).toHaveLength(2);
		expect(isSessionBusy("s")).toBe(false);
	} finally {
		disconnect();
	}
});

it("bridges tool activity newer than an idle row until a newer idle row arrives", () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	applySessionChange({
		_tag: "snapshot",
		sequence: 1,
		rows: [{ id: "s", title: "s", status: "idle", updatedAt: 500 }],
	});
	handleMessage({
		type: "tool_executing",
		sessionId: "s",
		id: "tool",
		name: "shell",
		input: {},
	});
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		sequence: 1,
		item: { id: "s", title: "s", status: "idle", updatedAt: 750 },
	});
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		sequence: 2,
		item: { id: "s", title: "s", status: "idle", updatedAt: 1_001 },
	});
	expect(isSessionBusy("s")).toBe(false);
	vi.setSystemTime(2_000);
	handleMessage({
		type: "tool_executing",
		sessionId: "s",
		id: "next-tool",
		name: "shell",
		input: {},
	});
	expect(isSessionBusy("s")).toBe(true);
	vi.advanceTimersByTime(10_000);
	expect(isSessionBusy("s")).toBe(false);
});

it("reads busy and retry from shell rows and accepts idle immediately", () => {
	expect(isSessionBusy("s")).toBe(false);
	for (const status of ["busy", "retry", "idle"] as const) {
		applySessionChange({
			_tag: "upsert",
			item: { id: "s", title: "s", status },
		});
		expect(isSessionBusy("s")).toBe(status !== "idle");
	}
});

it("keeps every ancestor busy until its last busy descendant stops or is removed", () => {
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{ id: "root", title: "root", status: "idle" },
			{ id: "child", title: "child", status: "idle", parentID: "root" },
			{ id: "leaf", title: "leaf", status: "busy", parentID: "child" },
			{ id: "sibling", title: "sibling", status: "retry", parentID: "root" },
			{ id: "other", title: "other", status: "idle" },
		],
	});
	expect(isSessionBusy("root")).toBe(true);
	expect(isSessionBusy("child")).toBe(true);
	expect(isSessionBusy("other")).toBe(false);
	applySessionChange({ _tag: "remove", id: "leaf" });
	expect(isSessionBusy("child")).toBe(false);
	expect(isSessionBusy("root")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: {
			id: "sibling",
			title: "sibling",
			status: "idle",
			parentID: "root",
		},
	});
	expect(isSessionBusy("root")).toBe(false);
});

it("bridges live content until the row speaks and accepts later activity in the same millisecond", () => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	handleMessage({ type: "delta", sessionId: "s", text: "hello" });
	expect(isSessionBusy("s")).toBe(true);
	vi.advanceTimersByTime(9_000);
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "busy" },
	});
	vi.advanceTimersByTime(20_000);
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "idle" },
	});
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "late content" });
	expect(isSessionBusy("s")).toBe(true);
	vi.advanceTimersByTime(20_000);
	expect(isSessionBusy("s")).toBe(false);
});

it("expires unconfirmed activity with one shared ticker and releases it on disconnect", () => {
	vi.useFakeTimers();
	const intervals = vi.spyOn(globalThis, "setInterval");
	for (const id of ["a", "b"]) {
		sessionState.currentId = id;
		handleMessage({ type: "delta", sessionId: id, text: "hello" });
	}
	expect(intervals).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(9_999);
	expect(isSessionBusy("a")).toBe(true);
	expect(isSessionBusy("b")).toBe(true);
	vi.advanceTimersByTime(1);
	expect(isSessionBusy("a")).toBe(false);
	expect(isSessionBusy("b")).toBe(false);
	handleMessage({ type: "delta", sessionId: "b", text: "more" });
	expect(isSessionBusy("b")).toBe(true);
	disconnect();
	expect(isSessionBusy("b")).toBe(false);
	vi.advanceTimersByTime(1_000);
	expect(vi.getTimerCount()).toBe(0);
});

it("retires activity on shell authority and cannot resurrect it after removal or reset", () => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	handleMessage({ type: "delta", sessionId: "s", text: "hello" });
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "idle" },
	});
	expect(isSessionBusy("s")).toBe(false);
	applySessionChange({ _tag: "remove", id: "s" });
	expect(isSessionBusy("s")).toBe(false);
	handleMessage({ type: "delta", sessionId: "s", text: "late" });
	expect(isSessionBusy("s")).toBe(false);
	clearSessionState();
	sessionState.currentId = "s";
	handleMessage({ type: "delta", sessionId: "s", text: "new project" });
	expect(isSessionBusy("s")).toBe(true);
	clearSessionState();
	expect(isSessionBusy("s")).toBe(false);
});
