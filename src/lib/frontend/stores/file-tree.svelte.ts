// ─── File Tree Store ─────────────────────────────────────────────────────────
// Background-preloaded file tree for @ autocomplete.
// Pure filtering functions + reactive state.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AtQuery {
	query: string;
	start: number;
	end: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

export const fileTreeState = $state({
	entries: [] as string[],
	loading: false,
	loaded: false,
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

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
 * Filter file entries by query string.
 * Case-insensitive substring match on full path and basename.
 * Basename matches are prioritized. Limited to 20 results.
 */
export function filterFiles(entries: string[], query: string): string[] {
	if (!query) return entries.slice(0, 20);

	const lower = query.toLowerCase();

	type Scored = { entry: string; basenameMatch: boolean };
	const matches: Scored[] = [];

	for (const entry of entries) {
		const entryLower = entry.toLowerCase();
		if (!entryLower.includes(lower)) continue;

		const lastSlash = entry.lastIndexOf(
			"/",
			entry.endsWith("/") ? entry.length - 2 : entry.length,
		);
		const basename = entry.slice(lastSlash + 1).toLowerCase();
		const basenameMatch = basename.includes(lower);

		matches.push({ entry, basenameMatch });
	}

	matches.sort((a, b) => {
		if (a.basenameMatch !== b.basenameMatch) {
			return a.basenameMatch ? -1 : 1;
		}
		return a.entry.localeCompare(b.entry);
	});

	return matches.slice(0, 20).map((m) => m.entry);
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleFileTree(msg: {
	type: "file_tree";
	entries: unknown;
}): void {
	if (Array.isArray(msg.entries)) {
		fileTreeState.entries = msg.entries;
		fileTreeState.loaded = true;
		fileTreeState.loading = false;
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

export function requestFileTree(): void {
	fileTreeState.loading = true;
}

/** Clear file tree state (for project switch). */
export function clearFileTreeState(): void {
	fileTreeState.entries = [];
	fileTreeState.loading = false;
	fileTreeState.loaded = false;
}
