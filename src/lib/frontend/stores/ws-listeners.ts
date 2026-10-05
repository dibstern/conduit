// Extracted from ws.svelte.ts — component-level message subscriptions.
// Some messages are best handled by the component that renders them,
// rather than stored globally. Components subscribe via these registries.

import type {
	GetFileContentResponse,
	GetFileListResponse,
} from "../transport/ws-rpc.js";
import type { RelayMessage } from "../types.js";

export type MessageListener = (msg: RelayMessage) => void;

/** File-browser RPC replies, fanned out to the panels that rendered the request. */
export type FileBrowserReply =
	| { readonly kind: "list"; readonly response: GetFileListResponse }
	| { readonly kind: "content"; readonly response: GetFileContentResponse };
export type FileBrowserListener = (reply: FileBrowserReply) => void;

export const fileBrowserListeners = new Set<FileBrowserListener>();
export const projectListeners = new Set<MessageListener>();
export const projectAttachedListeners = new Set<(slug: string) => void>();

/** Runs synchronously before the attached relay's bootstrap is dispatched. */
export function onProjectAttached(fn: (slug: string) => void): () => void {
	projectAttachedListeners.add(fn);
	return () => projectAttachedListeners.delete(fn);
}

/** Subscribe to file browser RPC replies. Returns unsubscribe function. */
export function onFileBrowser(fn: FileBrowserListener): () => void {
	fileBrowserListeners.add(fn);
	return () => fileBrowserListeners.delete(fn);
}

/** Subscribe to project messages. Returns unsubscribe function. */
export function onProject(fn: MessageListener): () => void {
	projectListeners.add(fn);
	return () => projectListeners.delete(fn);
}
