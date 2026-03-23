# Project Management Improvements Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add directory autocomplete to the "+Add project" input and a context menu with rename/delete to project items in both the ProjectSwitcher and DashboardPage.

**Architecture:** Three new WebSocket message types (`list_directories`, `remove_project`, `rename_project`) added to the handler layer. Two new Svelte components (`DirectoryAutocomplete.svelte`, `ProjectContextMenu.svelte`) in the frontend. The daemon already has `removeProject()` and `setProjectTitle()` — we only need to expose them via WebSocket handlers and wire `removeProject`/`setProjectTitle` into `ProjectRelayConfig` + `HandlerDeps` the same way `addProject` is wired.

**Tech Stack:** TypeScript, Svelte 5, Node.js `fs.readdir`, Vitest

**Worktree:** `.worktrees/project-management` (branch `feature/project-management`)

---

### Task 1: Add `list_directories` Backend Handler

**Files:**
- Modify: `src/lib/handlers/payloads.ts:43` (add payload type)
- Modify: `src/lib/server/ws-router.ts:10-54,56-101` (add to IncomingMessageType and VALID_MESSAGE_TYPES)
- Modify: `src/lib/shared-types.ts:350-356` (add `directory_list` to RelayMessage)
- Modify: `src/lib/handlers/settings.ts` (add handler function)
- Modify: `src/lib/handlers/index.ts` (register in exports and dispatch table)
- Test: `test/unit/handlers/list-directories.test.ts`

**Step 1: Write the failing test**

Create `test/unit/handlers/list-directories.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleListDirectories } from "../../../src/lib/handlers/settings.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs/promises");

describe("handleListDirectories", () => {
	it("returns directories matching prefix", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "personal", isDirectory: () => true, isFile: () => false },
			{ name: "work", isDirectory: () => true, isFile: () => false },
			{ name: "notes.txt", isDirectory: () => false, isFile: () => true },
		] as any);

		await handleListDirectories(deps, "c1", { path: "/Users/me/p" });

		expect(fs.readdir).toHaveBeenCalledWith("/Users/me", { withFileTypes: true });
		expect(sent).toHaveLength(1);
		const msg = sent[0] as any;
		expect(msg.type).toBe("directory_list");
		expect(msg.entries).toEqual(["/Users/me/personal/"]);
	});

	it("returns all directories when prefix is empty (trailing slash)", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "src", isDirectory: () => true, isFile: () => false },
			{ name: "docs", isDirectory: () => true, isFile: () => false },
			{ name: ".git", isDirectory: () => true, isFile: () => false },
		] as any);

		await handleListDirectories(deps, "c1", { path: "/project/" });

		expect(msg(sent).entries).toEqual(["/project/src/", "/project/docs/"]);
	});

	it("includes hidden dirs when prefix starts with dot", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: ".git", isDirectory: () => true, isFile: () => false },
			{ name: ".config", isDirectory: () => true, isFile: () => false },
			{ name: "src", isDirectory: () => true, isFile: () => false },
		] as any);

		await handleListDirectories(deps, "c1", { path: "/project/." });

		expect(msg(sent).entries).toEqual(["/project/.git/", "/project/.config/"]);
	});

	it("returns empty entries for non-existent directory", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		vi.mocked(fs.readdir).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		await handleListDirectories(deps, "c1", { path: "/nonexistent/foo" });

		expect(msg(sent).entries).toEqual([]);
	});

	it("resolves ~ to home directory", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "src", isDirectory: () => true, isFile: () => false },
		] as any);

		await handleListDirectories(deps, "c1", { path: "~/s" });

		const home = os.homedir();
		expect(fs.readdir).toHaveBeenCalledWith(home, { withFileTypes: true });
		expect(msg(sent).entries).toEqual([`${home}/src/`]);
	});

	it("caps results at 50", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);
		const entries = Array.from({ length: 60 }, (_, i) => ({
			name: `dir${i}`,
			isDirectory: () => true,
			isFile: () => false,
		}));
		vi.mocked(fs.readdir).mockResolvedValue(entries as any);

		await handleListDirectories(deps, "c1", { path: "/test/" });

		expect(msg(sent).entries).toHaveLength(50);
	});
});

function msg(sent: RelayMessage[]): any {
	return sent[0];
}
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/list-directories.test.ts`
Expected: FAIL — `handleListDirectories` doesn't exist

**Step 3: Add payload and message types**

In `src/lib/handlers/payloads.ts`, add after `add_project` (line 43):

```typescript
	list_directories: { path: string };
```

In `src/lib/server/ws-router.ts`, add `"list_directories"` to both `IncomingMessageType` (after line 32) and `VALID_MESSAGE_TYPES` (after line 78).

