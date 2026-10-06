import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyPtyEnvelope,
	beginCreateTab,
	closePanel,
	destroyAll,
	getScrollback,
	getScrollbackSize,
	handlePtyError,
	handlePtyOutput,
	handlePtyRemove,
	handlePtySnapshot,
	handlePtyUpsert,
	onOutput,
	openPanel,
	renameTab,
	switchTab,
	terminalState,
	togglePanel,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";

/** A PTY as SubscribePtys sends it. */
function ptyRow(id: string, status: "running" | "exited" = "running") {
	return { id, title: "bash", command: "bash", cwd: "/repo", status, pid: 1 };
}

function upsert(id: string, status: "running" | "exited" = "running") {
	return { _tag: "upsert", item: ptyRow(id, status) } as const;
}

/** Snapshot rows for these PTYs, each with an empty scrollback ring. */
function rows(...ptys: ReturnType<typeof ptyRow>[]) {
	return ptys.map((pty) => ({ pty, scrollback: "" }));
}

beforeEach(() => {
	destroyAll();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("handlePtyUpsert of a new PTY", () => {
	it("adds a tab and sets it as active (server sends { pty: PtyInfo })", () => {
		handlePtyUpsert(upsert("pty1"));
		expect(terminalState.tabs.size).toBe(1);
		expect(terminalState.activeTabId).toBe("pty1");
		// Sequential naming: ignores server title, generates "Terminal N"
		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");
	});

	it("leaves the panel closed when the user switched away before the tab arrived", () => {
		closePanel();
		handlePtyUpsert(upsert("pty1"));
		expect(terminalState.panelOpen).toBe(false);
	});

	it("uses sequential title regardless of server title", () => {
		handlePtyUpsert(upsert("pty1"));
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.title).toBe("Terminal 1");
		handlePtyUpsert(upsert("pty2"));
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
	});

	it("clears pending create state", () => {
		beginCreateTab();
		handlePtyUpsert(upsert("pty1"));
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBeNull();
	});

	it("initializes scrollback buffer", () => {
		handlePtyUpsert(upsert("pty1"));
		expect(getScrollback("pty1")).toEqual([]);
	});

	it("only updates status for a PTY it already knows", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		handlePtyUpsert(upsert("pty1", "exited"));
		expect(terminalState.activeTabId).toBe("pty2");
		expect(terminalState.tabs.get("pty1")?.exited).toBe(true);
	});
});

