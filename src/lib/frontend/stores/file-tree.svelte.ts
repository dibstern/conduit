// Background-preloaded paths for @ autocomplete and file browser position.
// Pure filtering functions + reactive state.

import type { GetFileTreeResponse } from "../transport/ws-rpc.js";
import type { FileEntry } from "../types.js";

export interface AtQuery {
	query: string;
	start: number;
	end: number;
}

export type FilteredFiles = { entries: string[]; dividerAt: number };

// This store has no client half: entries come from `GetFileTree`, and the two
// flags track the request that is fetching them. The @-mention query the user
// is typing lives in the component, not here.

export const fileTreeState = $state({
	/** Project, session and effective folder that own these caches. */
	scope: null as string | null,
	entries: [] as string[],
	roots: [] as NonNullable<GetFileTreeResponse["roots"]>,
	loading: false,
	loaded: false,
	/** File browser position shared by the sidebar and phone session view. */
	browserPath: ".",
	browserEntries: [] as FileEntry[],
	browserChildren: new Map<string, FileEntry[]>(),
	browserCache: new Map<string, FileEntry[]>(),
	browserExpandedPaths: new Set<string>(),
	browserScrollTop: 0,
});

/** Relative paths belong to a folder; legacy single-folder keys stay unchanged. */
export function fileBrowserKey(path: string, root?: string): string {
	return root === undefined ? path : JSON.stringify([root, path]);
}

/**
 * Extract @ query from input text at cursor position.
 * Returns null if no active @ trigger is found.
 * Triggers on @ at start of text or after whitespace.
 */
export function extractAtQuery(
	text: string,
	cursorPos: number,
): AtQuery | null {
	const before = text.slice(0, cursorPos);
	const match = before.match(/(?:^|[\s\n])@(\S*)$/);
	if (!match) return null;

	const query = match[1] ?? "";
	const matchStart = before.length - match[0].length;
	const atStart = match[0].startsWith("@") ? matchStart : matchStart + 1;

	return { query, start: atStart, end: cursorPos };
}

/**
 * Build the replacement text for an @-query once `path` is chosen.
 *
 * This is the inverse of `extractAtQuery`, and the trailing space is the whole
 * contract between them. `extractAtQuery` ends the @-token at whitespace, so:
 *
 * - a file completes the mention and gets the space, closing the token;
 * - a directory withholds it, keeping the token live so the menu stays open and
 *   re-filters against the new prefix — one level of drill-down per selection.
 *
 * Typing a space is therefore how the user declares a path finished, with no
 * separate handling: it terminates the token through the same regex.
 */
export function buildMentionInsertion(path: string): string {
	return path.endsWith("/") ? `@${path}` : `@${path} `;
}

/**
 * Filter file entries by query string.
 * Case-insensitive substring match on full path and basename.
 * Basename matches are prioritized. Limited to 20 results.
 * Directory queries group immediate children before deeper matches.
 */
export function filterFiles(entries: string[], query: string): FilteredFiles {
	if (!query) return { entries: entries.slice(0, 20), dividerAt: 0 };

	const lower = query.toLowerCase();
	const isDirectoryQuery = query.endsWith("/");

	type Scored = { entry: string; basenameMatch: boolean };
	const matches: Scored[] = [];

	for (const entry of entries) {
		const entryLower = entry.toLowerCase();
		if (isDirectoryQuery && entryLower === lower) continue;
		if (!entryLower.includes(lower)) continue;

		const lastSlash = entry.lastIndexOf(
			"/",
			entry.endsWith("/") ? entry.length - 2 : entry.length,
		);
		const basename = entry.slice(lastSlash + 1).toLowerCase();
		const basenameMatch = basename.includes(lower);

		matches.push({ entry, basenameMatch });
	}

	const compareMatches = (a: Scored, b: Scored): number => {
		if (a.basenameMatch !== b.basenameMatch) {
			return a.basenameMatch ? -1 : 1;
		}
		return a.entry.localeCompare(b.entry);
	};

	if (!isDirectoryQuery) {
		matches.sort(compareMatches);
		return {
			entries: matches.slice(0, 20).map((match) => match.entry),
			dividerAt: 0,
		};
	}

	const immediateChildren: Scored[] = [];
	const deeperDescendants: Scored[] = [];
	for (const match of matches) {
		const remainder = match.entry.slice(query.length);
		const pathBelowQuery = remainder.endsWith("/")
			? remainder.slice(0, -1)
			: remainder;
		const group =
			match.entry.toLowerCase().startsWith(lower) &&
			!pathBelowQuery.includes("/")
				? immediateChildren
				: deeperDescendants;
		group.push(match);
	}

	immediateChildren.sort(compareMatches);
	deeperDescendants.sort(compareMatches);

	const reservedDeeperSlots = Math.min(deeperDescendants.length, 8);
	const immediateCount = Math.min(
		immediateChildren.length,
		20 - reservedDeeperSlots,
	);
	const deeperCount = Math.min(deeperDescendants.length, 20 - immediateCount);

	return {
		entries: [
			...immediateChildren.slice(0, immediateCount),
			...deeperDescendants.slice(0, deeperCount),
		].map((match) => match.entry),
		dividerAt: immediateCount,
	};
}

export function applyGetFileTreeResponse(
	response: GetFileTreeResponse,
	scope = fileTreeState.scope,
): void {
	if (scope !== fileTreeState.scope) return;
	fileTreeState.entries = [...response.entries];
	fileTreeState.roots = response.roots ?? [];
	fileTreeState.loaded = true;
	fileTreeState.loading = false;
}

export function requestFileTree(): void {
	fileTreeState.loading = true;
}

/** Clear paths and previews when the project or session workspace changes. */
export function clearFileTreeState(): void {
	fileTreeState.scope = null;
	fileTreeState.entries = [];
	fileTreeState.roots = [];
	fileTreeState.loading = false;
	fileTreeState.loaded = false;
	fileTreeState.browserPath = ".";
	fileTreeState.browserEntries = [];
	fileTreeState.browserChildren = new Map();
	fileTreeState.browserCache = new Map();
	fileTreeState.browserExpandedPaths = new Set();
	fileTreeState.browserScrollTop = 0;
}
