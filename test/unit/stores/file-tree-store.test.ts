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
		expect(filterFiles(entries, "").entries).toEqual(entries);
	});

	it("filters by case-insensitive substring match on path", () => {
		const result = filterFiles(entries, "handler").entries;
		expect(result).toContain("src/lib/handlers/files.ts");
		expect(result).toContain("src/lib/handlers/");
	});

	it("matches basename (filename portion)", () => {
		const result = filterFiles(entries, "format").entries;
		expect(result).toContain("src/lib/frontend/utils/format.ts");
	});

	it("returns empty for no match", () => {
		expect(filterFiles(entries, "zzzzzzz").entries).toHaveLength(0);
	});

	it("limits results to 20", () => {
		const manyEntries = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
		expect(filterFiles(manyEntries, "file").entries.length).toBeLessThanOrEqual(
			20,
		);
	});

	it("prioritizes basename matches over path-only matches", () => {
		const result = filterFiles(entries, "files").entries;
		expect(result[0]).toBe("src/lib/handlers/files.ts");
	});

	it("matches directories", () => {
		const result = filterFiles(entries, "frontend/").entries;
		expect(result).toContain("src/lib/frontend/");
	});

	it("puts immediate children before deeper descendants and reports their boundary", () => {
		const result = filterFiles(
			["src/lib/util.ts", "src/main.ts", "src/lib/", "src/lib/nested/deep.ts"],
			"src/",
		);

		expect(result).toEqual({
			entries: [
				"src/lib/",
				"src/main.ts",
				"src/lib/nested/deep.ts",
				"src/lib/util.ts",
			],
			dividerAt: 2,
		});
	});

	it("does not include the queried directory in its own listing", () => {
		const result = filterFiles(["src/", "src/lib/", "src/main.ts"], "src/");

		expect(result.entries).toEqual(["src/lib/", "src/main.ts"]);
		expect(result.entries).not.toContain("src/");
		expect(result.dividerAt).toBe(2);
	});

	it("ranks basename matches then locale order within each directory group", () => {
		const result = filterFiles(
			[
				"src/zeta.ts",
				"src/deep/zeta.ts",
				"other/src/zeta.ts",
				"src/alpha.ts",
				"vendor/src/",
				"src/deep/alpha.ts",
			],
			"src/",
		);

		expect(result).toEqual({
			entries: [
				"src/alpha.ts",
				"src/zeta.ts",
				"vendor/src/",
				"other/src/zeta.ts",
				"src/deep/alpha.ts",
				"src/deep/zeta.ts",
			],
			dividerAt: 2,
		});
	});

	it("uses the 12 immediate and 8 deeper cap when both groups are plentiful", () => {
		const immediate = Array.from(
			{ length: 15 },
			(_, index) => `src/immediate-${index.toString().padStart(2, "0")}.ts`,
		);
		const deeper = Array.from(
			{ length: 15 },
			(_, index) =>
				`src/deep/descendant-${index.toString().padStart(2, "0")}.ts`,
		);

		const exactBoundary = filterFiles(
			[...immediate.slice(0, 12), ...deeper.slice(0, 8)],
			"src/",
		);
		expect(exactBoundary.entries).toEqual([
			...immediate.slice(0, 12),
			...deeper.slice(0, 8),
		]);
		expect(exactBoundary.dividerAt).toBe(12);

		const capped = filterFiles([...immediate, ...deeper], "src/");
		expect(capped.entries).toEqual([
			...immediate.slice(0, 12),
			...deeper.slice(0, 8),
		]);
		expect(capped.dividerAt).toBe(12);
	});

	it("lets deeper descendants fill unused immediate-child slots", () => {
		const immediate = Array.from(
			{ length: 3 },
			(_, index) => `src/immediate-${index}.ts`,
		);
		const deeper = Array.from(
			{ length: 30 },
			(_, index) =>
				`src/deep/descendant-${index.toString().padStart(2, "0")}.ts`,
		);

		const result = filterFiles([...immediate, ...deeper], "src/");

		expect(result.entries).toEqual([...immediate, ...deeper.slice(0, 17)]);
		expect(result.dividerAt).toBe(3);
	});

	it("lets immediate children fill slots unavailable to deeper descendants", () => {
		const immediate = Array.from(
			{ length: 30 },
			(_, index) => `src/immediate-${index.toString().padStart(2, "0")}.ts`,
		);
		const deeper = Array.from(
			{ length: 3 },
			(_, index) => `src/deep/descendant-${index}.ts`,
		);

		const result = filterFiles([...immediate, ...deeper], "src/");

		expect(result.entries).toEqual([...immediate.slice(0, 17), ...deeper]);
		expect(result.dividerAt).toBe(17);
	});

	// The 12/8 reservation only ever gives a group fewer slots than it wants when the
	// *other* group is non-empty, so an empty group is the one case where the
	// reservation must vanish entirely rather than merely shrink. Both outcomes also
	// land on a `dividerAt` that suppresses the divider (`0` and `entries.length`),
	// which is what makes getting them wrong quiet — a stray divider or a short list,
	// with no error anywhere.
	it("gives the whole cap to whichever group is the only one populated", () => {
		const immediateOnly = Array.from(
			{ length: 21 },
			(_, index) => `src/immediate-${index.toString().padStart(2, "0")}.ts`,
		);
		const allImmediate = filterFiles(immediateOnly, "src/");
		expect(allImmediate.entries).toEqual(immediateOnly.slice(0, 20));
		expect(allImmediate.dividerAt).toBe(20);

		const deeperOnly = Array.from(
			{ length: 21 },
			(_, index) =>
				`src/deep/descendant-${index.toString().padStart(2, "0")}.ts`,
		);
		const allDeeper = filterFiles(deeperOnly, "src/");
		expect(allDeeper.entries).toEqual(deeperOnly.slice(0, 20));
		expect(allDeeper.dividerAt).toBe(0);
	});

	it("reports no grouping boundary for empty and non-directory queries", () => {
		expect(filterFiles(entries, "").dividerAt).toBe(0);
		expect(filterFiles(entries, "frontend").dividerAt).toBe(0);
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