describe("handlePtyOutput", () => {
	it("appends data to scrollback buffer", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "line1\n" });
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "line2\n" });
		expect(getScrollback("pty1")).toEqual(["line1\n", "line2\n"]);
	});

	it("calls output listeners", () => {
		handlePtyUpsert(upsert("pty1"));
		const received: string[] = [];
		onOutput("pty1", (data) => received.push(data));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "hello" });
		expect(received).toEqual(["hello"]);
	});

	it("replaces restored history and then appends live output", () => {
		handlePtyUpsert(upsert("pty1"));
		const output = vi.fn();
		onOutput("pty1", output);
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "marker\n" });
		handlePtyOutput({
			_tag: "output",
			ptyId: "pty1",
			data: "marker\nwhile disconnected\n",
			replace: true,
		});
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "live\n" });
		expect(getScrollback("pty1")).toEqual([
			"marker\nwhile disconnected\n",
			"live\n",
		]);
		expect(output.mock.calls).toEqual([
			["marker\n"],
			["marker\nwhile disconnected\n", true],
			["live\n"],
		]);
	});

	it("clears old history and signals mounted listeners for an empty replay", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "stale\n" });
		const output = vi.fn();
		onOutput("pty1", output);
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "", replace: true });
		expect(getScrollback("pty1")).toEqual([]);
		expect(getScrollbackSize("pty1")).toBe(0);
		expect(output).toHaveBeenCalledExactlyOnceWith("", true);
	});

	it("does not revive an exited terminal: only an upsert changes status", () => {
		const ptyId = "local-pty1";
		handlePtyUpsert(upsert(ptyId));
		handlePtyUpsert(upsert(ptyId, "exited"));
		handlePtyOutput({
			_tag: "output",
			ptyId,
			data: "history",
			replace: true,
		});
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
		handlePtyOutput({ _tag: "output", ptyId, data: "live" });
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
	});

	it("trims scrollback buffer when exceeding 50KB", () => {
		handlePtyUpsert(upsert("pty1"));
		// Write chunks that exceed 50KB total
		const bigChunk = "x".repeat(20 * 1024); // 20KB each
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: bigChunk });
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: bigChunk });
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: bigChunk });
		expect(getScrollback("pty1")).toEqual([
			"x".repeat(10 * 1024),
			bigChunk,
			bigChunk,
		]);
		expect(getScrollbackSize("pty1")).toBe(50 * 1024);
	});

	it("retains the tail of a full replay when the next live chunk arrives", () => {
		handlePtyUpsert(upsert("pty1"));
		const snapshot = "a".repeat(50 * 1024);
		handlePtyOutput({
			_tag: "output",
			ptyId: "pty1",
			data: snapshot,
			replace: true,
		});
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "b" });
		expect(getScrollback("pty1")).toEqual([snapshot.slice(1), "b"]);
		expect(getScrollbackSize("pty1")).toBe(50 * 1024);
	});

	it("bounds a single oversized UTF-8 chunk without splitting a character", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({
			_tag: "output",
			ptyId: "pty1",
			data: "€".repeat(20_000),
		});
		expect(getScrollback("pty1")).toEqual(["€".repeat(17_066)]);
		expect(getScrollbackSize("pty1")).toBe(51_198);
	});

	it("trims UTF-8 at code point boundaries after a full emoji snapshot", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({
			_tag: "output",
			ptyId: "pty1",
			data: "🚀".repeat(12_800),
		});
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "a" });
		expect(getScrollback("pty1")).toEqual(["🚀".repeat(12_799), "a"]);
		expect(getScrollbackSize("pty1")).toBe(51_197);
	});

	it("reports UTF-8 bytes rather than UTF-16 code units", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "🚀é" });
		expect(getScrollbackSize("pty1")).toBe(6);
	});
});

describe("onOutput", () => {
	it("returns an unsubscribe function", () => {
		handlePtyUpsert(upsert("pty1"));
		const received: string[] = [];
		const unsub = onOutput("pty1", (data) => received.push(data));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "a" });
		unsub();
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "b" });
		expect(received).toEqual(["a"]);
	});

	it("supports multiple listeners for same pty", () => {
		handlePtyUpsert(upsert("pty1"));
		const r1: string[] = [];
		const r2: string[] = [];
		onOutput("pty1", (data) => r1.push(data));
		onOutput("pty1", (data) => r2.push(data));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "x" });
		expect(r1).toEqual(["x"]);
		expect(r2).toEqual(["x"]);
	});
});

describe("handlePtyUpsert of an exited PTY", () => {
	it("marks the tab as exited", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty1", "exited"));
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.exited).toBe(true);
	});

	it("revives it when the server reports it running again", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty1", "exited"));
		handlePtyUpsert(upsert("pty1"));
		expect(terminalState.tabs.get("pty1")?.exited).toBe(false);
	});
});

describe("handlePtyRemove", () => {
	it("removes the tab", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyRemove({ id: "pty1" });
		expect(terminalState.tabs.size).toBe(0);
	});

	it("cleans up scrollback and listeners", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "data" });
		const received: string[] = [];
		onOutput("pty1", (data) => received.push(data));

		handlePtyRemove({ id: "pty1" });
		expect(getScrollback("pty1")).toEqual([]);
	});

	it("switches to another tab when active tab is deleted", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		// pty2 is now active
		handlePtyRemove({ id: "pty2" });
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("sets activeTabId to null when last tab is deleted", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyRemove({ id: "pty1" });
		expect(terminalState.activeTabId).toBeNull();
		expect(terminalState.panelOpen).toBe(false);
	});
});

