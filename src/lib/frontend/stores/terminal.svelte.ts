// Terminal tabs, PTY state, scrollback buffers, fed by the project's
// SubscribePtys stream (conduit-test-ni8.11).
// Uses callback pattern for high-throughput PTY output (not reactive).

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { SvelteMap } from "svelte/reactivity";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { PtyEnvelope } from "../transport/ws-rpc.js";
import type { Immutable, TabEntry } from "../types.js";
import { STATUS_MESSAGE_MS } from "../ui-constants.js";

const SCROLLBACK_MAX_BYTES = 50 * 1024; // 50 KB per tab
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const DEFAULT_MAX_TABS = 10;
const PENDING_CREATE_TIMEOUT_MS = 15_000;

// The PTYs the server has told us about, keyed by id. The `handlePty*`
// functions below are the only writers.

const serverPtys = new SvelteMap<string, { ptyId: string; exited: boolean }>();

// Which terminal this browser tab is looking at, and what it calls each one.
// The server does send a PTY title — the command it ran — but the label in the
// tab strip has always been ours: "Terminal N", minted on first sight and
// editable with `renameTab`. Applying a PTY row never touches a label or the
// selection.

const tabTitles = new SvelteMap<string, string>();

const clientTerminal = $state({
	activeTabId: null as string | null,
	panelOpen: false,
	/** One badge count per PTY that emitted output while the panel was closed. */
	unreadPtyIds: new Set<string>(),
	pendingCreate: false,
	statusMessage: null as string | null,
});