In `src/lib/shared-types.ts`, add to the `RelayMessage` union after the `project_list` entry (after line 356):

```typescript
	| { type: "directory_list"; path: string; entries: string[] }
```

**Step 4: Write the handler implementation**

In `src/lib/handlers/settings.ts`, add at the end of the file:

```typescript
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";

const MAX_DIR_ENTRIES = 50;

export async function handleListDirectories(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["list_directories"],
): Promise<void> {
	const rawPath = payload.path ?? "";

	// Resolve ~ to home directory
	let expandedPath = rawPath;
	if (expandedPath.startsWith("~/") || expandedPath === "~") {
		expandedPath = homedir() + expandedPath.slice(1);
	}

	// Split into parent directory and prefix
	// If path ends with /, list that directory (prefix = "")
	// Otherwise, list the parent and filter by the last component
	const endsWithSlash = expandedPath.endsWith("/");
	const parentDir = endsWithSlash ? expandedPath : dirname(expandedPath);
	const prefix = endsWithSlash ? "" : basename(expandedPath);
	const showHidden = prefix.startsWith(".");

	let entries: string[] = [];
	try {
		const dirents = await readdir(parentDir, { withFileTypes: true });
		const normalizedParent = parentDir.endsWith("/") ? parentDir : parentDir + "/";

		entries = dirents
			.filter((d) => {
				if (!d.isDirectory()) return false;
				if (!showHidden && d.name.startsWith(".")) return false;
				if (prefix && !d.name.toLowerCase().startsWith(prefix.toLowerCase())) return false;
				return true;
			})
			.slice(0, MAX_DIR_ENTRIES)
			.map((d) => normalizedParent + d.name + "/");
	} catch {
		// Directory doesn't exist or isn't readable — return empty
	}

	deps.wsHandler.sendTo(clientId, {
		type: "directory_list",
		path: rawPath,
		entries,
	});
}
```

**Step 5: Register in dispatch table**

In `src/lib/handlers/index.ts`:

1. Add to the exports section (after line 68):
```typescript
export {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleGetTodo,
	handleListDirectories,
} from "./settings.js";
```

2. Add to the imports section (after line 132):
```typescript
import {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleGetTodo,
	handleListDirectories,
} from "./settings.js";
```

3. Add to `MESSAGE_HANDLERS` (after line 170):
```typescript
	list_directories: handleListDirectories as MessageHandler,
```

**Step 6: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers/list-directories.test.ts`
Expected: PASS

**Step 7: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: add list_directories WebSocket handler for directory autocomplete"
```

---

### Task 2: Add `remove_project` and `rename_project` Backend Handlers

