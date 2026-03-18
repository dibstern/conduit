// ─── Terminal Store Tests ────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
	requestCloseTab,
	requestCreateTab,
	switchTab,
	terminalState,
	togglePanel,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

// ─── Helper: cast incomplete test data to the expected type ─────────────────
// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Helper to build pty_created messages matching server protocol ───────────

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

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	destroyAll();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── handlePtyCreated ───────────────────────────────────────────────────────

describe("handlePtyCreated", () => {
	it("adds a tab and sets it as active (server sends { pty: PtyInfo })", () => {
		handlePtyCreated(ptyCreatedMsg("pty1", "bash"));
		expect(terminalState.tabs.size).toBe(1);
		expect(terminalState.activeTabId).toBe("pty1");
		expect(terminalState.panelOpen).toBe(true);
		// Sequential naming: ignores server title, generates "Terminal N"
		expect(terminalState.tabs.get("pty1")?.title).toBe("Terminal 1");
	});

	it("uses sequential title regardless of server title", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const tab = terminalState.tabs.get("pty1");
		expect(tab?.title).toBe("Terminal 1");
		handlePtyCreated(ptyCreatedMsg("pty2"));
		expect(terminalState.tabs.get("pty2")?.title).toBe("Terminal 2");
	});

	it("clears pending create state", () => {
		terminalState.pendingCreate = true;
		terminalState.statusMessage = "Creating terminal...";
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

// ─── handlePtyOutput ────────────────────────────────────────────────────────

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
		// 3 x 20KB = 60KB, should trim first chunk
		expect(getScrollbackSize("pty1")).toBeLessThanOrEqual(50 * 1024);
	});
});

// ─── onOutput subscription ──────────────────────────────────────────────────

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

// ─── handlePtyExited ────────────────────────────────────────────────────────

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

// ─── handlePtyDeleted ───────────────────────────────────────────────────────

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

// ─── handlePtyError ─────────────────────────────────────────────────────────

describe("handlePtyError", () => {
	it("clears pending create and shows server error message", () => {
		terminalState.pendingCreate = true;
		handlePtyError({
			type: "error",
			code: "PTY_CONNECT_FAILED",
			message: "Connection refused",
		});
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Connection refused");
	});

	it("falls back to default message when server message is empty", () => {
		terminalState.pendingCreate = true;
		handlePtyError({ type: "error", code: "", message: "" });
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Terminal creation failed");
	});

	it("clears error message after 3 seconds", () => {
		handlePtyError({ type: "error", code: "TIMEOUT", message: "Timeout" });
		expect(terminalState.statusMessage).toBe("Timeout");
		vi.advanceTimersByTime(3000);
		expect(terminalState.statusMessage).toBeNull();
	});
});

// ─── requestCreateTab ───────────────────────────────────────────────────────

describe("requestCreateTab", () => {
	it("sends pty_create and sets pending state", () => {
		const sent: Record<string, unknown>[] = [];
		requestCreateTab((data) => sent.push(data));
		expect(sent).toEqual([{ type: "pty_create" }]);
		expect(terminalState.pendingCreate).toBe(true);
		expect(terminalState.statusMessage).toBe("Creating terminal...");
	});

	it("does not send if already pending", () => {
		const sent: Record<string, unknown>[] = [];
		requestCreateTab((data) => sent.push(data));
		requestCreateTab((data) => sent.push(data));
		expect(sent).toHaveLength(1);
	});

	it("does not send if max tabs reached", () => {
		// Create max tabs
		for (let i = 0; i < terminalState.maxTabs; i++) {
			handlePtyCreated(ptyCreatedMsg(`pty${i}`));
		}
		const sent: Record<string, unknown>[] = [];
		requestCreateTab((data) => sent.push(data));
		expect(sent).toHaveLength(0);
	});

	it("times out after 15 seconds", () => {
		requestCreateTab(() => {});
		expect(terminalState.pendingCreate).toBe(true);
		vi.advanceTimersByTime(15_000);
		expect(terminalState.pendingCreate).toBe(false);
		expect(terminalState.statusMessage).toBe("Terminal creation timed out");
		// Message clears after another 3 seconds
		vi.advanceTimersByTime(3000);
		expect(terminalState.statusMessage).toBeNull();
	});
});

// ─── requestCloseTab ────────────────────────────────────────────────────────

describe("requestCloseTab", () => {
	it("sends pty_close and removes the tab optimistically", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		const sent: Record<string, unknown>[] = [];
		requestCloseTab("pty1", (data) => sent.push(data));
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(sent[0]!["type"]).toBe("pty_close");
		expect(terminalState.tabs.size).toBe(0);
	});
});

// ─── switchTab ──────────────────────────────────────────────────────────────

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

// ─── renameTab ──────────────────────────────────────────────────────────────

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

// ─── getScrollback / getScrollbackSize ──────────────────────────────────────

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

// ─── destroyAll ─────────────────────────────────────────────────────────────

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

// ─── Tab number reuse ──────────────────────────────────────────────────────

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

	it("requestCloseTab releases tab number via optimistic deletion", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyCreated(ptyCreatedMsg("pty2"));

		const sent: Record<string, unknown>[] = [];
		requestCloseTab("pty1", (data) => sent.push(data));

		// Optimistically deleted — number 1 should be reusable
		handlePtyCreated(ptyCreatedMsg("pty3"));
		expect(terminalState.tabs.get("pty3")?.title).toBe("Terminal 1");
	});
});

// ─── handlePtyList ──────────────────────────────────────────────────────────

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

	it("ignores empty pty list", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		handlePtyList({ type: "pty_list", ptys: [] });
		expect(terminalState.tabs.size).toBe(1);
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
});

// ─── togglePanel ─────────────────────────────────────────────────────────────

describe("togglePanel", () => {
	it("opens the panel", () => {
		expect(terminalState.panelOpen).toBe(false);
		togglePanel();
		expect(terminalState.panelOpen).toBe(true);
	});

	it("closes the panel when already open", () => {
		terminalState.panelOpen = true;
		togglePanel();
		expect(terminalState.panelOpen).toBe(false);
	});

	it("auto-creates a tab when opening with no tabs", () => {
		const sent: Record<string, unknown>[] = [];
		togglePanel((data) => sent.push(data));
		expect(terminalState.panelOpen).toBe(true);
		expect(sent).toEqual([{ type: "pty_create" }]);
		expect(terminalState.pendingCreate).toBe(true);
	});

	it("does not auto-create when tabs already exist", () => {
		handlePtyCreated(ptyCreatedMsg("pty1"));
		terminalState.panelOpen = false; // simulate closed panel with existing tab
		const sent: Record<string, unknown>[] = [];
		togglePanel((data) => sent.push(data));
		expect(sent).toHaveLength(0);
	});

	it("does not auto-create when no sendFn provided", () => {
		togglePanel();
		expect(terminalState.panelOpen).toBe(true);
		expect(terminalState.pendingCreate).toBe(false);
	});
});

// ─── openPanel / closePanel ──────────────────────────────────────────────────

describe("openPanel / closePanel", () => {
	it("openPanel sets panelOpen to true", () => {
		openPanel();
		expect(terminalState.panelOpen).toBe(true);
	});

	it("closePanel sets panelOpen to false", () => {
		terminalState.panelOpen = true;
		closePanel();
		expect(terminalState.panelOpen).toBe(false);
	});
});