describe("handlePtyError", () => {
	it("clears pending create and shows server error message", () => {
		beginCreateTab();
		handlePtyError({
			type: "error",
			sessionId: "s1",
			code: "PTY_CONNECT_FAILED",
			message: "Connection refused",
		});
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Connection refused");
	});

	it("falls back to default message when server message is empty", () => {
		beginCreateTab();
		handlePtyError({ type: "error", sessionId: "s1", code: "", message: "" });
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Terminal creation failed");
	});

	it("clears error message after 3 seconds", () => {
		handlePtyError({
			type: "error",
			sessionId: "s1",
			code: "TIMEOUT",
			message: "Timeout",
		});
		expect(terminalState.statusMessage).toBe("Timeout");
		vi.advanceTimersByTime(3000);
		expect(terminalState.statusMessage).toBeNull();
	});
});

describe("beginCreateTab", () => {
	it("sets pending create state", () => {
		expect(beginCreateTab()).toBe(true);
		expect(terminalState.pendingCreate).toBe(true);
		expect(terminalState.statusMessage).toBe("Creating terminal...");
	});

	it("returns false if already pending", () => {
		expect(beginCreateTab()).toBe(true);
		expect(beginCreateTab()).toBe(false);
	});

	it("returns false if max tabs reached", () => {
		// Create max tabs
		for (let i = 0; i < terminalState.maxTabs; i++) {
			handlePtyUpsert(upsert(`pty${i}`));
		}
		expect(beginCreateTab()).toBe(false);
	});

	it("times out after 15 seconds", () => {
		beginCreateTab();
		expect(terminalState.pendingCreate).toBe(true);
		vi.advanceTimersByTime(15_000);
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Terminal creation timed out");
		// Message clears after another 3 seconds
		vi.advanceTimersByTime(3000);
		expect(terminalState.statusMessage).toBeNull();
	});
});

describe("switchTab", () => {
	it("switches to an existing tab", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		switchTab("pty1");
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("does not switch to non-existent tab", () => {
		handlePtyUpsert(upsert("pty1"));
		switchTab("nonexistent");
		expect(terminalState.activeTabId).toBe("pty1");
	});
});

describe("renameTab", () => {
	it("renames an existing tab", () => {
		handlePtyUpsert(upsert("pty1"));
		renameTab("pty1", "new name");
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.title).toBe("new name");
	});

	it("does nothing for non-existent tab", () => {
		renameTab("nonexistent", "name");
		expect(terminalState.tabs.size).toBe(0);
	});
});

describe("getScrollback and getScrollbackSize", () => {
	it("returns empty array for unknown pty", () => {
		expect(getScrollback("unknown")).toEqual([]);
	});

	it("returns 0 for unknown pty size", () => {
		expect(getScrollbackSize("unknown")).toBe(0);
	});

	it("returns correct size", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "12345" });
		expect(getScrollbackSize("pty1")).toBe(5);
	});
});

describe("destroyAll", () => {
	it("clears all terminal state", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "data" });
		destroyAll();
		expect(terminalState.tabs.size).toBe(0);
		expect(terminalState.activeTabId).toBeNull();
		expect(terminalState.panelOpen).toBe(false);
		expect(getScrollback("pty1")).toEqual([]);
	});
});