**Files:**
- Modify: `src/lib/handlers/payloads.ts` (add payload types)
- Modify: `src/lib/server/ws-router.ts` (add to type and set)
- Modify: `src/lib/handlers/settings.ts` (add handler functions)
- Modify: `src/lib/handlers/index.ts` (register)
- Modify: `src/lib/handlers/types.ts` (add `removeProject` and `setProjectTitle` to HandlerDeps)
- Modify: `src/lib/types.ts` (add to ProjectRelayConfig)
- Modify: `src/lib/relay/relay-stack.ts` (wire through to HandlerDeps)
- Modify: `src/lib/daemon/daemon.ts` (wire in buildRelayFactory)
- Test: `test/unit/handlers/project-management.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/handlers/project-management.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
	handleRemoveProject,
	handleRenameProject,
} from "../../../src/lib/handlers/settings.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("handleRemoveProject", () => {
	it("calls removeProject and broadcasts updated project list", async () => {
		const removeProject = vi.fn().mockResolvedValue(undefined);
		const getProjects = vi.fn().mockReturnValue([
			{ slug: "remaining", title: "Remaining", directory: "/remaining" },
		]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as any,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				removeProject,
				getProjects,
			} as any,
		});
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.broadcast).mockImplementation(
			(msg: RelayMessage) => {
				sent.push(msg);
			},
		);

		await handleRemoveProject(deps, "c1", { slug: "old-project" });

		expect(removeProject).toHaveBeenCalledWith("old-project");
		expect(sent).toHaveLength(1);
		expect((sent[0] as any).type).toBe("project_list");
		expect((sent[0] as any).projects).toHaveLength(1);
	});

	it("sends error when removeProject is not available", async () => {
		const deps = createMockHandlerDeps();
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);

		await handleRemoveProject(deps, "c1", { slug: "foo" });

		expect(sent).toHaveLength(1);
		expect((sent[0] as any).type).toBe("error");
	});

	it("sends error for empty slug", async () => {
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as any,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				removeProject: vi.fn(),
			} as any,
		});
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);

		await handleRemoveProject(deps, "c1", { slug: "" });

		expect((sent[0] as any).type).toBe("error");
	});
});

describe("handleRenameProject", () => {
	it("calls setProjectTitle and broadcasts updated project list", async () => {
		const setProjectTitle = vi.fn();
		const getProjects = vi.fn().mockReturnValue([
			{ slug: "my-proj", title: "New Name", directory: "/my-proj" },
		]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as any,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle,
				getProjects,
			} as any,
		});
		const broadcast: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.broadcast).mockImplementation(
			(msg: RelayMessage) => {
				broadcast.push(msg);
			},
		);

		await handleRenameProject(deps, "c1", {
			slug: "my-proj",
			title: "New Name",
		});

		expect(setProjectTitle).toHaveBeenCalledWith("my-proj", "New Name");
		expect(broadcast).toHaveLength(1);
		expect((broadcast[0] as any).type).toBe("project_list");
	});

	it("trims title and rejects empty", async () => {
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as any,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle: vi.fn(),
			} as any,
		});
		const sent: RelayMessage[] = [];
		vi.mocked(deps.wsHandler.sendTo).mockImplementation(
			(_id: string, msg: RelayMessage) => {
				sent.push(msg);
			},
		);

		await handleRenameProject(deps, "c1", { slug: "proj", title: "   " });

		expect((sent[0] as any).type).toBe("error");
	});

	it("truncates title to 100 chars", async () => {
		const setProjectTitle = vi.fn();
		const getProjects = vi.fn().mockReturnValue([]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as any,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle,
				getProjects,
			} as any,
		});
		vi.mocked(deps.wsHandler.broadcast).mockImplementation(() => {});

		const longTitle = "A".repeat(150);
		await handleRenameProject(deps, "c1", { slug: "proj", title: longTitle });

		expect(setProjectTitle).toHaveBeenCalledWith("proj", "A".repeat(100));
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/project-management.test.ts`
Expected: FAIL — handlers don't exist

**Step 3: Add payload types**

In `src/lib/handlers/payloads.ts`, add after `list_directories`:

```typescript
	remove_project: { slug: string };
	rename_project: { slug: string; title: string };
```

In `src/lib/server/ws-router.ts`, add `"remove_project"` and `"rename_project"` to both `IncomingMessageType` and `VALID_MESSAGE_TYPES`.

**Step 4: Add `removeProject` and `setProjectTitle` to HandlerDeps and ProjectRelayConfig**

In `src/lib/handlers/types.ts`, add to the `HandlerDeps` interface (after line 80, before the closing `}`):

```typescript
	/** Remove a project from the registry (optional — daemon mode only). */
	removeProject?: (slug: string) => void | Promise<void>;
	/** Set a project's display title (optional — daemon mode only). */
	setProjectTitle?: (slug: string, title: string) => void;
```

In `src/lib/types.ts`, add to the `ProjectRelayConfig` interface (after line 216):

```typescript
	/** Remove a project from the registry. */
	removeProject?: (slug: string) => void | Promise<void>;
	/** Set a project's display title. */
	setProjectTitle?: (slug: string, title: string) => void;
```

**Step 5: Wire through relay-stack**

In `src/lib/relay/relay-stack.ts`, in the `createProjectRelay` function where HandlerDeps are constructed (search for `addProject: addProjectRelay`), add:

```typescript
				removeProject: config.removeProject,
				setProjectTitle: config.setProjectTitle,
```

Also do the same for the daemon config that's constructed (near line 911 and 946).

**Step 6: Wire in daemon.ts**

In `src/lib/daemon/daemon.ts`, in `buildRelayFactory()` (around line 1139), add after the `addProject` wiring:

```typescript
				removeProject: async (slug: string) => {
					await this.removeProject(slug);
				},
				setProjectTitle: (slug: string, title: string) => {
					this.registry.updateProject(slug, { title });
					this.persistConfig();
				},
```

**Step 7: Write handler implementations**

In `src/lib/handlers/settings.ts`, add:

