# File Autocomplete (`@` Mention) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `@` file autocomplete picker that inserts file paths and attaches file content using XML structure, with render-time stripping for clean display.

**Architecture:** New `FileMenu.svelte` parallel to `CommandMenu`, backed by a `file-tree.svelte.ts` store preloaded via a new `get_file_tree` WS handler. XML-wrapped messages are stripped at render time in `UserMessage.svelte` and `historyToChatMessages()`.

**Tech Stack:** Svelte 5 (runes), Tailwind CSS v4, Vitest, WebSocket, Lucide icons

**Worktree:** `.worktrees/file-autocomplete` on branch `feature/file-autocomplete`

**Design doc:** `docs/plans/2026-03-04-file-autocomplete-design.md`

---

## Task 1: `extractDisplayText` Utility + Tests

The render-time XML stripping function. Pure utility, no dependencies. Foundation for display/send separation.

**Files:**
- Modify: `src/lib/public/utils/format.ts` (add function at end)
- Create: `test/unit/extract-display-text.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/extract-display-text.test.ts`:

```ts
// ─── extractDisplayText Tests ────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { extractDisplayText } from "../../src/lib/public/utils/format.js";

describe("extractDisplayText", () => {
	it("returns original text when no XML wrapper", () => {
		expect(extractDisplayText("hello world")).toBe("hello world");
	});

	it("returns original text for empty string", () => {
		expect(extractDisplayText("")).toBe("");
	});

	it("extracts user-message content from XML wrapper", () => {
		const wrapped = `<attached-files>
<file path="src/auth.ts">
const x = 1;
</file>
</attached-files>

