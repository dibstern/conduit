import { beforeEach, describe, expect, it } from "vitest";
import {
	applyGetFileTreeResponse,
	buildMentionInsertion,
	extractAtQuery,
	fileTreeState,
	filterFiles,
} from "../../../src/lib/frontend/stores/file-tree.svelte.js";

beforeEach(() => {
	fileTreeState.entries = [];
	fileTreeState.loading = false;
	fileTreeState.loaded = false;
});

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
		expect(filterFiles(entries, "")).toEqual({ entries, dividerAt: 0 });
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
		expect(filterFiles(entries, "zzzzzzz")).toEqual({
			entries: [],
			dividerAt: 0,
		});
	});

	it("limits results to 20", () => {
		const manyEntries = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
		expect(filterFiles(manyEntries, "file").entries).toHaveLength(20);
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
		expect(
			filterFiles(
				[
					"src/lib/util.ts",
					"src/main.ts",
					"src/lib/",
					"src/lib/nested/deep.ts",
				],
				"src/",
			),
		).toEqual({
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
		expect(filterFiles(["src/", "src/lib/", "src/main.ts"], "src/")).toEqual({
			entries: ["src/lib/", "src/main.ts"],
			dividerAt: 2,
		});
	});

	it("groups and self-excludes a directory query regardless of its case", () => {
		const deep = Array.from({ length: 24 }, (_, i) => `src/aaa-deep/f${i}.ts`);
		const result = filterFiles(["src/", ...deep, "src/z-immediate.ts"], "SRC/");
		expect(result.entries).not.toContain("src/");
		expect(result.entries[0]).toBe("src/z-immediate.ts");
		expect(result.dividerAt).toBe(1);
	});

	it("ranks basename matches then locale order within each directory group", () => {
		expect(
			filterFiles(
				[
					"src/zeta.ts",
					"src/deep/zeta.ts",
					"other/src/zeta.ts",
					"src/alpha.ts",
					"vendor/src/",
					"src/deep/alpha.ts",
				],
				"src/",
			),
		).toEqual({
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
		const expected = {
			entries: [...immediate.slice(0, 12), ...deeper.slice(0, 8)],
			dividerAt: 12,
		};

		expect(filterFiles(expected.entries, "src/")).toEqual(expected);
		expect(filterFiles([...immediate, ...deeper], "src/")).toEqual(expected);
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

		expect(filterFiles([...immediate, ...deeper], "src/")).toEqual({
			entries: [...immediate, ...deeper.slice(0, 17)],
			dividerAt: 3,
		});
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

		expect(filterFiles([...immediate, ...deeper], "src/")).toEqual({
			entries: [...immediate.slice(0, 17), ...deeper],
			dividerAt: 17,
		});
	});

	it("gives the whole cap to whichever group is the only one populated", () => {
		const immediate = Array.from(
			{ length: 21 },
			(_, index) => `src/immediate-${index.toString().padStart(2, "0")}.ts`,
		);
		expect(filterFiles(immediate, "src/")).toEqual({
			entries: immediate.slice(0, 20),
			dividerAt: 20,
		});

		const deeper = Array.from(
			{ length: 21 },
			(_, index) =>
				`src/deep/descendant-${index.toString().padStart(2, "0")}.ts`,
		);
		expect(filterFiles(deeper, "src/")).toEqual({
			entries: deeper.slice(0, 20),
			dividerAt: 0,
		});
	});

	it("reports no grouping boundary for empty and non-directory queries", () => {
		expect(filterFiles(entries, "").dividerAt).toBe(0);
		expect(filterFiles(entries, "frontend").dividerAt).toBe(0);
	});

	it("groups workspace-relative paths without treating root metadata as a path prefix", () => {
		applyGetFileTreeResponse({
			projectSlug: "workspace",
			entries: [
				"src/",
				"src/deep/file.ts",
				"src/main.ts",
				"src/deep/",
				"other/src/main.ts",
			],
			roots: [
				{ root: "/workspace/app", label: "app" },
				{ root: "/workspace/shared", label: "shared", shared: true },
			],
		});

		expect(filterFiles(fileTreeState.entries, "src/")).toEqual({
			entries: [
				"src/deep/",
				"src/main.ts",
				"other/src/main.ts",
				"src/deep/file.ts",
			],
			dividerAt: 2,
		});
	});
});

describe("applyGetFileTreeResponse", () => {
	it("populates entries and sets loaded", () => {
		applyGetFileTreeResponse({
			projectSlug: "demo",
			entries: ["a.ts", "b.ts", "src/"],
		});
		expect(fileTreeState.entries).toEqual(["a.ts", "b.ts", "src/"]);
		expect(fileTreeState.loaded).toBe(true);
		expect(fileTreeState.loading).toBe(false);
	});
});

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
