// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	clearSessionState,
	isSessionBusy,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { disconnect } from "../../../src/lib/frontend/stores/ws.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import { applySessionChange } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";

beforeEach(() => clearSessionState());
afterEach(() => {
	clearSessionState();
	vi.useRealTimers();
	vi.restoreAllMocks();
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

it("bridges live content until the row speaks, without expiry flicker or stale activity overriding idle", () => {
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
	expect(isSessionBusy("s")).toBe(false);
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

it("does not flicker when a legacy poller status hint precedes the authoritative row", () => {
	vi.useFakeTimers();
	sessionState.currentId = "s";
	handleMessage({ type: "delta", sessionId: "s", text: "hello" });
	expect(isSessionBusy("s")).toBe(true);
	handleMessage({ type: "status", sessionId: "s", status: "processing" });
	expect(isSessionBusy("s")).toBe(true);
	handleMessage({ type: "status", sessionId: "s", status: "idle" });
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "busy" },
	});
	vi.advanceTimersByTime(20_000);
	expect(isSessionBusy("s")).toBe(true);
	handleMessage({ type: "status", sessionId: "s", status: "idle" });
	expect(isSessionBusy("s")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: { id: "s", title: "s", status: "idle" },
	});
	expect(isSessionBusy("s")).toBe(false);
});