```typescript
export async function handleRemoveProject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["remove_project"],
): Promise<void> {
	const { slug } = payload;
	if (!slug || typeof slug !== "string") {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("remove_project requires a non-empty 'slug' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	if (!deps.config.removeProject) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Removing projects is not supported in this mode", {
				code: "NOT_SUPPORTED",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.config.removeProject(slug);
		const updatedProjects = deps.config.getProjects
			? deps.config.getProjects()
			: [];
		deps.wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: deps.config.slug,
		});
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "REMOVE_PROJECT_FAILED").toMessage(),
		);
	}
}

const MAX_PROJECT_TITLE_LENGTH = 100;

export async function handleRenameProject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["rename_project"],
): Promise<void> {
	const { slug } = payload;
	if (!slug || typeof slug !== "string") {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("rename_project requires a non-empty 'slug' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	if (!deps.config.setProjectTitle) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Renaming projects is not supported in this mode", {
				code: "NOT_SUPPORTED",
			}).toMessage(),
		);
		return;
	}
	let title = (payload.title ?? "").trim();
	if (!title) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("rename_project requires a non-empty 'title' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	title = title.slice(0, MAX_PROJECT_TITLE_LENGTH);
	try {
		deps.config.setProjectTitle(slug, title);
		const updatedProjects = deps.config.getProjects
			? deps.config.getProjects()
			: [];
		deps.wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: deps.config.slug,
		});
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "RENAME_PROJECT_FAILED").toMessage(),
		);
	}
}
```

**Step 8: Register in dispatch table**

In `src/lib/handlers/index.ts`, add `handleRemoveProject` and `handleRenameProject` to the exports, imports, and `MESSAGE_HANDLERS` dispatch table:

```typescript
	remove_project: handleRemoveProject as MessageHandler,
	rename_project: handleRenameProject as MessageHandler,
```

**Step 9: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/project-management.test.ts`
Expected: PASS

**Step 10: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 11: Commit**

```bash
git add -A && git commit -m "feat: add remove_project and rename_project WebSocket handlers"
```

---

### Task 3: Create DirectoryAutocomplete.svelte Component

**Files:**
- Create: `src/lib/frontend/components/project/DirectoryAutocomplete.svelte`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts:336-345` (add `directory_list` routing)
- Modify: `src/lib/frontend/stores/ws-listeners.ts` (add `directoryListeners` set)

**Step 1: Add directory list message routing**

In `src/lib/frontend/stores/ws-listeners.ts`, add:

```typescript
export const directoryListeners = new Set<MessageListener>();

/** Subscribe to directory listing messages. Returns unsubscribe function. */
export function onDirectoryList(fn: MessageListener): () => void {
	directoryListeners.add(fn);
	return () => directoryListeners.delete(fn);
}
```

In `src/lib/frontend/stores/ws-dispatch.ts`, add a case in the dispatch switch (after the `project_list` case):

```typescript
		// ─── Directory Listing ──────────────────────────────────────
		case "directory_list":
			for (const fn of directoryListeners) fn(msg);
			break;
```

And import `directoryListeners` at the top.

**Step 2: Create the DirectoryAutocomplete component**

Create `src/lib/frontend/components/project/DirectoryAutocomplete.svelte`:

