// Component-level RPC reply and project-attachment subscriptions.

import type {
	GetFileContentResponse,
	GetFileListResponse,
} from "../transport/ws-rpc.js";

/** File-browser RPC replies, fanned out to the panels that rendered the request. */
export type FileBrowserReply =
	| { readonly kind: "list"; readonly response: GetFileListResponse }
	| { readonly kind: "content"; readonly response: GetFileContentResponse };
export type FileBrowserListener = (reply: FileBrowserReply) => void;

export const fileBrowserListeners = new Set<FileBrowserListener>();
export const projectAttachedListeners = new Set<(slug: string) => void>();

/** Runs synchronously when an RPC reply attaches this tab to a project. */
export function onProjectAttached(fn: (slug: string) => void): () => void {
	projectAttachedListeners.add(fn);
	return () => projectAttachedListeners.delete(fn);
}

/** Subscribe to file browser RPC replies. Returns unsubscribe function. */
export function onFileBrowser(fn: FileBrowserListener): () => void {
	fileBrowserListeners.add(fn);
	return () => fileBrowserListeners.delete(fn);
}

export function applyGetFileListResponse(response: GetFileListResponse): void {
	for (const fn of fileBrowserListeners) fn({ kind: "list", response });
}

export function applyGetFileContentResponse(
	response: GetFileContentResponse,
): void {
	for (const fn of fileBrowserListeners) fn({ kind: "content", response });
}
