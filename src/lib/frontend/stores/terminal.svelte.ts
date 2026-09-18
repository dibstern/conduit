// ─── Terminal Store ──────────────────────────────────────────────────────────
// Terminal tabs, PTY state, scrollback buffers.
// Uses callback pattern for high-throughput PTY output (not reactive).

import { SvelteMap } from "svelte/reactivity";
import type { PtyListResponse } from "../transport/ws-rpc.js";
import type { Immutable, RelayMessage, TabEntry } from "../types.js";
import { STATUS_MESSAGE_MS } from "../ui-constants.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SCROLLBACK_MAX_BYTES = 50 * 1024; // 50 KB per tab
const DEFAULT_MAX_TABS = 10;
const PENDING_CREATE_TIMEOUT_MS = 15_000;

// ─── Server-owned state ─────────────────────────────────────────────────────
// The PTYs the server has told us about, keyed by id. The `handlePty*`
// functions below are the only writers.

const serverPtys = new SvelteMap<string, { ptyId: string; exited: boolean }>();

// ─── Client-owned state ─────────────────────────────────────────────────────
// Which terminal this browser tab is looking at, and what it calls each one.
// The server does send a PTY title — the command it ran — but the label in the
// tab strip has always been ours: "Terminal N", minted on first sight and
// editable with `renameTab`. Applying a PTY row never touches a label or the
// selection.

const tabTitles = new SvelteMap<string, string>();

const clientTerminal = $state({
	activeTabId: null as string | null,
	panelOpen: false,
	pendingCreate: false,
	statusMessage: null as string | null,
});

/** Read view over both halves. The server half is readable but has no setter:
 *  write it by applying a `pty_*` message. */
export const terminalState = {
	/** Server rows joined to this tab's labels, keyed by pty id. */
	get tabs(): ReadonlyMap<string, Immutable<TabEntry>> {
		return new Map(getTabList().map((tab) => [tab.ptyId, tab]));
	},
	get activeTabId(): string | null {
		return clientTerminal.activeTabId;
	},
	get panelOpen(): boolean {
		return clientTerminal.panelOpen;
	},
	get pendingCreate(): boolean {
		return clientTerminal.pendingCreate;
	},
	get statusMessage(): string | null {
		return clientTerminal.statusMessage;
	},
	get maxTabs(): number {
		return DEFAULT_MAX_TABS;
	},
};

// ─── Non-reactive state (high-throughput PTY data) ──────────────────────────

const scrollbackBuffers = new Map<string, string[]>();
const outputListeners = new Map<string, Set<(data: string) => void>>();
let pendingCreateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mint the next tab label, reusing numbers freed by closed tabs.
 * Derives from the labels in hand — no separate counter to keep in step.
 * E.g. with "Terminal 1" and "Terminal 3" open, the next one is "Terminal 2".
 */
function nextTabTitle(): string {
	const used = new Set<number>();
	for (const title of tabTitles.values()) {
		const match = /^Terminal (\d+)$/.exec(title);
		if (match) used.add(Number(match[1]));
	}
	let n = 1;
	while (used.has(n)) n++;
	return `Terminal ${n}`;
}

/** Record a PTY the server reported, labelling it on first sight. */
function rememberPty(ptyId: string, exited: boolean): void {
	if (!tabTitles.has(ptyId)) tabTitles.set(ptyId, nextTabTitle());
	serverPtys.set(ptyId, { ptyId, exited });
	// Don't overwrite: output can arrive before the row does.
	if (!scrollbackBuffers.has(ptyId)) scrollbackBuffers.set(ptyId, []);
}

/** Drop a PTY and everything this tab kept about it. */
function forgetPty(ptyId: string): void {
	serverPtys.delete(ptyId);
	tabTitles.delete(ptyId);
	scrollbackBuffers.delete(ptyId);
	outputListeners.delete(ptyId);
}

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the number of open terminal tabs. */
export function getTabCount(): number {
	return serverPtys.size;
}

/** Get whether we can create more tabs. */
export function getCanCreateTab(): boolean {
	return !clientTerminal.pendingCreate && serverPtys.size < DEFAULT_MAX_TABS;
}