/** Read view over both halves. The server half is readable but has no setter:
 *  write it by applying a PTY envelope. */
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
	get unreadPtyIds(): ReadonlySet<string> {
		return clientTerminal.unreadPtyIds;
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

// Non-reactive state (high-throughput PTY data)

const scrollbackBuffers = new Map<string, string[]>();
const outputListeners = new Map<
	string,
	Set<(data: string, replace?: boolean) => void>
>();
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
	let terminalNumber = 1;
	while (used.has(terminalNumber)) terminalNumber++;
	return `Terminal ${terminalNumber}`;
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

// Output subscription (callback pattern)

/**
 * Subscribe to output for a specific PTY. Returns an unsubscribe function.
 * This bypasses Svelte reactivity for performance — terminal output can be
 * very high-throughput and shouldn't trigger re-renders on every chunk.
 */
export function onOutput(
	ptyId: string,
	cb: (data: string, replace?: boolean) => void,
): () => void {
	let listeners = outputListeners.get(ptyId);
	if (!listeners) {
		listeners = new Set();
		outputListeners.set(ptyId, listeners);
	}
	listeners.add(cb);

	return () => {
		listeners.delete(cb);
		if (listeners.size === 0) {
			outputListeners.delete(ptyId);
		}
	};
}

/** Get scrollback buffer for replay on mount. This is the store's own array,
 *  not a copy — the caller replays it, it does not get to edit it. */
export function getScrollback(ptyId: string): readonly string[] {
	return scrollbackBuffers.get(ptyId) ?? [];
}

type PtyRows = Extract<PtyEnvelope, { _tag: "snapshot" }>["rows"];
type PtyUpsert = Extract<PtyEnvelope, { _tag: "upsert" }>;
type PtyOutput = Extract<PtyEnvelope, { _tag: "output" }>;
type PtyRemove = Extract<PtyEnvelope, { _tag: "remove" }>;

/** A snapshot: sync the tabs with the server's PTYs and restore each ring. */
export function handlePtySnapshot(rows: PtyRows): void {
	const serverIds = new Set(rows.map(({ pty }) => pty.id));
	for (const id of [...serverPtys.keys()]) {
		if (!serverIds.has(id)) forgetPty(id);
	}
	for (const { pty, scrollback } of rows) {
		rememberPty(pty.id, pty.status === "exited");
		// Replayed history, not new output: it restores the ring, unread stays.
		writeOutput(pty.id, scrollback, true);
	}

	if ([...clientTerminal.unreadPtyIds].some((id) => !serverIds.has(id))) {
		clientTerminal.unreadPtyIds = new Set(
			[...clientTerminal.unreadPtyIds].filter((id) => serverIds.has(id)),
		);
	}
	// Set active tab if none set
	const active = clientTerminal.activeTabId;
	if (!active || !serverPtys.has(active)) {
		clientTerminal.activeTabId = serverPtys.keys().next().value ?? null;
	}
}

/** A PTY appeared or changed status. A new one becomes the active tab. */
export function handlePtyUpsert({ item: pty }: PtyUpsert): void {
	const exited = pty.status === "exited";
	if (serverPtys.has(pty.id)) {
		serverPtys.set(pty.id, { ptyId: pty.id, exited });
		return;
	}

	// Clear pending state
	clientTerminal.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	clientTerminal.statusMessage = null;

	rememberPty(pty.id, exited);
	clientTerminal.activeTabId = pty.id;
	// Visibility stays with whoever opened the panel. The confirmation can land
	// after the user has switched away, or come from another browser, and must
	// not pull the terminal back over the view they chose.
}

export function handlePtyOutput({ ptyId, data, replace }: PtyOutput): void {
	if (!clientTerminal.panelOpen && !clientTerminal.unreadPtyIds.has(ptyId)) {
		clientTerminal.unreadPtyIds = new Set([
			...clientTerminal.unreadPtyIds,
			ptyId,
		]);
	}
	writeOutput(ptyId, data, replace === true);
}

function writeOutput(ptyId: string, data: string, replace: boolean): void {
	// A host snapshot replaces this browser's previous history on reconnect.
	let buffer = scrollbackBuffers.get(ptyId);
	if (!buffer) {
		buffer = [];
		scrollbackBuffers.set(ptyId, buffer);
	}
	if (replace) buffer.length = 0;
	if (data || !replace) buffer.push(data);

	// Retain the newest bytes, including a partial oldest chunk.
	let totalBytes = 0;
	for (const chunk of buffer) totalBytes += textEncoder.encode(chunk).length;
	while (totalBytes > SCROLLBACK_MAX_BYTES) {
		const chunk = buffer[0];
		if (chunk === undefined) break;
		const bytes = textEncoder.encode(chunk);
		const excess = totalBytes - SCROLLBACK_MAX_BYTES;
		if (bytes.length <= excess) {
			buffer.shift();
			totalBytes -= bytes.length;
			continue;
		}
		let offset = excess;
		while (offset < bytes.length) {
			const byte = bytes[offset];
			if (byte === undefined || (byte & 0xc0) !== 0x80) break;
			offset++;
		}
		if (offset === bytes.length) buffer.shift();
		else buffer[0] = textDecoder.decode(bytes.subarray(offset));
		totalBytes -= offset;
	}

	// Emit to listeners (bypasses Svelte reactivity)
	const listeners = outputListeners.get(ptyId);
	if (listeners) {
		for (const cb of listeners) {
			if (replace) cb(data, true);
			else cb(data);
		}
	}
}

export function handlePtyRemove({ id: ptyId }: Pick<PtyRemove, "id">): void {
	forgetPty(ptyId);
	if (clientTerminal.unreadPtyIds.has(ptyId)) {
		const unread = new Set(clientTerminal.unreadPtyIds);
		unread.delete(ptyId);
		clientTerminal.unreadPtyIds = unread;
	}

	// Switch to another tab if the deleted one was active
	if (clientTerminal.activeTabId === ptyId) {
		const remaining = [...serverPtys.keys()];
		clientTerminal.activeTabId = remaining.at(-1) ?? null;
	}

	// Close panel if no tabs left
	if (serverPtys.size === 0) {
		clientTerminal.panelOpen = false;
	}
}

export function applyPtyEnvelope(envelope: PtyEnvelope): void {
	switch (envelope._tag) {
		case "snapshot":
			handlePtySnapshot(envelope.rows);
			return;
		case "upsert":
			handlePtyUpsert(envelope);
			return;
		case "output":
			handlePtyOutput(envelope);
			return;
		case "remove":
			handlePtyRemove(envelope);
			return;
		case "synchronized":
			return;
	}
}

let viewedProject: string | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/**
 * Follow `project`'s terminals: subscribe for that project (an explicit
 * argument; PTYs belong to the project, not a session) until the view moves.
 * `null` stops following. Every (re)subscribe opens with a full snapshot.
 */
export function viewPtys(project: string | null): void {
	if (viewedProject === project) return;
	viewedProject = project;
	const currentGeneration = ++generation;
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || !project) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.ptys()),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration === generation)
										applyPtyEnvelope(envelope);
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}

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
	clientTerminal.pendingCreate = false;
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
	clientTerminal.statusMessage = message || "Terminal creation failed";
	setTimeout(() => {
		clientTerminal.statusMessage = null;
	}, STATUS_MESSAGE_MS);
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
	if (clientTerminal.panelOpen) clientTerminal.unreadPtyIds = new Set();
}

/** Open the terminal panel. */
export function openPanel(): void {
	clientTerminal.panelOpen = true;
	clientTerminal.unreadPtyIds = new Set();
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
	for (const chunk of buffer) total += textEncoder.encode(chunk).length;
	return total;
}

/** Clean up all terminal state (on disconnect or destroy). */
export function destroyAll(): void {
	for (const id of [...serverPtys.keys()]) forgetPty(id);
	clientTerminal.activeTabId = null;
	clientTerminal.panelOpen = false;
	clientTerminal.pendingCreate = false;
	clientTerminal.statusMessage = null;
	clientTerminal.unreadPtyIds = new Set();
	scrollbackBuffers.clear();
	outputListeners.clear();
	if (pendingCreateTimer !== null) {
		clearTimeout(pendingCreateTimer);
		pendingCreateTimer = null;
	}
}