```svelte
<!-- ─── DirectoryAutocomplete ──────────────────────────────────────────────── -->
<!-- Drop-up autocomplete for filesystem directory paths. Sends list_directories -->
<!-- over WebSocket on debounced input changes. Arrow keys + Enter to select,  -->
<!-- Tab to drill into a directory level (terminal-style tab-completion).       -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { onDirectoryList } from "../../stores/ws-listeners.js";
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		value = $bindable(""),
		placeholder = "/path/to/project",
		onsubmit,
	}: {
		value?: string;
		placeholder?: string;
		onsubmit?: () => void;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let entries: string[] = $state([]);
	let activeIndex = $state(0);
	let visible = $state(false);
	let loading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inputEl: HTMLInputElement | undefined = $state(undefined);

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	let unsubDir: (() => void) | undefined;

	onMount(() => {
		unsubDir = onDirectoryList((msg) => {
			if (msg.type !== "directory_list") return;
			const dirMsg = msg as { type: "directory_list"; path: string; entries: string[] };
			entries = dirMsg.entries;
			activeIndex = 0;
			loading = false;
			visible = entries.length > 0;
		});
	});

	onDestroy(() => {
		unsubDir?.();
		if (debounceTimer) clearTimeout(debounceTimer);
	});

	// ─── Input handling ─────────────────────────────────────────────────────────

	function requestDirectories(path: string) {
		if (!path || path.length < 1) {
			entries = [];
			visible = false;
			return;
		}
		loading = true;
		wsSend({ type: "list_directories", path });
	}

	function handleInput() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			requestDirectories(value);
		}, 150);
	}

	function selectEntry(entry: string) {
		value = entry;
		visible = false;
		entries = [];
	}

	function drillInto(entry: string) {
		value = entry;
		// Immediately request next level
		requestDirectories(entry);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!visible || entries.length === 0) {
			if (e.key === "Enter") {
				e.preventDefault();
				onsubmit?.();
			} else if (e.key === "Escape") {
				e.preventDefault();
				visible = false;
			}
			return;
		}

		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				activeIndex = (activeIndex + 1) % entries.length;
				scrollActiveIntoView();
				break;
			case "ArrowUp":
				e.preventDefault();
				activeIndex = (activeIndex - 1 + entries.length) % entries.length;
				scrollActiveIntoView();
				break;
			case "Tab": {
				e.preventDefault();
				const selected = entries[activeIndex];
				if (selected) drillInto(selected);
				break;
			}
			case "Enter": {
				e.preventDefault();
				const selected = entries[activeIndex];
				if (selected) selectEntry(selected);
				break;
			}
			case "Escape":
				e.preventDefault();
				visible = false;
				break;
		}
	}

	function handleBlur() {
		// Delay closing so click events on entries register first
		setTimeout(() => {
			visible = false;
		}, 200);
	}

	function handleFocus() {
		if (value && entries.length > 0) {
			visible = true;
		} else if (value) {
			requestDirectories(value);
		}
	}

	function scrollActiveIntoView() {
		requestAnimationFrame(() => {
			const menu = document.querySelector(".dir-autocomplete-list");
			const activeItem = menu?.querySelector(".dir-item-active");
			if (activeItem) {
				activeItem.scrollIntoView({ block: "nearest" });
			}
		});
	}

	// Reset active index when entries change
	$effect(() => {
		void entries.length;
		activeIndex = 0;
	});
</script>

<div class="relative">
	<!-- Drop-up popup -->
	{#if visible && entries.length > 0}
		<div class="dir-autocomplete-list absolute bottom-full left-0 right-0 mb-1 bg-bg-surface border border-border rounded-lg shadow-[0_-4px_16px_rgba(0,0,0,0.3)] max-h-[200px] overflow-y-auto z-[130] py-1">
			{#each entries as entry, i}
				{@const displayName = entry.endsWith("/")
					? entry.slice(entry.lastIndexOf("/", entry.length - 2) + 1)
					: entry.split("/").pop() ?? entry}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="dir-item flex items-center gap-2 py-1.5 px-3 cursor-pointer transition-colors duration-100 text-[12px] font-mono
						{i === activeIndex ? 'dir-item-active bg-accent-bg' : 'hover:bg-bg-alt'}"
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					onmousedown={(e) => {
						e.preventDefault();
						selectEntry(entry);
					}}
					onmouseenter={() => { activeIndex = i; }}
				>
					<Icon name="folder" size={13} class="shrink-0 text-warning" />
					<span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
						<span class="text-text-muted">{entry.slice(0, entry.length - displayName.length)}</span><span class="text-text">{displayName}</span>
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Input -->
	<input
		bind:this={inputEl}
		type="text"
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-[12px] text-text font-mono outline-none focus:border-accent placeholder:text-text-dimmer"
		bind:value
		oninput={handleInput}
		onkeydown={handleKeydown}
		onblur={handleBlur}
		onfocus={handleFocus}
	/>
</div>
```

**Step 3: Run verification**

Run: `pnpm check && pnpm lint`
Expected: All pass

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: create DirectoryAutocomplete component with drop-up popup"
```

---

### Task 4: Integrate DirectoryAutocomplete into ProjectSwitcher

**Files:**
- Modify: `src/lib/frontend/components/project/ProjectSwitcher.svelte`

**Step 1: Replace the plain input with DirectoryAutocomplete**

In `ProjectSwitcher.svelte`, replace the add-project form's `<input>` element (lines 346-354) with the `DirectoryAutocomplete` component. Import it at the top.

Replace:
```svelte
<input
	type="text"
	placeholder="/path/to/project"
	autocomplete="off"
	spellcheck="false"
	class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-[12px] text-text font-mono outline-none focus:border-accent placeholder:text-text-dimmer"
	bind:value={addDirectory}
	onkeydown={handleAddKeydown}
/>
```

With:
```svelte
<DirectoryAutocomplete
	bind:value={addDirectory}
	onsubmit={handleSubmitAdd}
/>
```

Remove `handleAddKeydown` function (the DirectoryAutocomplete handles Enter/Escape internally — Enter when no autocomplete is shown calls `onsubmit`, Escape closes the autocomplete popup or can be handled by the existing `handleKeydown` document listener).

Actually, we need to keep Escape working to cancel the add form. The DirectoryAutocomplete handles Escape to close its own popup; if the popup is already closed, the existing document-level `handleKeydown` on the ProjectSwitcher will catch it and call `handleCancelAdd`.

Add the import:
```svelte
import DirectoryAutocomplete from "./DirectoryAutocomplete.svelte";
```

**Step 2: Run verification**

Run: `pnpm check && pnpm lint`
Expected: All pass

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: integrate DirectoryAutocomplete into ProjectSwitcher add form"
```