<user-message>
Explain @src/auth.ts
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Explain @src/auth.ts");
	});

	it("handles multiple attached files", () => {
		const wrapped = `<attached-files>
<file path="a.ts">aaa</file>
<file path="b.ts">bbb</file>
</attached-files>

<user-message>
Compare @a.ts and @b.ts
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Compare @a.ts and @b.ts");
	});

	it("handles directory attachments", () => {
		const wrapped = `<attached-files>
<directory path="src/utils/">
auth.ts (1.2KB, file)
helpers/ (directory)
</directory>
</attached-files>

<user-message>
List @src/utils/
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("List @src/utils/");
	});

	it("handles multiline user messages", () => {
		const wrapped = `<attached-files>
<file path="x.ts">code</file>
</attached-files>

<user-message>
Line one
Line two
Line three
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Line one\nLine two\nLine three");
	});

	it("passes through text that contains < but is not our XML format", () => {
		const text = "Use a <div> element for layout";
		expect(extractDisplayText(text)).toBe(text);
	});

	it("handles binary file markers", () => {
		const wrapped = `<attached-files>
<file path="image.png" binary="true" />
</attached-files>

<user-message>
What is @image.png
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("What is @image.png");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/extract-display-text.test.ts`
Expected: FAIL — `extractDisplayText` is not exported from format.ts

**Step 3: Write the implementation**

Add to end of `src/lib/public/utils/format.ts`:

```ts
/**
 * Extract display text from a potentially XML-wrapped message.
 * Messages with @file references are sent as XML with <attached-files> and
 * <user-message> tags. This strips the wrapper for display, returning only
 * the user's original message. Non-wrapped text passes through unchanged.
 */
export function extractDisplayText(text: string): string {
	const match = text.match(/<user-message>\n([\s\S]*?)\n<\/user-message>/);
	return match ? match[1]! : text;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/extract-display-text.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Commit**

```bash
git add src/lib/public/utils/format.ts test/unit/extract-display-text.test.ts
git commit -m "feat: add extractDisplayText utility for XML wrapper stripping"
```

---

## Task 2: `extractAtQuery` + `filterFiles` Pure Functions + Tests

The cursor-position-aware `@` detection and fuzzy file filtering. Pure functions, no framework dependencies.

**Files:**
- Create: `src/lib/public/stores/file-tree.svelte.ts`
- Create: `test/unit/file-tree-store.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/file-tree-store.test.ts`:

```ts
// ─── File Tree Store Tests ───────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	extractAtQuery,
	fileTreeState,
	filterFiles,
	handleFileTree,
} from "../../src/lib/public/stores/file-tree.svelte.js";

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
		// "explain @src/au and then more"  cursor at position 15 (after "au")
		const result = extractAtQuery("explain @src/au and then more", 15);
		expect(result).toEqual({ query: "src/au", start: 8, end: 15 });
	});

	it("returns null when @ is followed by a space (already completed)", () => {
		// "explain @src/auth.ts more text" cursor at 29
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
		"src/lib/public/App.svelte",
		"src/lib/public/stores/chat.svelte.ts",
		"src/lib/public/stores/discovery.svelte.ts",
		"src/lib/public/utils/format.ts",
		"src/lib/handlers/files.ts",
		"test/unit/prompts.test.ts",
		"package.json",
		"src/lib/public/",
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
		expect(result).toContain("src/lib/public/utils/format.ts");
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
		// "src/lib/handlers/files.ts" has basename match, should come first
		expect(result[0]).toBe("src/lib/handlers/files.ts");
	});

	it("matches directories", () => {
		const result = filterFiles(entries, "public/");
		expect(result).toContain("src/lib/public/");
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
		handleFileTree({ type: "file_tree" as const, entries: "bad" as any });
		expect(fileTreeState.entries).toHaveLength(0);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/file-tree-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/lib/public/stores/file-tree.svelte.ts`:

```ts
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
	// Calculate start: match[0] includes the whitespace prefix (if any)
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

		// Check if basename (last segment) matches
		const lastSlash = entry.lastIndexOf("/", entry.endsWith("/") ? entry.length - 2 : entry.length);
		const basename = entry.slice(lastSlash + 1).toLowerCase();
		const basenameMatch = basename.includes(lower);

		matches.push({ entry, basenameMatch });
	}

	// Sort: basename matches first, then alphabetical
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
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/file-tree-store.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/lib/public/stores/file-tree.svelte.ts test/unit/file-tree-store.test.ts
git commit -m "feat: add file-tree store with extractAtQuery and filterFiles"
```

---

## Task 3: `buildAttachedMessage` + `parseAtReferences` Utility + Tests

Message construction: parsing `@` references from text and building XML-wrapped payloads.

**Files:**
- Create: `src/lib/public/utils/file-attach.ts`
- Create: `test/unit/file-attach.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/file-attach.test.ts`:

```ts
// ─── File Attach Utility Tests ───────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import {
	buildAttachedMessage,
	parseAtReferences,
} from "../../src/lib/public/utils/file-attach.js";

// ─── parseAtReferences ──────────────────────────────────────────────────────

describe("parseAtReferences", () => {
	it("returns empty array for text without @ references", () => {
		expect(parseAtReferences("hello world")).toEqual([]);
	});

	it("extracts a single file reference", () => {
		expect(parseAtReferences("explain @src/auth.ts please")).toEqual([
			"src/auth.ts",
		]);
	});

	it("extracts multiple file references", () => {
		expect(
			parseAtReferences("compare @src/old.ts and @src/new.ts"),
		).toEqual(["src/old.ts", "src/new.ts"]);
	});

	it("extracts directory references", () => {
		expect(parseAtReferences("list @src/utils/")).toEqual(["src/utils/"]);
	});

	it("handles @ at start of text", () => {
		expect(parseAtReferences("@file.ts")).toEqual(["file.ts"]);
	});

	it("ignores email-like patterns", () => {
		expect(parseAtReferences("contact user@example.com")).toEqual([]);
	});
});

// ─── buildAttachedMessage ───────────────────────────────────────────────────

describe("buildAttachedMessage", () => {
	it("returns original text when no attachments", () => {
		expect(buildAttachedMessage("hello", [])).toBe("hello");
	});

	it("wraps text with file attachments in XML", () => {
		const result = buildAttachedMessage("explain @src/auth.ts", [
			{ path: "src/auth.ts", type: "file", content: "const x = 1;" },
		]);
		expect(result).toContain("<attached-files>");
		expect(result).toContain('<file path="src/auth.ts">');
		expect(result).toContain("const x = 1;");
		expect(result).toContain("</file>");
		expect(result).toContain("</attached-files>");
		expect(result).toContain("<user-message>");
		expect(result).toContain("explain @src/auth.ts");
		expect(result).toContain("</user-message>");
	});

	it("wraps directory attachments", () => {
		const result = buildAttachedMessage("list @src/", [
			{ path: "src/", type: "directory", content: "auth.ts (1.2KB, file)" },
		]);
		expect(result).toContain('<directory path="src/">');
		expect(result).toContain("auth.ts (1.2KB, file)");
		expect(result).toContain("</directory>");
	});

	it("handles binary files", () => {
		const result = buildAttachedMessage("show @img.png", [
			{ path: "img.png", type: "binary" },
		]);
		expect(result).toContain('<file path="img.png" binary="true" />');
	});

	it("handles multiple attachments", () => {
		const result = buildAttachedMessage("compare @a.ts and @b.ts", [
			{ path: "a.ts", type: "file", content: "aaa" },
			{ path: "b.ts", type: "file", content: "bbb" },
		]);
		expect(result).toContain('<file path="a.ts">');
		expect(result).toContain('<file path="b.ts">');
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/file-attach.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/lib/public/utils/file-attach.ts`:

```ts
// ─── File Attach Utilities ───────────────────────────────────────────────────
// Parse @references from text and build XML-wrapped messages.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileAttachment {
	path: string;
	type: "file" | "directory" | "binary";
	content?: string;
}

// ─── Parse @references ──────────────────────────────────────────────────────

/**
 * Extract all @file references from message text.
 * Matches @ at start of text or after whitespace, followed by a non-space path.
 * Ignores email-like patterns (word@word).
 */
export function parseAtReferences(text: string): string[] {
	const matches = text.matchAll(/(?:^|(?<=\s))@(\S+)/g);
	return [...matches].map((m) => m[1]!);
}

// ─── Build XML message ──────────────────────────────────────────────────────

/**
 * Build an XML-wrapped message with file attachments.
 * Returns plain text if no attachments are provided.
 */
export function buildAttachedMessage(
	text: string,
	attachments: FileAttachment[],
): string {
	if (attachments.length === 0) return text;

	const fileParts = attachments
		.map((a) => {
			if (a.type === "binary") {
				return `<file path="${a.path}" binary="true" />`;
			}
			if (a.type === "directory") {
				return `<directory path="${a.path}">\n${a.content}\n</directory>`;
			}
			return `<file path="${a.path}">\n${a.content}\n</file>`;
		})
		.join("\n");

	return `<attached-files>\n${fileParts}\n</attached-files>\n\n<user-message>\n${text}\n</user-message>`;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/file-attach.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/lib/public/utils/file-attach.ts test/unit/file-attach.test.ts
git commit -m "feat: add parseAtReferences and buildAttachedMessage utilities"
```

---

## Task 4: Server-side `get_file_tree` Handler

Recursive directory walk that returns a flat list of all project file paths.

**Files:**
- Modify: `src/lib/handlers/files.ts` (add `handleGetFileTree`)
- Modify: `src/lib/handlers/index.ts` (wire up dispatch)
- Modify: `src/lib/shared-types.ts` (add `file_tree` message type)
- Create: `test/unit/handlers-file-tree.test.ts`

**Step 1: Write the failing test**

Create `test/unit/handlers-file-tree.test.ts`:

```ts
// ─── File Tree Handler Tests ─────────────────────────────────────────────────
import { describe, expect, it, vi } from "vitest";
import { handleGetFileTree } from "../../src/lib/handlers/files.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";

function makeDeps(
	listDirectoryImpl: (path?: string) => Promise<Array<{ name: string; type: string }>>,
): { deps: HandlerDeps; sent: Array<{ clientId: string; msg: unknown }> } {
	const sent: Array<{ clientId: string; msg: unknown }> = [];
	const deps = {
		client: { listDirectory: listDirectoryImpl },
		wsHandler: {
			sendTo: (clientId: string, msg: unknown) => {
				sent.push({ clientId, msg });
			},
			broadcast: vi.fn(),
			broadcastExcept: vi.fn(),
		},
		log: vi.fn(),
	} as unknown as HandlerDeps;
	return { deps, sent };
}

describe("handleGetFileTree", () => {
	it("returns flat list of files and directories", async () => {
		const { deps, sent } = makeDeps(async (path) => {
			if (!path || path === ".") {
				return [
					{ name: "index.ts", type: "file" },
					{ name: "src", type: "directory" },
				];
			}
			if (path === "src") {
				return [{ name: "app.ts", type: "file" }];
			}
			return [];
		});

		await handleGetFileTree(deps, "client-1", {});

		expect(sent).toHaveLength(1);
		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toContain("index.ts");
		expect(msg.entries).toContain("src/");
		expect(msg.entries).toContain("src/app.ts");
	});

	it("handles empty directory", async () => {
		const { deps, sent } = makeDeps(async () => []);

		await handleGetFileTree(deps, "client-1", {});

		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toEqual([]);
	});

	it("handles listDirectory errors gracefully", async () => {
		const { deps, sent } = makeDeps(async () => {
			throw new Error("Permission denied");
		});

		await handleGetFileTree(deps, "client-1", {});

		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toEqual([]);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers-file-tree.test.ts`
Expected: FAIL — `handleGetFileTree` not exported

**Step 3: Add `file_tree` to `RelayMessage` in `src/lib/shared-types.ts`**

Add after the `file_content` line (around line 187):

```ts
	| { type: "file_tree"; entries: string[] }
```

**Step 4: Implement `handleGetFileTree` in `src/lib/handlers/files.ts`**

Add after the existing `handleGetFileContent` function:

```ts
export async function handleGetFileTree(
	deps: HandlerDeps,
	clientId: string,
	_payload: Record<string, unknown>,
): Promise<void> {
	const entries: string[] = [];

	try {
		// Breadth-first walk of project directory
		const queue: string[] = ["."];

		while (queue.length > 0) {
			const dir = queue.shift()!;
			const items = await deps.client.listDirectory(dir);

			for (const item of items) {
				const path = dir === "." ? item.name : `${dir}/${item.name}`;
				if (item.type === "directory") {
					entries.push(`${path}/`);
					queue.push(path);
				} else {
					entries.push(path);
				}
			}
		}
	} catch (err) {
		deps.log(`[file-tree] Error walking directory: ${err}`);
	}

	deps.wsHandler.sendTo(clientId, { type: "file_tree", entries });
}
```

**Step 5: Wire up in `src/lib/handlers/index.ts`**

Add to the import from `./files.js`:

```ts
export { handleGetFileContent, handleGetFileList, handleGetFileTree } from "./files.js";
```

And the corresponding import block:

```ts
import { handleGetFileContent, handleGetFileList, handleGetFileTree } from "./files.js";
```

Add to the `MESSAGE_HANDLERS` dispatch table:

```ts
	get_file_tree: handleGetFileTree,
```

(Add after the `get_file_content` line.)

**Step 6: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers-file-tree.test.ts`
Expected: PASS (all tests)

**Step 7: Run full test suite**

Run: `pnpm test`
Expected: All existing tests still pass

**Step 8: Commit**

```bash
git add src/lib/handlers/files.ts src/lib/handlers/index.ts src/lib/shared-types.ts test/unit/handlers-file-tree.test.ts
git commit -m "feat: add get_file_tree server handler with recursive directory walk"
```

---

## Task 5: Wire `file_tree` Message on Frontend

Route the new `file_tree` WS message to the store and trigger the request on connect.

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts` (add `file_tree` case)
- Modify: `src/lib/public/components/layout/ChatLayout.svelte` (send `get_file_tree` on connect)

**Step 1: Add `file_tree` handler to `ws.svelte.ts`**

In the `handleMessage()` switch, find the `// ─── File Browser` section (around line 532) and add a new case for `file_tree` **before** the `file_list` case:

```ts
		// ─── File Tree (@ autocomplete) ──────────────────────────────────
		case "file_tree":
			handleFileTree(msg as { type: "file_tree"; entries: unknown });
			break;
```

Add the import at the top of the file alongside other store imports:

```ts
import { handleFileTree } from "./file-tree.svelte.js";
```

**Step 2: Add `get_file_tree` request to `ChatLayout.svelte`**

In the `onConnect` callback (around line 245–254), add after `wsSend({ type: "get_commands" })`:

```ts
			wsSend({ type: "get_file_tree" });
```

Also import `requestFileTree` and call it before the send:

```ts
import { requestFileTree, clearFileTreeState } from "../../stores/file-tree.svelte.js";
```

In the `onConnect` callback, add before the `wsSend`:

```ts
			requestFileTree();
			wsSend({ type: "get_file_tree" });
```

In the `onDisconnect` callback (around line 235–243), add `clearFileTreeState()` alongside the other clear calls:

```ts
			clearFileTreeState();
```

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (no new tests needed — this is wiring only)

**Step 4: Commit**

```bash
git add src/lib/public/stores/ws.svelte.ts src/lib/public/components/layout/ChatLayout.svelte
git commit -m "feat: wire file_tree WS message to store and request on connect"
```

---

## Task 6: `FileMenu.svelte` Component

The popup UI component for file autocomplete. Mirrors `CommandMenu` patterns.

**Files:**
- Create: `src/lib/public/components/features/FileMenu.svelte`

**Step 1: Create the component**

Create `src/lib/public/components/features/FileMenu.svelte`:

```svelte
<!-- ─── File Menu ──────────────────────────────────────────────────────────── -->
<!-- @-mention file autocomplete popup. Filters project files by fuzzy match, -->
<!-- supports keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse selection. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		query,
		visible,
		entries,
		onSelect,
		onClose,
		loading = false,
	}: {
		query: string;
		visible: boolean;
		entries: string[];
		onSelect: (path: string) => void;
		onClose: () => void;
		loading?: boolean;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let activeIndex = $state(0);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const isVisible = $derived(visible && (entries.length > 0 || loading));

	// ─── Reset active index when entries change ─────────────────────────────────

	$effect(() => {
		void entries.length;
		activeIndex = 0;
	});

	// ─── Keyboard handling ──────────────────────────────────────────────────────

	export function handleKeydown(e: KeyboardEvent): boolean {
		if (!isVisible) return false;

		switch (e.key) {
			case "ArrowDown": {
				e.preventDefault();
				if (entries.length > 0) {
					activeIndex = (activeIndex + 1) % entries.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "ArrowUp": {
				e.preventDefault();
				if (entries.length > 0) {
					activeIndex =
						(activeIndex - 1 + entries.length) % entries.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "Tab":
			case "Enter": {
				e.preventDefault();
				const selected = entries[activeIndex];
				if (entries.length > 0 && selected) {
					onSelect(selected);
				}
				return true;
			}

			case "Escape": {
				e.preventDefault();
				onClose();
				return true;
			}

			default:
				return false;
		}
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function isDirectory(path: string): boolean {
		return path.endsWith("/");
	}

	function scrollActiveIntoView(): void {
		requestAnimationFrame(() => {
			const menu = document.querySelector("#file-menu .file-menu-list");
			const activeItem = menu?.querySelector(".file-item-active");
			if (activeItem) {
				activeItem.scrollIntoView({ block: "nearest" });
			}
		});
	}
</script>

<div id="file-menu" class:hidden={!isVisible}>
	{#if isVisible}
		<div
			class="file-menu-list absolute bottom-full left-0 right-0 mb-1 bg-bg-surface border border-border rounded-xl shadow-[0_-4px_16px_rgba(0,0,0,0.3)] max-h-[300px] overflow-y-auto z-[60] py-1"
		>
			{#if loading && entries.length === 0}
				<div
					class="flex items-center gap-2 py-3 px-3.5 text-text-muted text-[13px]"
				>
					<Icon name="loader" size={14} class="animate-spin" />
					<span>Loading files…</span>
				</div>
			{:else if entries.length === 0}
				<div class="py-3 px-3.5 text-text-muted text-[13px]">
					No files found
				</div>
			{:else}
				{#each entries as entry, i}
					<div
						class="file-item flex items-center gap-2 py-2 px-3.5 cursor-pointer transition-colors duration-100 hover:bg-bg-alt max-sm:py-1.5 max-sm:px-2.5 max-sm:gap-1.5 {i === activeIndex ? 'file-item-active bg-accent-bg hover:bg-accent-bg' : ''}"
						data-file-index={i}
						role="option"
						tabindex="-1"
						aria-selected={i === activeIndex}
						onmousedown={(e) => {
							e.preventDefault();
							onSelect(entry);
						}}
						onmouseenter={() => {
							activeIndex = i;
						}}
					>
						<Icon
							name={isDirectory(entry) ? "folder" : "file"}
							size={14}
							class="shrink-0 {isDirectory(entry) ? 'text-warning' : 'text-text-muted'}"
						/>
						<span
							class="file-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] max-sm:text-xs"
						>
							{@const lastSlash = entry.lastIndexOf("/", entry.endsWith("/") ? entry.length - 2 : entry.length - 1)}
							{#if lastSlash >= 0}
								<span class="text-text-muted"
									>{entry.slice(0, lastSlash + 1)}</span
								><span class="text-text"
									>{entry.slice(lastSlash + 1)}</span
								>
							{:else}
								<span class="text-text">{entry}</span>
							{/if}
						</span>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
```

**Step 2: Verify lint passes**

Run: `pnpm lint`
Expected: No errors

**Step 3: Commit**

```bash
git add src/lib/public/components/features/FileMenu.svelte
git commit -m "feat: add FileMenu component for @ file autocomplete popup"
```

---

## Task 7: Apply `extractDisplayText` to Rendering

Strip XML wrapper in `UserMessage.svelte` and `historyToChatMessages()`.

**Files:**
- Modify: `src/lib/public/components/chat/UserMessage.svelte` (line 18)
- Modify: `src/lib/public/utils/history-logic.ts` (lines 243-246)

**Step 1: Update `UserMessage.svelte`**

Import `extractDisplayText` and apply it at line 18:

```svelte
<script lang="ts">
	import type { UserMessage } from "../../types.js";
	import { escapeHtml, extractDisplayText } from "../../utils/format.js";

	let { message }: { message: UserMessage } = $props();
</script>
```

Change line 18 from:
```svelte
		{@html escapeHtml(message.text)}
```
to:
```svelte
		{@html escapeHtml(extractDisplayText(message.text))}
```

**Step 2: Update `historyToChatMessages()` in `history-logic.ts`**

Import `extractDisplayText` at the top:

```ts
import { extractDisplayText } from "./format.js";
```

Change lines 243-246 from:
```ts
			result.push({
				type: "user",
				uuid: generateUuid(),
				text,
			} satisfies UserMessage);
```
to:
```ts
			result.push({
				type: "user",
				uuid: generateUuid(),
				text: extractDisplayText(text),
			} satisfies UserMessage);
```

**Step 3: Run existing tests**

Run: `pnpm test`
Expected: All tests pass. The `extractDisplayText` tests from Task 1 already verify the stripping logic. Existing tests pass because all existing messages have no XML wrapper.

**Step 4: Commit**

```bash
git add src/lib/public/components/chat/UserMessage.svelte src/lib/public/utils/history-logic.ts
git commit -m "feat: strip XML wrapper at render time for @ file attachments"
```

---

## Task 8: Integrate `FileMenu` into `InputArea.svelte`

The main integration: trigger detection, popup rendering, file selection, and XML-wrapped send.

**Files:**
- Modify: `src/lib/public/components/layout/InputArea.svelte`

**Step 1: Add imports**

Add to the `<script>` imports:

```ts
// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
import FileMenu from "../features/FileMenu.svelte";
import { fileTreeState } from "../../stores/file-tree.svelte.js";
import { extractAtQuery, filterFiles } from "../../stores/file-tree.svelte.js";
import { parseAtReferences, buildAttachedMessage } from "../../utils/file-attach.js";
import type { FileAttachment } from "../../utils/file-attach.js";
```

**Step 2: Add state variables**

Add after the existing state variables (around line 22):

```ts
	let fileMenuRef: FileMenu | undefined = $state();
	let cursorPos = $state(0);
```

**Step 3: Add file menu derived state**

Add after the `commandQuery` derived (around line 31):

```ts
	// ─── File menu state ──────────────────────────────────────────────────────

	const atQuery = $derived(extractAtQuery(inputText, cursorPos));
	const fileMenuVisible = $derived(
		!commandMenuVisible && atQuery !== null && !chatState.processing,
	);
	const fileQuery = $derived(atQuery?.query ?? "");
	const filteredFiles = $derived(
		fileMenuVisible ? filterFiles(fileTreeState.entries, fileQuery) : [],
	);
```

**Step 4: Track cursor position**

Update `handleInput()`:

```ts
	function handleInput() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
		autoResize();
	}
```

Add a new handler for cursor movement (after `handleInput`):

```ts
	function handleKeyup() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}

	function handleClick() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}
```

**Step 5: Update keyboard handler**

In `handleKeydown`, add file menu delegation after the command menu block (around line 64):

```ts
		// Forward keyboard events to FileMenu when visible
		if (fileMenuVisible && fileMenuRef) {
			const handled = fileMenuRef.handleKeydown(e);
			if (handled) return;
		}
```

**Step 6: Add file selection handler**

Add after `handleCommandClose` (around line 149):

```ts
	// ─── File menu handlers ───────────────────────────────────────────────────

	function handleFileSelect(path: string) {
		if (!atQuery || !textareaEl) return;

		// Replace @query with @path (with trailing space)
		const before = inputText.slice(0, atQuery.start);
		const after = inputText.slice(atQuery.end);
		const insertion = `@${path} `;
		inputText = before + insertion + after;

		// Move cursor to after the inserted path
		const newCursorPos = atQuery.start + insertion.length;
		requestAnimationFrame(() => {
			if (textareaEl) {
				textareaEl.focus();
				textareaEl.selectionStart = newCursorPos;
				textareaEl.selectionEnd = newCursorPos;
				cursorPos = newCursorPos;
			}
		});
	}

	function handleFileMenuClose() {
		// Remove the @ trigger character
		if (atQuery) {
			const before = inputText.slice(0, atQuery.start);
			const after = inputText.slice(atQuery.end);
			inputText = before + after;
		}
	}
```

**Step 7: Make `sendMessage` async with file content fetching**

Replace the existing `sendMessage` function:

```ts
	async function sendMessage() {
		const text = inputText.trim();
		if (!text) return;

		// Parse @references and fetch file contents
		const refs = parseAtReferences(text);
		let messageText = text;

		if (refs.length > 0) {
			const attachments: FileAttachment[] = [];

			for (const ref of refs) {
				try {
					if (ref.endsWith("/")) {
						// Directory: fetch listing
						const content = await fetchDirectoryListing(ref);
						attachments.push({ path: ref, type: "directory", content });
					} else {
						// File: fetch content
						const result = await fetchFileContent(ref);
						if (result.binary) {
							attachments.push({ path: ref, type: "binary" });
						} else {
							attachments.push({
								path: ref,
								type: "file",
								content: result.content,
							});
						}
					}
				} catch {
					// Skip files that fail to load
				}
			}

			messageText = buildAttachedMessage(text, attachments);
		}

		if (isProcessing) {
			const sessionId = sessionState.currentId;
			if (sessionId) {
				enqueueMessage(sessionId, messageText);
			}
		} else {
			addUserMessage(messageText);
			wsSend({ type: "message", text: messageText });
		}

		inputText = "";
		cursorPos = 0;
		if (textareaEl) {
			textareaEl.style.height = "auto";
		}
	}
```

**Step 8: Add file content fetch helpers**

Add these helper functions (using WS listener pattern from `ws-listeners.ts`):

```ts
	function fetchFileContent(
		path: string,
	): Promise<{ content: string; binary?: boolean }> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

			const unsub = onFileBrowser((msg) => {
				if (msg.type === "file_content" && msg.path === path) {
					clearTimeout(timeout);
					unsub();
					resolve({
						content: (msg as { content: string }).content,
						binary: (msg as { binary?: boolean }).binary,
					});
				}
			});

			wsSend({ type: "get_file_content", path });
		});
	}

	function fetchDirectoryListing(path: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

			const unsub = onFileBrowser((msg) => {
				if (msg.type === "file_list" && msg.path === path) {
					clearTimeout(timeout);
					unsub();
					const entries = (msg as { entries: Array<{ name: string; type: string; size?: number }> }).entries;
					const listing = entries
						.map((e) =>
							e.type === "directory"
								? `${e.name}/ (directory)`
								: `${e.name} (${formatFileSize(e.size ?? 0)}, file)`,
						)
						.join("\n");
					resolve(listing);
				}
			});

			wsSend({ type: "get_file_list", path: path.replace(/\/$/, "") });
		});
	}
```

Add required imports:

```ts
import { onFileBrowser } from "../../stores/ws-listeners.js";
import { formatFileSize } from "../../utils/format.js";
```

**Step 9: Add FileMenu to template**

Add above the CommandMenu block (before line 170):

```svelte
<!-- File Menu (above input when "@" is typed) -->
{#if fileMenuVisible}
	<div id="file-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<FileMenu
			bind:this={fileMenuRef}
			query={fileQuery}
			visible={fileMenuVisible}
			entries={filteredFiles}
			onSelect={handleFileSelect}
			onClose={handleFileMenuClose}
			loading={fileTreeState.loading}
		/>
	</div>
{/if}
```

**Step 10: Add cursor tracking events to textarea**

Update the `<textarea>` element to include the new event handlers:

Add `onkeyup={handleKeyup}` and `onclick={handleClick}` to the textarea element alongside the existing `oninput` and `onkeydown`.

**Step 11: Verify lint and tests pass**

Run: `pnpm lint && pnpm test`
Expected: All pass

**Step 12: Commit**

```bash
git add src/lib/public/components/layout/InputArea.svelte
git commit -m "feat: integrate FileMenu into InputArea with @ trigger, selection, and XML-wrapped send"
```

---

## Task 9: Storybook Story

Visual testing for the FileMenu component.

**Files:**
- Create: `src/lib/public/components/features/FileMenu.stories.ts`

**Step 1: Create story file**

Create `src/lib/public/components/features/FileMenu.stories.ts`:

```ts
import type { Meta, StoryObj } from "@storybook/svelte";
import FileMenu from "./FileMenu.svelte";

const sampleEntries = [
	"src/lib/server.ts",
	"src/lib/public/App.svelte",
	"src/lib/public/stores/chat.svelte.ts",
	"src/lib/public/stores/discovery.svelte.ts",
	"src/lib/public/utils/format.ts",
	"src/lib/handlers/files.ts",
	"src/lib/handlers/",
	"src/lib/public/",
	"test/unit/prompts.test.ts",
	"package.json",
];

const meta = {
	title: "Features/FileMenu",
	component: FileMenu,
	tags: ["autodocs"],
} satisfies Meta<typeof FileMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithResults: Story = {
	args: {
		query: "lib",
		visible: true,
		entries: sampleEntries,
		onSelect: (path: string) => console.log("Selected:", path),
		onClose: () => console.log("Closed"),
		loading: false,
	},
};

export const Loading: Story = {
	args: {
		query: "",
		visible: true,
		entries: [],
		onSelect: () => {},
		onClose: () => {},
		loading: true,
	},
};

export const NoResults: Story = {
	args: {
		query: "zzzzz",
		visible: true,
		entries: [],
		onSelect: () => {},
		onClose: () => {},
		loading: false,
	},
};

export const ManyResults: Story = {
	args: {
		query: "test",
		visible: true,
		entries: Array.from({ length: 20 }, (_, i) => `test/unit/test-${i}.ts`),
		onSelect: () => {},
		onClose: () => {},
		loading: false,
	},
};
```

**Step 2: Verify storybook builds**

Run: `pnpm storybook build 2>&1 | tail -5` (or just lint)
Run: `pnpm lint`
Expected: No errors

**Step 3: Commit**

```bash
git add src/lib/public/components/features/FileMenu.stories.ts
git commit -m "feat: add Storybook stories for FileMenu component"
```

---

## Task 10: Final Integration Test + Cleanup

Verify everything works end-to-end. Run full suite, fix any lint issues.

**Files:**
- All modified files

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (2108 original + new tests)

**Step 2: Run lint**

Run: `pnpm lint`
Expected: No errors

**Step 3: Manual verification checklist**

- [ ] Typing `@` shows the file menu popup
- [ ] Typing `@src` filters to files containing "src"
- [ ] Arrow keys navigate the file list
- [ ] Tab/Enter inserts `@path ` at cursor position
- [ ] Escape closes the popup
- [ ] Multiple `@references` work in one message
- [ ] Send prepends XML with file content
- [ ] Chat bubble shows clean text (no XML)
- [ ] Past sessions load without showing XML
- [ ] `/` commands still work
- [ ] `@` mid-sentence works (e.g., "explain @file.ts")

**Step 4: Final commit (if needed)**

```bash
git add -A
git commit -m "chore: final cleanup for @ file autocomplete feature"
```
