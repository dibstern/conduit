// ─── WebSocket Listener Registries ───────────────────────────────────────────
// Extracted from ws.svelte.ts — component-level message subscriptions.
// Some messages are best handled by the component that renders them,
// rather than stored globally. Components subscribe via these registries.

import type { RelayMessage } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageListener = (msg: RelayMessage) => void;

// ─── Listener sets ──────────────────────────────────────────────────────────

export const planModeListeners = new Set<MessageListener>();
export const fileBrowserListeners = new Set<MessageListener>();
export const fileHistoryListeners = new Set<MessageListener>();
export const rewindListeners = new Set<MessageListener>();
export const projectListeners = new Set<MessageListener>();
export const directoryListeners = new Set<MessageListener>();

// ─── Subscription functions ─────────────────────────────────────────────────

/** Subscribe to plan mode messages. Returns unsubscribe function. */
export function onPlanMode(fn: MessageListener): () => void {
	planModeListeners.add(fn);
	return () => planModeListeners.delete(fn);
}

/** Subscribe to file browser messages. Returns unsubscribe function. */
export function onFileBrowser(fn: MessageListener): () => void {
	fileBrowserListeners.add(fn);
	return () => fileBrowserListeners.delete(fn);
}

/** Subscribe to file history messages. Returns unsubscribe function. */
export function onFileHistory(fn: MessageListener): () => void {
	fileHistoryListeners.add(fn);
	return () => fileHistoryListeners.delete(fn);
}

/** Subscribe to rewind messages. Returns unsubscribe function. */
export function onRewind(fn: MessageListener): () => void {
	rewindListeners.add(fn);
	return () => rewindListeners.delete(fn);
}

/** Subscribe to project messages. Returns unsubscribe function. */
export function onProject(fn: MessageListener): () => void {
	projectListeners.add(fn);
	return () => projectListeners.delete(fn);
}

/** Subscribe to directory listing messages. Returns unsubscribe function. */
export function onDirectoryList(fn: MessageListener): () => void {
	directoryListeners.add(fn);
	return () => directoryListeners.delete(fn);
}