---

### Task 5: Create ProjectContextMenu.svelte Component

**Files:**
- Create: `src/lib/frontend/components/project/ProjectContextMenu.svelte`

**Step 1: Create the component**

Create `src/lib/frontend/components/project/ProjectContextMenu.svelte`, modeled after `SessionContextMenu.svelte`:

```svelte
<!-- ─── ProjectContextMenu ──────────────────────────────────────────────────── -->
<!-- Dropdown menu for project actions: Rename, Remove (delete). -->
<!-- Positioned relative to the anchor element (the "..." button). -->

<script lang="ts">
	import type { ProjectInfo } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		project,
		anchor,
		onrename,
		ondelete,
		onclose,
	}: {
		project: ProjectInfo;
		anchor: HTMLElement;
		onrename: (slug: string) => void;
		ondelete: (slug: string, title: string) => void;
		onclose: () => void;
	} = $props();

	// ─── Positioning ─────────────────────────────────────────────────────────────

	const menuStyle = $derived.by(() => {
		if (!anchor) return "";
		const rect = anchor.getBoundingClientRect();
		return `top: ${rect.bottom + 4}px; left: ${rect.right}px; transform: translateX(-100%);`;
	});

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleRename(e: MouseEvent) {
		e.stopPropagation();
		onrename(project.slug);
		onclose();
	}

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		ondelete(project.slug, project.title);
		onclose();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			onclose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Invisible backdrop to catch clicks outside -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[200]"
	onclick={handleBackdropClick}
>
	<!-- Menu dropdown -->
	<div
		class="fixed z-[201] min-w-[160px] bg-bg-alt border border-border rounded-lg py-1 shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)]"
		style={menuStyle}
		onclick={(e) => e.stopPropagation()}
	>
		<!-- Rename -->
		<button
			class="flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-text-secondary text-[13px] font-mono cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={handleRename}
		>
			<Icon name="pencil" size={14} />
			<span>Rename</span>
		</button>

		<!-- Remove -->
		<button
			class="flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-[13px] font-mono cursor-pointer text-left transition-colors duration-100 text-error hover:bg-error/10 hover:text-error"
			onclick={handleDelete}
		>
			<Icon name="trash-2" size={14} />
			<span>Remove</span>
		</button>
	</div>
</div>
```

**Step 2: Run verification**

Run: `pnpm check && pnpm lint`
Expected: All pass

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: create ProjectContextMenu component with Rename and Remove actions"
```

---

### Task 6: Integrate Context Menu into ProjectSwitcher

**Files:**
- Modify: `src/lib/frontend/components/project/ProjectSwitcher.svelte`

**Step 1: Add context menu state and handlers to ProjectSwitcher**

In `ProjectSwitcher.svelte` `<script>` section, add imports and state:

```typescript
import ProjectContextMenu from "./ProjectContextMenu.svelte";
import { confirm } from "../../stores/ui.svelte.js";

// Context menu state
let ctxMenuProject: ProjectInfo | null = $state(null);
let ctxMenuAnchor: HTMLElement | null = $state(null);

// Rename state
let renamingSlug: string | null = $state(null);
let renameValue = $state("");

function handleProjectContextMenu(project: ProjectInfo, anchor: HTMLElement) {
	ctxMenuProject = project;
	ctxMenuAnchor = anchor;
}

function handleCloseContextMenu() {
	ctxMenuProject = null;
	ctxMenuAnchor = null;
}

function handleCtxRename(slug: string) {
	renamingSlug = slug;
	const proj = projects.find(p => p.slug === slug);
	renameValue = proj?.title ?? slug;
}

async function handleCtxDelete(slug: string, title: string) {
	const confirmed = await confirm(
		`Remove project '${title}' from conduit?`,
		"Remove",
	);
	if (confirmed) {
		wsSend({ type: "remove_project", slug });
		// If we just deleted the current project, the project_list broadcast
		// will update the store; navigation handled by the store listener.
	}
}

function commitProjectRename(slug: string) {
	const newTitle = renameValue.trim();
	renamingSlug = null;
	if (newTitle && newTitle.length > 0) {
		const proj = projects.find(p => p.slug === slug);
		if (proj && newTitle !== proj.title) {
			wsSend({ type: "rename_project", slug, title: newTitle });
		}
	}
}

function cancelProjectRename() {
	renamingSlug = null;
}

