import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyPtyListResponse,
	beginCreateTab,
	closePanel,
	destroyAll,
	getScrollback,
	getScrollbackSize,
	handlePtyCreated,
	handlePtyDeleted,
	handlePtyError,
	handlePtyExited,
	handlePtyList,
	handlePtyOutput,
	onOutput,
	openPanel,
	renameTab,
	switchTab,
	terminalState,
	togglePanel,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

function ptyCreatedMsg(
	id: string,
	_title?: string,
): Extract<RelayMessage, { type: "pty_created" }> {
	return msg({
		type: "pty_created" as const,
		pty: {
			id,
			title: _title ?? "",
			command: "",
			cwd: "",
			status: "running",
			pid: 0,
		},
	});
}

beforeEach(() => {
	destroyAll();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("handlePtyCreated", () => {
	it("adds a tab and sets it as active (server sends { pty: PtyInfo })", () => {
		handlePtyCreated(ptyCreatedMsg("pty1", "bash"));
		expect(terminalState.tabs.size).toBe(1);
		expect(terminalState.activeTabId).toBe("pty1");
		// Sequential naming: ignores server title, generates "Terminal N"
		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");
	});

	it("leaves the panel closed when the user switched away before the tab arrived", () => {
		closePanel();
		handlePtyCreated(ptyCreatedMsg("pty1", "bash"));
		expect(terminalState.panelOpen).toBe(false);
	});

	it("uses sequential title regardless of server title", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.title).toBe("Terminal 1");
		handlePtyCreated(ptyCreatedMsg("pty2"));
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
	});

	it("clears pending create state", () => {
		beginCreateTab();
		handlePtyCreated(ptyCreatedMsg("pty1"));
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBeNull();
	});

	it("initializes scrollback buffer", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		expect(getScrollback("pty1")).toEqual([]);
	});

	it("ignores message with missing pty object", () => {
		handlePtyCreated(msg({ type: "pty_created" }));
		expect(terminalState.tabs.size).toBe(0);
	});
});

describe("handlePtyOutput", () => {
	it("appends data to scrollback buffer", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "line1\n" });
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "line2\n" });
		expect(getScrollback("pty1")).toEqual(["line1\n", "line2\n"]);
	});

	it("calls output listeners", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const received: string[] = [];
		onOutput("pty1", (data) => received.push(data));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "hello" });
		expect(received).toEqual(["hello"]);
	});

	it("replaces restored history and then appends live output", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const output = vi.fn();
		onOutput("pty1", output);
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "marker\n" });
		handlePtyOutput(
			msg({
				type: "pty_output",
				ptyId: "pty1",
				data: "marker\nwhile disconnected\n",
				replace: true,
			}),
		);
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "live\n" });
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
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "stale\n" });
		const output = vi.fn();
		onOutput("pty1", output);
		handlePtyOutput(
			msg({ type: "pty_output", ptyId: "pty1", data: "", replace: true }),
		);
		expect(getScrollback("pty1")).toEqual([]);
		expect(getScrollbackSize("pty1")).toBe(0);
		expect(output).toHaveBeenCalledExactlyOnceWith("", true);
	});

	it("does not revive an exited terminal without confirmed restoration replay", () => {
		const ptyId = "local-pty1";
		handlePtyCreated(ptyCreatedMsg(ptyId));
		handlePtyExited({ type: "pty_exited", ptyId, exitCode: -1 });
		handlePtyOutput({
			type: "pty_output",
			ptyId,
			data: "history",
			replace: true,
		});
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
		handlePtyOutput(
			msg({ type: "pty_output", ptyId, data: "live", restored: true }),
		);
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
	});

	it("ignores output with missing ptyId", () => {
		handlePtyOutput(msg({ type: "pty_output", data: "orphan" }));
		// Should not throw
	});

	it("ignores output with non-string data", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput(msg({ type: "pty_output", ptyId: "pty1", data: 123 }));
		expect(getScrollback("pty1")).toEqual([]);
	});

	it("trims scrollback buffer when exceeding 50KB", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		// Write chunks that exceed 50KB total
		const bigChunk = "x".repeat(20 * 1024); // 20KB each
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: bigChunk });
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: bigChunk });
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: bigChunk });
		expect(getScrollback("pty1")).toEqual([
			"x".repeat(10 * 1024),
			bigChunk,
			bigChunk,
		]);
		expect(getScrollbackSize("pty1")).toBe(50 * 1024);
	});

	it("retains the tail of a full replay when the next live chunk arrives", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const snapshot = "a".repeat(50 * 1024);
		handlePtyOutput(
			msg({
				type: "pty_output",
				ptyId: "pty1",
				data: snapshot,
				replace: true,
			}),
		);
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "b" });
		expect(getScrollback("pty1")).toEqual([snapshot.slice(1), "b"]);
		expect(getScrollbackSize("pty1")).toBe(50 * 1024);
	});

	it("bounds a single oversized UTF-8 chunk without splitting a character", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({
			type: "pty_output",
			ptyId: "pty1",
			data: "€".repeat(20_000),
		});
		expect(getScrollback("pty1")).toEqual(["€".repeat(17_066)]);
		expect(getScrollbackSize("pty1")).toBe(51_198);
	});

	it("trims UTF-8 at code point boundaries after a full emoji snapshot", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({
			type: "pty_output",
			ptyId: "pty1",
			data: "🚀".repeat(12_800),
		});
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "a" });
		expect(getScrollback("pty1")).toEqual(["🚀".repeat(12_799), "a"]);
		expect(getScrollbackSize("pty1")).toBe(51_197);
	});

	it("reports UTF-8 bytes rather than UTF-16 code units", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "🚀é" });
		expect(getScrollbackSize("pty1")).toBe(6);
	});
});

