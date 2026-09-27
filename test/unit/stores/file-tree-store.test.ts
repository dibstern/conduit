// ─── File Tree Store Tests ───────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildMentionInsertion,
	extractAtQuery,
	fileTreeState,
	filterFiles,
	handleFileTree,
} from "../../../src/lib/frontend/stores/file-tree.svelte.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	fileTreeState.entries = [];
	fileTreeState.loading = false;
	fileTreeState.loaded = false;
});

// ─── extractAtQuery ─────────────────────────────────────────────────────────

describe("extractAtQuery", () => {
	it("extracts query after @ at start of text", () => {
		const result = extractAtQuery("@src/ut", 7);
		expect(result).toEqual({ query: "src/ut", start: 0, end: 7 });
	});

	it("extracts query after @ preceded by space", () => {
		const result = extractAtQuery("explain @src/auth", 17);
		expect(result).toEqual({ query: "src/auth", start: 8, end: 17 });
	});

	it("returns null when no @ found", () => {
		expect(extractAtQuery("no at here", 10)).toBeNull();
	});

	it("returns null for @ in the middle of a word", () => {
		expect(extractAtQuery("email@example.com", 17)).toBeNull();
	});

	it("returns empty query for bare @ at start", () => {
		const result = extractAtQuery("@", 1);
		expect(result).toEqual({ query: "", start: 0, end: 1 });
	});

	it("returns empty query for @ after space", () => {
		const result = extractAtQuery("hello @", 7);
		expect(result).toEqual({ query: "", start: 6, end: 7 });
	});

	it("extracts query when cursor is mid-text with more after", () => {
		const result = extractAtQuery("explain @src/au and then more", 15);
		expect(result).toEqual({ query: "src/au", start: 8, end: 15 });
	});

	it("returns null when @ is followed by a space (already completed)", () => {
		expect(extractAtQuery("explain @src/auth.ts more text", 29)).toBeNull();
	});

	it("handles newlines as whitespace before @", () => {
		const result = extractAtQuery("line one\n@file", 14);
		expect(result).toEqual({ query: "file", start: 9, end: 14 });
	});
});

// ─── filterFiles ────────────────────────────────────────────────────────────

describe("filterFiles", () => {
	const entries = [
		"src/lib/server.ts",
		"src/lib/frontend/App.svelte",
		"src/lib/frontend/stores/chat.svelte.ts",
		"src/lib/frontend/stores/discovery.svelte.ts",
		"src/lib/frontend/utils/format.ts",
		"src/lib/handlers/files.ts",
		"test/unit/prompts.test.ts",
		"package.json",
		"src/lib/frontend/",
		"src/lib/handlers/",
	];

	it("returns all entries for empty query (limited to 20)", () => {
		expect(filterFiles(entries, "")).toEqual(entries);
	});

	it("filters by case-insensitive substring match on path", () => {
		const result = filterFiles(entries, "handler");
		expect(result).toContain("src/lib/handlers/files.ts");
		expect(result).toContain("src/lib/handlers/");
	});

	it("matches basename (filename portion)", () => {
		const result = filterFiles(entries, "format");
		expect(result).toContain("src/lib/frontend/utils/format.ts");
	});

	it("returns empty for no match", () => {
		expect(filterFiles(entries, "zzzzzzz")).toHaveLength(0);
	});

	it("limits results to 20", () => {
		const manyEntries = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
		expect(filterFiles(manyEntries, "file").length).toBeLessThanOrEqual(20);
	});

	it("prioritizes basename matches over path-only matches", () => {
		const result = filterFiles(entries, "files");
		expect(result[0]).toBe("src/lib/handlers/files.ts");
	});

	it("matches directories", () => {
		const result = filterFiles(entries, "frontend/");
		expect(result).toContain("src/lib/frontend/");
	});
});

// ─── handleFileTree ─────────────────────────────────────────────────────────

describe("handleFileTree", () => {
	it("populates entries and sets loaded", () => {
		handleFileTree({
			type: "file_tree" as const,
			entries: ["a.ts", "b.ts", "src/"],
		});
		expect(fileTreeState.entries).toEqual(["a.ts", "b.ts", "src/"]);
		expect(fileTreeState.loaded).toBe(true);
		expect(fileTreeState.loading).toBe(false);
	});

	it("ignores non-array entries", () => {
		handleFileTree({ type: "file_tree" as const, entries: "bad" as unknown });
		expect(fileTreeState.entries).toHaveLength(0);
	});
});

// ─── buildMentionInsertion ──────────────────────────────────────────────────

describe("buildMentionInsertion", () => {
	it("closes the mention with a trailing space for a file", () => {
		expect(buildMentionInsertion("src/main.ts")).toBe("@src/main.ts ");
	});

	it("withholds the trailing space for a directory", () => {
		expect(buildMentionInsertion("src/lib/")).toBe("@src/lib/");
	});

	// The round-trip is the actual contract: whether the menu stays open after a
	// selection is decided entirely by whether extractAtQuery still finds a token.
	it("leaves the @-token live after a directory, so the menu keeps drilling", () => {
		const text = buildMentionInsertion("src/lib/");
		const query = extractAtQuery(text, text.length);
		expect(query?.query).toBe("src/lib/");
	});

	it("ends the @-token after a file, so the menu closes", () => {
		const text = buildMentionInsertion("src/main.ts");
		expect(extractAtQuery(text, text.length)).toBeNull();
	});

	it("ends the @-token when the user types a space to finish a path", () => {
		const text = `${buildMentionInsertion("src/lib/")} `;
		expect(extractAtQuery(text, text.length)).toBeNull();
	});

	it("preserves drill-down when the mention follows existing text", () => {
		const text = `look at ${buildMentionInsertion("src/lib/")}`;
		const query = extractAtQuery(text, text.length);
		expect(query?.query).toBe("src/lib/");
		expect(text.slice(query?.start)).toBe("@src/lib/");
	});
});