describe("tab number reuse", () => {
	it("reuses lowest available number when a tab is closed", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		handlePtyUpsert(upsert("pty3"));

		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 3");

		// Close Terminal 2
		handlePtyRemove({ id: "pty2" });
		expect(terminalState.tabs.size).toBe(2);

		// Next tab should reuse number 2
		handlePtyUpsert(upsert("pty4"));
		expect(terminalState.tabs.get("pty4")?.title).toBe("Terminal 2");
	});

	it("reuses number 1 when first tab is closed", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));

		handlePtyRemove({ id: "pty1" });

		handlePtyUpsert(upsert("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});

	it("reuses multiple closed numbers in order", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		handlePtyUpsert(upsert("pty3"));

		// Close 1 and 3
		handlePtyRemove({ id: "pty1" });
		handlePtyRemove({ id: "pty3" });

		// Next tab gets lowest available: 1
		handlePtyUpsert(upsert("pty4"));
		expect(terminalState.tabs.get("pty4")?.title).toBe("Terminal 1");

		// Next tab gets 3 (2 is still in use)
		handlePtyUpsert(upsert("pty5"));
		expect(terminalState.tabs.get("pty5")?.title).toBe("Terminal 3");
	});

	it("resets tab numbers when all tabs are closed", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));

		handlePtyRemove({ id: "pty1" });
		handlePtyRemove({ id: "pty2" });

		// Panel closes, tab numbers reset
		handlePtyUpsert(upsert("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});

	it("does not reuse numbers for tabs with custom titles", () => {
		handlePtyUpsert(upsert("pty1"));
		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");

		// Rename the tab (no longer matches "Terminal N" pattern)
		renameTab("pty1", "My Custom Shell");
		handlePtyRemove({ id: "pty1" });

		// Next tab should be Terminal 1 (custom name doesn't affect counter)
		handlePtyUpsert(upsert("pty2"));
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 1");
	});

	it("handlePtyRemove releases tab number", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));

		handlePtyRemove({ id: "pty1" });

		// Deleted tab number should be reusable
		handlePtyUpsert(upsert("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});
});

describe("handlePtySnapshot", () => {
	it("adds tabs from the server's PTYs", () => {
		handlePtySnapshot(rows(ptyRow("pty-a"), ptyRow("pty-b")));
		expect(terminalState.tabs.size).toBe(2);
		expect(terminalState.tabs.get("pty-a")?.title).toBe("Terminal 1");
		expect(terminalState.tabs.get("pty-b")?.title).toBe("Terminal 2");
		expect(terminalState.activeTabId).toBe("pty-a");
	});

	it("does not duplicate existing tabs", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtySnapshot(rows(ptyRow("pty1")));
		expect(terminalState.tabs.size).toBe(1);
	});

	it("removes tabs not on server", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		handlePtySnapshot(rows(ptyRow("pty2")));
		expect(terminalState.tabs.has("pty1")).toBe(false);
		expect(terminalState.tabs.has("pty2")).toBe(true);
	});

	it("clears server-owned tabs when the authoritative snapshot is empty", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtySnapshot([]);
		expect(terminalState.tabs.size).toBe(0);
	});

	it("marks exited PTYs", () => {
		handlePtySnapshot(rows(ptyRow("pty1", "exited")));
		expect(terminalState.tabs.get("pty1")?.exited).toBe(true);
	});

	it("restores each scrollback ring without marking it unread", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyOutput({ _tag: "output", ptyId: "pty1", data: "stale\n" });
		const output = vi.fn();
		onOutput("pty1", output);
		handlePtySnapshot([{ pty: ptyRow("pty1"), scrollback: "ring\n" }]);
		expect(getScrollback("pty1")).toEqual(["ring\n"]);
		expect(output).toHaveBeenCalledExactlyOnceWith("ring\n", true);
		expect(terminalState.unreadPtyIds.has("pty1")).toBe(true);
		destroyAll();
		handlePtySnapshot([{ pty: ptyRow("pty2"), scrollback: "ring\n" }]);
		expect(terminalState.unreadPtyIds.has("pty2")).toBe(false);
	});
});

describe("applyPtyEnvelope", () => {
	it("routes every envelope of a subscription to its reducer", () => {
		const envelopes = [
			{ _tag: "snapshot", rows: rows(ptyRow("pty1")) },
			{ _tag: "synchronized" },
			upsert("pty2"),
			{ _tag: "output", ptyId: "pty2", data: "hi" },
			{ _tag: "remove", id: "pty1" },
		] as const;
		for (const envelope of envelopes) applyPtyEnvelope(envelope);
		expect([...terminalState.tabs.keys()]).toEqual(["pty2"]);
		expect(getScrollback("pty2")).toEqual(["hi"]);
	});
});