/** Get the ordered list of tabs for rendering: a server row plus its label. */
export function getTabList(): readonly Immutable<TabEntry>[] {
	return [...serverPtys.values()].map((pty) => ({
		ptyId: pty.ptyId,
		title: tabTitles.get(pty.ptyId) ?? "",
		exited: pty.exited,
	}));
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

/** Get scrollback buffer for replay on mount. This is the store's own array,
 *  not a copy — the caller replays it, it does not get to edit it. */
export function getScrollback(ptyId: string): readonly string[] {
	return scrollbackBuffers.get(ptyId) ?? [];
}

// ─── Message handlers ───────────────────────────────────────────────────────

/** Handle pty_list — sync frontend tabs with server's existing PTYs. */
export function handlePtyList(
	msg: Extract<RelayMessage, { type: "pty_list" }>,
): void {
	const ptys = msg.ptys ?? [];

	if (ptys.length === 0) return;

	const serverIds = new Set<string>();
	for (const pty of ptys) {
		const ptyId = pty.id;
		if (!ptyId) continue;
		serverIds.add(ptyId);
		if (!serverPtys.has(ptyId)) rememberPty(ptyId, pty.status === "exited");
	}

	for (const id of [...serverPtys.keys()]) {
		if (!serverIds.has(id)) forgetPty(id);
	}

	// Set active tab if none set
	const active = clientTerminal.activeTabId;
	if (!active || !serverPtys.has(active)) {
		clientTerminal.activeTabId = serverPtys.keys().next().value ?? null;
	}
}

export function applyPtyListResponse(response: PtyListResponse): void {
	handlePtyList({
		type: "pty_list",
		ptys: response.ptys.map((pty) => ({
			id: pty.id,
			title: pty.title,
			command: pty.command,
			cwd: pty.cwd,
			status: pty.status,
			pid: pty.pid,
		})),
	});
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
	if (serverPtys.has(ptyId)) return;

	// Clear pending state
	clientTerminal.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	clientTerminal.statusMessage = null;

	rememberPty(ptyId, false);
	clientTerminal.activeTabId = ptyId;
	clientTerminal.panelOpen = true;
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

	if (serverPtys.has(ptyId)) serverPtys.set(ptyId, { ptyId, exited: true });
}

export function handlePtyDeleted(
	msg: Extract<RelayMessage, { type: "pty_deleted" }>,
): void {
	const { ptyId } = msg;
	if (!ptyId) return;

	forgetPty(ptyId);

	// Switch to another tab if the deleted one was active
	if (clientTerminal.activeTabId === ptyId) {
		const remaining = [...serverPtys.keys()];
		clientTerminal.activeTabId =
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			remaining.length > 0 ? remaining[remaining.length - 1]! : null;
	}

	// Close panel if no tabs left
	if (serverPtys.size === 0) {
		clientTerminal.panelOpen = false;
	}
}

export function handlePtyError(
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	clientTerminal.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	clientTerminal.statusMessage = msg.message || "Terminal creation failed";
	setTimeout(() => {
		clientTerminal.statusMessage = null;
	}, STATUS_MESSAGE_MS);
}

// ─── Actions ────────────────────────────────────────────────────────────────

export function beginCreateTab(): boolean {
	if (!getCanCreateTab()) return false;

	clientTerminal.pendingCreate = true;
	clientTerminal.statusMessage = "Creating terminal...";

	pendingCreateTimer = setTimeout(() => {
		if (clientTerminal.pendingCreate) {
			clientTerminal.pendingCreate = false;
			clientTerminal.statusMessage = "Terminal creation timed out";
			setTimeout(() => {
				clientTerminal.statusMessage = null;
			}, STATUS_MESSAGE_MS);
		}
	}, PENDING_CREATE_TIMEOUT_MS);

	return true;
}

export function failCreateTab(message = "Terminal creation failed"): void {
	handlePtyError({
		type: "error",
		sessionId: "",
		code: "PTY_CREATE_FAILED",
		message,
	});
}

/** Switch to a different tab. */
export function switchTab(ptyId: string): void {
	if (serverPtys.has(ptyId)) clientTerminal.activeTabId = ptyId;
}

/** Rename a tab. The label is this tab's, so nothing is sent to the server. */
export function renameTab(ptyId: string, title: string): void {
	if (serverPtys.has(ptyId)) tabTitles.set(ptyId, title);
}

/**
 * Toggle terminal panel open/closed.
 */
export function togglePanel(): void {
	clientTerminal.panelOpen = !clientTerminal.panelOpen;
}

/** Open the terminal panel. */
export function openPanel(): void {
	clientTerminal.panelOpen = true;
}

/** Close the terminal panel. */
export function closePanel(): void {
	clientTerminal.panelOpen = false;
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
	for (const id of [...serverPtys.keys()]) forgetPty(id);
	clientTerminal.activeTabId = null;
	clientTerminal.panelOpen = false;
	clientTerminal.pendingCreate = false;
	clientTerminal.statusMessage = null;
	scrollbackBuffers.clear();
	outputListeners.clear();
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
}
