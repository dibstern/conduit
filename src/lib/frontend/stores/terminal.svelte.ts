// ─── Terminal Store ──────────────────────────────────────────────────────────
// Terminal tabs, PTY state, scrollback buffers.
// Uses callback pattern for high-throughput PTY output (not reactive).

import type { RelayMessage, TabEntry } from "../types.js";
import { STATUS_MESSAGE_MS } from "../ui-constants.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SCROLLBACK_MAX_BYTES = 50 * 1024; // 50 KB per tab
const DEFAULT_MAX_TABS = 10;
const PENDING_CREATE_TIMEOUT_MS = 15_000;

// ─── State ──────────────────────────────────────────────────────────────────

export const terminalState = $state({
	tabs: new Map<string, TabEntry>(),
	activeTabId: null as string | null,
	panelOpen: false,
	pendingCreate: false,
	statusMessage: null as string | null,
	maxTabs: DEFAULT_MAX_TABS,
});

// ─── Non-reactive state (high-throughput PTY data) ──────────────────────────

const scrollbackBuffers = new Map<string, string[]>();
const outputListeners = new Map<string, Set<(data: string) => void>>();
let pendingCreateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Find the lowest available tab number by scanning tab titles.
 * Derives directly from tabs — no separate tracking needed.
 * Accepts an optional Map to scan (for use during batch updates like pty_list
 * where terminalState.tabs hasn't been committed yet).
 * E.g., if tabs "Terminal 1" and "Terminal 3" exist, returns 2.
 */
function nextAvailableTabNumber(
	tabs: Map<string, TabEntry> = terminalState.tabs,
): number {
	const used = new Set<number>();
	for (const tab of tabs.values()) {
		const match = /^Terminal (\d+)$/.exec(tab.title);
		if (match) used.add(Number(match[1]));
	}
	let n = 1;
	while (used.has(n)) n++;
	return n;
}

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the number of open terminal tabs. */
export function getTabCount(): number {
	return terminalState.tabs.size;
}

/** Get whether we can create more tabs. */
export function getCanCreateTab(): boolean {
	return (
		!terminalState.pendingCreate &&
		terminalState.tabs.size < terminalState.maxTabs
	);
}

/** Get the ordered list of tabs for rendering. */
export function getTabList(): TabEntry[] {
	return Array.from(terminalState.tabs.values());
}

// ─── Output subscription (callback pattern) ─────────────────────────────────

/**
 * Subscribe to output for a specific PTY. Returns an unsubscribe function.
 * This bypasses Svelte reactivity for performance — terminal output can be
 * very high-throughput and shouldn't trigger re-renders on every chunk.
 */
export function onOutput(
	ptyId: string,
	cb: (data: string) => void,
): () => void {
	let listeners = outputListeners.get(ptyId);
	if (!listeners) {
		listeners = new Set();
		outputListeners.set(ptyId, listeners);
	}
	listeners.add(cb);

	return () => {
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized before this code path
		listeners!.delete(cb);
		// biome-ignore lint/style/noNonNullAssertion: safe — initialized before this code path
		if (listeners!.size === 0) {
			outputListeners.delete(ptyId);
		}
	};
}

/** Get scrollback buffer for replay on mount. */
export function getScrollback(ptyId: string): string[] {
	return scrollbackBuffers.get(ptyId) ?? [];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a sequential tab title, reusing numbers from closed tabs. */
function generateTabTitle(
	tabs: Map<string, TabEntry> = terminalState.tabs,
): string {
	return `Terminal ${nextAvailableTabNumber(tabs)}`;
}

// ─── Message handlers ───────────────────────────────────────────────────────

/** Handle pty_list — sync frontend tabs with server's existing PTYs. */
export function handlePtyList(
	msg: Extract<RelayMessage, { type: "pty_list" }>,
): void {
	const ptys = msg.ptys ?? [];

	if (ptys.length === 0) return;

	const newTabs = new Map(terminalState.tabs);
	const serverIds = new Set<string>();

	for (const pty of ptys) {
		const ptyId = pty.id;
		if (!ptyId) continue;
		serverIds.add(ptyId);

		// Only add tabs we don't already have
		if (!newTabs.has(ptyId)) {
			const title = generateTabTitle(newTabs);
			const exited = pty.status === "exited";
			newTabs.set(ptyId, { ptyId, title, exited });
			// Initialize scrollback for this tab
			if (!scrollbackBuffers.has(ptyId)) {
				scrollbackBuffers.set(ptyId, []);
			}
		}
	}

	// Remove tabs no longer on server
	for (const [id] of newTabs) {
		if (!serverIds.has(id)) {
			newTabs.delete(id);
			scrollbackBuffers.delete(id);
			outputListeners.delete(id);
		}
	}

	terminalState.tabs = newTabs;

	// Set active tab if none set
	if (!terminalState.activeTabId || !newTabs.has(terminalState.activeTabId)) {
		const firstId = newTabs.keys().next().value;
		terminalState.activeTabId = firstId ?? null;
	}
}

export function handlePtyCreated(
	msg: Extract<RelayMessage, { type: "pty_created" }>,
): void {
	const { pty } = msg;
	const ptyId = pty?.id;

	if (!ptyId) return;

	// Dedup: the relay broadcasts pty_created directly AND OpenCode fires a
	// pty.created SSE event that also gets translated + broadcast. Without this
	// guard the second arrival regenerates the title (e.g. "Terminal 1" → "Terminal 2")
	// because generateTabTitle() sees the first title as already taken.
	if (terminalState.tabs.has(ptyId)) return;

	// Clear pending state
	terminalState.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	terminalState.statusMessage = null;

	// Generate sequential tab title
	const title = generateTabTitle();

	// Add tab
	const newTabs = new Map(terminalState.tabs);
	newTabs.set(ptyId, { ptyId, title, exited: false });
	terminalState.tabs = newTabs;
	terminalState.activeTabId = ptyId;
	terminalState.panelOpen = true;

	// Initialize scrollback (don't overwrite if output arrived before pty_created)
	if (!scrollbackBuffers.has(ptyId)) {
		scrollbackBuffers.set(ptyId, []);
	}
}

export function handlePtyOutput(
	msg: Extract<RelayMessage, { type: "pty_output" }>,
): void {
	const { ptyId, data } = msg;
	if (!ptyId || typeof data !== "string") return;

	// Append to scrollback buffer (trim if over limit)
	let buffer = scrollbackBuffers.get(ptyId);
	if (!buffer) {
		buffer = [];
		scrollbackBuffers.set(ptyId, buffer);
	}
	buffer.push(data);

	// Trim buffer if over max bytes
	let totalBytes = 0;
	for (const chunk of buffer) totalBytes += chunk.length;
	while (totalBytes > SCROLLBACK_MAX_BYTES && buffer.length > 1) {
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const removed = buffer.shift()!;
		totalBytes -= removed.length;
	}

	// Emit to listeners (bypasses Svelte reactivity)
	const listeners = outputListeners.get(ptyId);
	if (listeners) {
		for (const cb of listeners) {
			cb(data);
		}
	}
}

export function handlePtyExited(
	msg: Extract<RelayMessage, { type: "pty_exited" }>,
): void {
	const { ptyId } = msg;
	if (!ptyId) return;

	const newTabs = new Map(terminalState.tabs);
	const tab = newTabs.get(ptyId);
	if (tab) {
		newTabs.set(ptyId, { ...tab, exited: true });
		terminalState.tabs = newTabs;
	}
}

export function handlePtyDeleted(
	msg: Extract<RelayMessage, { type: "pty_deleted" }>,
): void {
	const { ptyId } = msg;
	if (!ptyId) return;

	const newTabs = new Map(terminalState.tabs);
	newTabs.delete(ptyId);
	terminalState.tabs = newTabs;

	// Clean up scrollback and listeners
	scrollbackBuffers.delete(ptyId);
	outputListeners.delete(ptyId);

	// Switch to another tab if the deleted one was active
	if (terminalState.activeTabId === ptyId) {
		const remaining = Array.from(newTabs.keys());
		terminalState.activeTabId =
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			remaining.length > 0 ? remaining[remaining.length - 1]! : null;
	}

	// Close panel if no tabs left
	if (newTabs.size === 0) {
		terminalState.panelOpen = false;
	}
}

export function handlePtyError(
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	terminalState.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	const errorText = msg.message || "Terminal creation failed";
	terminalState.statusMessage = errorText;
	setTimeout(() => {
		terminalState.statusMessage = null;
	}, STATUS_MESSAGE_MS);
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Request a new terminal tab (sends pty_create). */
export function requestCreateTab(
	sendFn: (data: Record<string, unknown>) => void,
): void {
	if (terminalState.pendingCreate) return;
	if (terminalState.tabs.size >= terminalState.maxTabs) return;

	terminalState.pendingCreate = true;
	terminalState.statusMessage = "Creating terminal...";
	sendFn({ type: "pty_create" });

	// Timeout for creation
	pendingCreateTimer = setTimeout(() => {
		if (terminalState.pendingCreate) {
			terminalState.pendingCreate = false;
			terminalState.statusMessage = "Terminal creation timed out";
			setTimeout(() => {
				terminalState.statusMessage = null;
			}, STATUS_MESSAGE_MS);
		}
	}, PENDING_CREATE_TIMEOUT_MS);
}

/** Close a terminal tab (sends pty_close). */
export function requestCloseTab(
	ptyId: string,
	sendFn: (data: Record<string, unknown>) => void,
): void {
	sendFn({ type: "pty_close", ptyId });
	// Optimistic removal
	handlePtyDeleted({ type: "pty_deleted", ptyId });
}

/** Switch to a different tab. */
export function switchTab(ptyId: string): void {
	if (terminalState.tabs.has(ptyId)) {
		terminalState.activeTabId = ptyId;
	}
}

/** Rename a tab. */
export function renameTab(ptyId: string, title: string): void {
	const newTabs = new Map(terminalState.tabs);
	const tab = newTabs.get(ptyId);
	if (tab) {
		newTabs.set(ptyId, { ...tab, title });
		terminalState.tabs = newTabs;
	}
}

/**
 * Toggle terminal panel open/closed.
 * When opening with no tabs, auto-creates a terminal (like claude-relay).
 * Requires a sendFn to send pty_create if needed.
 */
export function togglePanel(
	sendFn?: (data: Record<string, unknown>) => void,
): void {
	if (terminalState.panelOpen) {
		terminalState.panelOpen = false;
	} else {
		terminalState.panelOpen = true;
		// Auto-create a terminal if no tabs exist
		if (terminalState.tabs.size === 0 && sendFn) {
			requestCreateTab(sendFn);
		}
	}
}

/** Open the terminal panel. */
export function openPanel(): void {
	terminalState.panelOpen = true;
}

/** Close the terminal panel. */
export function closePanel(): void {
	terminalState.panelOpen = false;
}

/**
 * Get the total scrollback size in bytes for a given PTY.
 * Useful for monitoring buffer usage.
 */
export function getScrollbackSize(ptyId: string): number {
	const buffer = scrollbackBuffers.get(ptyId);
	if (!buffer) return 0;
	let total = 0;
	for (const chunk of buffer) total += chunk.length;
	return total;
}

/** Clean up all terminal state (on disconnect or destroy). */
export function destroyAll(): void {
	terminalState.tabs = new Map();
	terminalState.activeTabId = null;
	terminalState.panelOpen = false;
	terminalState.pendingCreate = false;
	terminalState.statusMessage = null;
	scrollbackBuffers.clear();
	outputListeners.clear();
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
}