describe("togglePanel", () => {
	it("opens the panel", () => {
		expect(terminalState.panelOpen).toBe(false);
		togglePanel();
		expect(terminalState.panelOpen).toBe(true);
	});

	it("closes the panel when already open", () => {
		openPanel();
		togglePanel();
		expect(terminalState.panelOpen).toBe(false);
	});

	it("does not mutate tab create state when opening", () => {
		handlePtyUpsert(upsert("pty1"));
		closePanel(); // simulate closed panel with existing tab
		togglePanel();
		expect(terminalState.panelOpen).toBe(true);
		expect(terminalState.pendingCreate).toBe(false);
	});
});

describe("openPanel / closePanel", () => {
	it("openPanel sets panelOpen to true", () => {
		openPanel();
		expect(terminalState.panelOpen).toBe(true);
	});

	it("closePanel sets panelOpen to false", () => {
		openPanel();
		closePanel();
		expect(terminalState.panelOpen).toBe(false);
	});
});

describe("applying server rows never touches the client half", () => {
	it("keeps the renamed label and the selected tab across a snapshot", () => {
		handlePtyUpsert(upsert("pty1"));
		handlePtyUpsert(upsert("pty2"));
		renameTab("pty1", "build");
		switchTab("pty1");

		handlePtySnapshot(rows(ptyRow("pty1"), ptyRow("pty2"), ptyRow("pty3")));

		expect(terminalState.tabs.get("pty1")?.title).toBe("build");
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("takes exit status from the server without disturbing the label", () => {
		handlePtyUpsert(upsert("pty1"));
		renameTab("pty1", "build");

		handlePtyUpsert(upsert("pty1", "exited"));

		expect(terminalState.tabs.get("pty1")).toEqual({
			ptyId: "pty1",
			title: "build",
			exited: true,
		});
	});

	it("a host restore (running upsert + replace output) revives the tab without replacing client state", () => {
		const ptyId = "local-pty1";
		handlePtyUpsert(upsert(ptyId));
		handlePtyUpsert(upsert("pty2"));
		renameTab(ptyId, "build");
		switchTab(ptyId);
		openPanel();
		handlePtyOutput({ _tag: "output", ptyId, data: "retained\n" });
		const scrollback = getScrollback(ptyId);
		const output = vi.fn();
		onOutput(ptyId, output);
		handlePtyUpsert(upsert(ptyId, "exited"));
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);

		handlePtyUpsert(upsert(ptyId));
		handlePtyOutput({
			_tag: "output",
			ptyId,
			data: "retained\n",
			replace: true,
		});

		expect(terminalState.tabs.get(ptyId)).toEqual({
			ptyId,
			title: "build",
			exited: false,
		});
		expect(terminalState.activeTabId).toBe(ptyId);
		expect(terminalState.panelOpen).toBe(true);
		expect(getScrollback(ptyId)).toBe(scrollback);
		expect(scrollback).toEqual(["retained\n"]);
		handlePtyOutput({ _tag: "output", ptyId, data: "live\n" });
		expect(output.mock.calls).toEqual([["retained\n", true], ["live\n"]]);
		expect(scrollback).toEqual(["retained\n", "live\n"]);
	});

	it("restores a running host terminal when its restored ring is empty", () => {
		const ptyId = "local-pty1";
		handlePtyUpsert(upsert(ptyId));
		handlePtyOutput({ _tag: "output", ptyId, data: "stale" });
		handlePtyUpsert(upsert(ptyId, "exited"));
		handlePtyUpsert(upsert(ptyId));
		handlePtyOutput({ _tag: "output", ptyId, data: "", replace: true });
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(false);
		expect(getScrollback(ptyId)).toEqual([]);
	});

	it("drops the label when the server drops the pty, freeing its number", () => {
		handlePtyUpsert(upsert("pty1"));
		renameTab("pty1", "build");
		handlePtyRemove({ id: "pty1" });

		handlePtyUpsert(upsert("pty2"));

		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 1");
	});
});