function handleRenameKeydown(e: KeyboardEvent, slug: string) {
	if (e.key === "Enter") {
		e.preventDefault();
		e.stopPropagation();
		commitProjectRename(slug);
	} else if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		cancelProjectRename();
	}
}
```

**Step 2: Add the `...` button and inline rename to each project item**

In the project item template (both multi-instance and single-instance loops), modify each project `<a>` element to include:

1. A `...` button (always visible) on the right side
2. When `renamingSlug === project.slug`, replace the title span with an inline input

For each project item, replace the title `<span>` and add the `...` button. The general pattern for each project item becomes:

```svelte
{@const isRenaming = renamingSlug === project.slug}
<a
	href="/p/{project.slug}/"
	data-testid="project-item"
	data-slug={project.slug}
	class="group flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit{isActive ? ' bg-bg-surface' : ''}"
	style={isActive ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
	onclick={(e) => {
		if (isRenaming) { e.preventDefault(); return; }
		selectProject(e, project.slug);
	}}
>
	<!-- Indicator dot -->
	<span class="w-1.5 h-1.5 rounded-full shrink-0{isActive ? ' bg-accent' : ' bg-text-dimmer/40'}"></span>
	<!-- Name (or rename input) -->
	{#if isRenaming}
		<input
			type="text"
			class="flex-1 min-w-0 bg-input-bg border border-accent rounded py-px px-1 text-xs text-text outline-none"
			style="font-family: var(--font-brand);"
			bind:value={renameValue}
			onkeydown={(e) => handleRenameKeydown(e, project.slug)}
			onblur={() => commitProjectRename(project.slug)}
			onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
			use:focusOnMount
		/>
	{:else}
		<span class="flex-1 text-[13px] truncate{isActive ? ' font-semibold text-text' : ' text-text-secondary'}">
			{project.title}
		</span>
	{/if}
	<!-- Client count -->
	{#if !isRenaming && project.clientCount && project.clientCount > 0}
		<span class="shrink-0 text-xs text-text-dimmer tabular-nums">{project.clientCount}</span>
	{/if}
	<!-- More button -->
	{#if !isRenaming}
		<button
			class="proj-more-btn shrink-0 w-5 h-5 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer/50 hover:text-text hover:bg-bg-alt transition-[opacity,color] duration-100"
			title="More options"
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				handleProjectContextMenu(project, e.currentTarget as HTMLElement);
			}}
		>
			<Icon name="ellipsis" size={13} />
		</button>
	{/if}
</a>
```

Also add a `focusOnMount` action function if not already present:

```typescript
function focusOnMount(node: HTMLElement) {
	node.focus();
}
```

**Step 3: Render the context menu and handle Escape**

At the bottom of the component template (before `</div>`), add:

```svelte
{#if ctxMenuProject && ctxMenuAnchor}
	<ProjectContextMenu
		project={ctxMenuProject}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		ondelete={handleCtxDelete}
		onclose={handleCloseContextMenu}
	/>
{/if}
```

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: All pass

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: integrate project context menu into ProjectSwitcher with rename/delete"
```

---

### Task 7: Add Context Menu to DashboardPage

**Files:**
- Modify: `src/lib/frontend/pages/DashboardPage.svelte`

**Step 1: Add context menu and rename/delete functionality**

Import the required modules:

```typescript
import ProjectContextMenu from "../components/project/ProjectContextMenu.svelte";
import Icon from "../components/shared/Icon.svelte";
import { confirm } from "../stores/ui.svelte.js";
```

The DashboardPage doesn't use WebSocket currently — it uses REST polling. For the `remove_project` and `rename_project` operations, we need to send WebSocket messages. Import `wsSend`:

```typescript
import { wsSend } from "../stores/ws.svelte.js";
```

Add state and handlers:

```typescript
// Context menu state
let ctxMenuProject: DashboardProject | null = $state(null);
let ctxMenuAnchor: HTMLElement | null = $state(null);

// Rename state
let renamingSlug: string | null = $state(null);
let renameValue = $state("");

function handleProjectContextMenu(project: DashboardProject, anchor: HTMLElement) {
	ctxMenuProject = project;
	ctxMenuAnchor = anchor;
}

function handleCloseContextMenu() {
	ctxMenuProject = null;
	ctxMenuAnchor = null;
}

function handleCtxRename(slug: string) {
	renamingSlug = slug;
	const proj = projects.find(p => p.slug === slug);
	renameValue = proj?.title ?? slug;
}

async function handleCtxDelete(slug: string, title: string) {
	const confirmed = await confirm(
		`Remove project '${title}' from conduit?`,
		"Remove",
	);
	if (confirmed) {
		wsSend({ type: "remove_project", slug });
		// Re-fetch project list after a short delay to reflect the change
		setTimeout(() => fetchProjects(), 500);
	}
}

function commitProjectRename(slug: string) {
	const newTitle = renameValue.trim();
	renamingSlug = null;
	if (newTitle && newTitle.length > 0) {
		const proj = projects.find(p => p.slug === slug);
		if (proj && newTitle !== proj.title) {
			wsSend({ type: "rename_project", slug, title: newTitle });
			setTimeout(() => fetchProjects(), 500);
		}
	}
}

function cancelProjectRename() {
	renamingSlug = null;
}

function handleRenameKeydown(e: KeyboardEvent, slug: string) {
	if (e.key === "Enter") {
		e.preventDefault();
		commitProjectRename(slug);
	} else if (e.key === "Escape") {
		e.preventDefault();
		cancelProjectRename();
	}
}

function focusOnMount(node: HTMLElement) {
	node.focus();
}
```

**Step 2: Update project card template**

Modify each project card to include a `...` button and support inline rename. In the `{#each projects as project}` block, add to the card:

```svelte
{@const isRenaming = renamingSlug === project.slug}
<a
	href="/p/{project.slug}/"
	data-testid="project-card"
	data-slug={project.slug}
	class="group block bg-bg-alt border border-border rounded-xl p-[16px_20px] no-underline text-text transition-[border-color,background] hover:border-accent hover:bg-bg-surface"
	onclick={(e) => {
		if (isRenaming) { e.preventDefault(); return; }
		handleCardClick(e, project.slug);
	}}
>
	<div class="flex items-center justify-between gap-2">
		<div class="text-[16px] font-semibold flex items-center gap-2 min-w-0 flex-1">
			{#if isRenaming}
				<input
					type="text"
					class="flex-1 min-w-0 bg-input-bg border border-accent rounded py-px px-1 text-sm text-text outline-none"
					bind:value={renameValue}
					onkeydown={(e) => handleRenameKeydown(e, project.slug)}
					onblur={() => commitProjectRename(project.slug)}
					onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
					use:focusOnMount
				/>
			{:else}
				<span class="truncate">{displayName(project)}</span>
				<span class="text-sm">{statusIcon(project)}</span>
			{/if}
		</div>
		{#if !isRenaming}
			<button
				class="shrink-0 w-6 h-6 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer opacity-0 group-hover:opacity-100 hover:text-text hover:bg-bg-alt transition-[opacity,color] duration-100"
				title="More options"
				onclick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					handleProjectContextMenu(project, e.currentTarget as HTMLElement);
				}}
			>
				<Icon name="ellipsis" size={15} />
			</button>
		{/if}
	</div>
	<div class="text-xs text-text-muted mt-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap">
		{project.path}
	</div>
	{#if project.status === "error" && project.error}
		<span class="block text-xs text-red-400 truncate mt-0.5" title={project.error}>
			{project.error}
		</span>
	{/if}
	<div class="text-xs text-text-dimmer mt-2">
		{sessionLabel(project.sessions)} &middot; {clientLabel(project.clients)}
	</div>
</a>
```

Note: On the Dashboard, the `...` button should appear on hover (via group-hover opacity) since the cards are larger and always-visible dots would be more distracting in this card-style layout.

Wait — the design says "Always visible on right side" for both locations. Let me change the dashboard button to match: remove `opacity-0 group-hover:opacity-100` and use regular visible styling instead.

**Step 3: Render the context menu**

Add at the bottom of the template:

```svelte
{#if ctxMenuProject && ctxMenuAnchor}
	<ProjectContextMenu
		project={{ slug: ctxMenuProject.slug, title: ctxMenuProject.title, directory: ctxMenuProject.path }}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		ondelete={handleCtxDelete}
		onclose={handleCloseContextMenu}
	/>
{/if}
```

Note: `DashboardProjectResponse` has `path` not `directory`, so we adapt. The `ProjectContextMenu` expects `ProjectInfo` which has `directory`. We construct a compatible object.

**Step 4: Run verification**

Run: `pnpm check && pnpm lint`
Expected: All pass

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add project context menu to DashboardPage with rename/delete"
```

---

### Task 8: Final Integration Verification

**Step 1: Run full verification suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass — all 3301+ tests pass, no type errors, no lint errors

**Step 2: Commit design doc (if not already)**

Make sure `docs/plans/2026-03-23-project-management-improvements-design.md` is committed.

```bash
git add docs/plans/ && git commit -m "docs: add project management improvements design and implementation plan"
```