describe("onOutput", () => {
	it("returns an unsubscribe function", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const received: string[] = [];
		const unsub = onOutput("pty1", (data) => received.push(data));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "a" });
		unsub();
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "b" });
		expect(received).toEqual(["a"]);
	});

	it("supports multiple listeners for same pty", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const r1: string[] = [];
		const r2: string[] = [];
		onOutput("pty1", (data) => r1.push(data));
		onOutput("pty1", (data) => r2.push(data));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "x" });
		expect(r1).toEqual(["x"]);
		expect(r2).toEqual(["x"]);
	});
});

describe("handlePtyExited", () => {
	it("marks the tab as exited", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyExited({ type: "pty_exited", ptyId: "pty1", exitCode: 0 });
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.exited).toBe(true);
	});

	it("ignores unknown ptyId", () => {
		handlePtyExited({ type: "pty_exited", ptyId: "unknown", exitCode: 0 });
		expect(terminalState.tabs.size).toBe(0);
	});
});

describe("handlePtyDeleted", () => {
	it("removes the tab", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });
		expect(terminalState.tabs.size).toBe(0);
	});

	it("cleans up scrollback and listeners", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "data" });
		const received: string[] = [];
		onOutput("pty1", (data) => received.push(data));

		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });
		expect(getScrollback("pty1")).toEqual([]);
	});

	it("switches to another tab when active tab is deleted", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		// pty2 is now active
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty2" });
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("sets activeTabId to null when last tab is deleted", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });
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
			handlePtyCreated(ptyCreatedMsg(`pty${i}`));
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
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		switchTab("pty1");
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("does not switch to non-existent tab", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		switchTab("nonexistent");
		expect(terminalState.activeTabId).toBe("pty1");
	});
});

describe("renameTab", () => {
	it("renames an existing tab", () => {
		handlePtyCreated(ptyCreatedMsg("pty1", "old"));
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
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "12345" });
		expect(getScrollbackSize("pty1")).toBe(5);
	});
});

describe("destroyAll", () => {
	it("clears all terminal state", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyOutput({ type: "pty_output", ptyId: "pty1", data: "data" });
		destroyAll();
		expect(terminalState.tabs.size).toBe(0);
		expect(terminalState.activeTabId).toBeNull();
		expect(terminalState.panelOpen).toBe(false);
		expect(getScrollback("pty1")).toEqual([]);
	});
});

describe("tab number reuse", () => {
	it("reuses lowest available number when a tab is closed", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		handlePtyCreated(ptyCreatedMsg("pty3"));

		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 3");

		// Close Terminal 2
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty2" });
		expect(terminalState.tabs.size).toBe(2);

		// Next tab should reuse number 2
		handlePtyCreated(ptyCreatedMsg("pty4"));
		expect(terminalState.tabs.get("pty4")?.title).toBe("Terminal 2");
	});

	it("reuses number 1 when first tab is closed", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));

		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });

		handlePtyCreated(ptyCreatedMsg("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});

	it("reuses multiple closed numbers in order", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		handlePtyCreated(ptyCreatedMsg("pty3"));

		// Close 1 and 3
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty3" });

		// Next tab gets lowest available: 1
		handlePtyCreated(ptyCreatedMsg("pty4"));
		expect(terminalState.tabs.get("pty4")?.title).toBe("Terminal 1");

		// Next tab gets 3 (2 is still in use)
		handlePtyCreated(ptyCreatedMsg("pty5"));
		expect(terminalState.tabs.get("pty5")?.title).toBe("Terminal 3");
	});

	it("resets tab numbers when all tabs are closed", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));

		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty2" });

		// Panel closes, tab numbers reset
		handlePtyCreated(ptyCreatedMsg("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});

	it("does not reuse numbers for tabs with custom titles", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");

		// Rename the tab (no longer matches "Terminal N" pattern)
		renameTab("pty1", "My Custom Shell");
		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });

		// Next tab should be Terminal 1 (custom name doesn't affect counter)
		handlePtyCreated(ptyCreatedMsg("pty2"));
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 1");
	});

	it("handlePtyDeleted releases tab number", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));

		handlePtyDeleted({ type: "pty_deleted", ptyId: "pty1" });

		// Deleted tab number should be reusable
		handlePtyCreated(ptyCreatedMsg("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});
});

describe("handlePtyList", () => {
	it("adds tabs from server PTY list", () => {
		handlePtyList({
			type: "pty_list",
			ptys: [
				{
					id: "pty-a",
					title: "bash",
					command: "bash",
					cwd: "/",
					status: "running",
					pid: 1,
				},
				{
					id: "pty-b",
					title: "zsh",
					command: "zsh",
					cwd: "/",
					status: "running",
					pid: 2,
				},
			],
		});
		expect(terminalState.tabs.size).toBe(2);
		expect(terminalState.tabs.get("pty-a")?.title).toBe("Terminal 1");
		expect(terminalState.tabs.get("pty-b")?.title).toBe("Terminal 2");
	});

	it("does not duplicate existing tabs", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyList({
			type: "pty_list",
			ptys: [
				{
					id: "pty1",
					title: "bash",
					command: "bash",
					cwd: "/",
					status: "running",
					pid: 1,
				},
			],
		});
		expect(terminalState.tabs.size).toBe(1);
	});

	it("removes tabs not on server", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		handlePtyList({
			type: "pty_list",
			ptys: [
				{
					id: "pty2",
					title: "bash",
					command: "bash",
					cwd: "/",
					status: "running",
					pid: 1,
				},
			],
		});
		expect(terminalState.tabs.has("pty1")).toBe(false);
		expect(terminalState.tabs.has("pty2")).toBe(true);
	});

	it("clears server-owned tabs when the authoritative pty list is empty", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyList({ type: "pty_list", ptys: [] });
		expect(terminalState.tabs.size).toBe(0);
	});

	it("marks exited PTYs", () => {
		handlePtyList({
			type: "pty_list",
			ptys: [
				{
					id: "pty1",
					title: "bash",
					command: "bash",
					cwd: "/",
					status: "exited",
					pid: 1,
				},
			],
		});
		expect(terminalState.tabs.get("pty1")?.exited).toBe(true);
	});

	it("applies RPC list responses through the terminal list reducer", () => {
		applyPtyListResponse({
			projectSlug: "demo",
			ptys: [
				{
					id: "pty-rpc",
					title: "Shell",
					command: "zsh",
					cwd: "/repo",
					status: "running",
					pid: 123,
				},
			],
		});

		expect(terminalState.tabs.size).toBe(1);
		expect(terminalState.tabs.get("pty-rpc")?.title).toBe("Terminal 1");
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
		handlePtyCreated(ptyCreatedMsg("pty1"));
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

/** A pty_list row as the server sends it. */
function ptyRow(id: string, status: "running" | "exited" = "running") {
	return { id, title: "bash", command: "bash", cwd: "/repo", status, pid: 1 };
}

describe("applying server rows never touches the client half", () => {
	it("keeps the renamed label and the selected tab across a pty_list", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		renameTab("pty1", "build");
		switchTab("pty1");

		handlePtyList({
			type: "pty_list",
			ptys: [ptyRow("pty1"), ptyRow("pty2"), ptyRow("pty3")],
		});

		expect(terminalState.tabs.get("pty1")?.title).toBe("build");
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
		expect(terminalState.activeTabId).toBe("pty1");
	});

	it("takes exit status from the server without disturbing the label", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		renameTab("pty1", "build");

		handlePtyExited(msg({ type: "pty_exited", ptyId: "pty1" }));

		expect(terminalState.tabs.get("pty1")).toEqual({
			ptyId: "pty1",
			title: "build",
			exited: true,
		});
	});

	it.each([
		"local-pty1",
		"pty-opencode",
	])("keeps %s exited when an older ListPtys response arrives after its exit", (ptyId) => {
		const olderResponse = { projectSlug: "demo", ptys: [ptyRow(ptyId)] };
		applyPtyListResponse(olderResponse);
		handlePtyExited({ type: "pty_exited", ptyId, exitCode: 0 });

		applyPtyListResponse(olderResponse);

		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
	});

	it("requires confirmed host replay to restore running status without replacing client state", () => {
		const ptyId = "local-pty1";
		handlePtyCreated(ptyCreatedMsg(ptyId));
		handlePtyCreated(ptyCreatedMsg("pty2"));
		renameTab(ptyId, "build");
		switchTab(ptyId);
		openPanel();
		handlePtyOutput({ type: "pty_output", ptyId, data: "retained\n" });
		const scrollback = getScrollback(ptyId);
		const output = vi.fn();
		onOutput(ptyId, output);
		handlePtyExited({ type: "pty_exited", ptyId, exitCode: -1 });
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);

		handlePtyList({ type: "pty_list", ptys: [ptyRow(ptyId), ptyRow("pty2")] });
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(true);
		handlePtyOutput(
			msg({
				type: "pty_output",
				ptyId,
				data: "retained\n",
				replace: true,
				restored: true,
			}),
		);

		expect(terminalState.tabs.get(ptyId)).toEqual({
			ptyId,
			title: "build",
			exited: false,
		});
		expect(terminalState.activeTabId).toBe(ptyId);
		expect(terminalState.panelOpen).toBe(true);
		expect(getScrollback(ptyId)).toBe(scrollback);
		expect(scrollback).toEqual(["retained\n"]);
		handlePtyOutput({ type: "pty_output", ptyId, data: "live\n" });
		expect(output.mock.calls).toEqual([["retained\n", true], ["live\n"]]);
		expect(scrollback).toEqual(["retained\n", "live\n"]);
	});

	it("restores a running host terminal when its confirmed snapshot is empty", () => {
		const ptyId = "local-pty1";
		handlePtyCreated(ptyCreatedMsg(ptyId));
		handlePtyOutput({ type: "pty_output", ptyId, data: "stale" });
		handlePtyExited({ type: "pty_exited", ptyId, exitCode: -1 });
		handlePtyOutput(
			msg({
				type: "pty_output",
				ptyId,
				data: "",
				replace: true,
				restored: true,
			}),
		);
		expect(terminalState.tabs.get(ptyId)?.exited).toBe(false);
		expect(getScrollback(ptyId)).toEqual([]);
	});

	it("drops the label when the server drops the pty, freeing its number", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		renameTab("pty1", "build");
		handlePtyDeleted(msg({ type: "pty_deleted", ptyId: "pty1" }));

		handlePtyCreated(ptyCreatedMsg("pty2"));

		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 1");
	});
});
