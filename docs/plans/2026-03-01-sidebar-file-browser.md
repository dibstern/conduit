# Sidebar File Browser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the file browser from a floating overlay into the sidebar as a sub-panel, wiring up the vestigial `sidebarPanel` state.

**Architecture:** Extract a new `SidebarFilePanel.svelte` component that owns file tree WS subscriptions, breadcrumbs, and tree rendering. `Sidebar.svelte` conditionally renders it based on `uiState.sidebarPanel`. Delete the old `FileBrowser.svelte` overlay and remove `fileBrowserOpen` state.

**Tech Stack:** Svelte 5 (runes), TypeScript, Tailwind CSS, Vitest, Playwright

---

### Task 1: Add unit tests for sidebarPanel state transitions

**Files:**
- Modify: `test/unit/svelte-ui-store.test.ts` (append after line 318)

**Step 1: Write the failing tests**

Add to end of `test/unit/svelte-ui-store.test.ts`:

```typescript
// ─── Sidebar panel switching ────────────────────────────────────────────────

describe("setSidebarPanel", () => {
	it("switches from sessions to files", () => {
		setSidebarPanel("files");
		expect(uiState.sidebarPanel).toBe("files");
	});

	it("switches from files to sessions", () => {
		uiState.sidebarPanel = "files";
		setSidebarPanel("sessions");
		expect(uiState.sidebarPanel).toBe("sessions");
	});

	it("is idempotent", () => {
		setSidebarPanel("files");
		setSidebarPanel("files");
		expect(uiState.sidebarPanel).toBe("files");
	});
});
```

Also add `setSidebarPanel` to the import at the top of the file (line 33-51), alongside the existing imports from `ui.svelte.js`.

**Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/unit/svelte-ui-store.test.ts`
Expected: PASS — `setSidebarPanel` already exists in `ui.svelte.ts` (line 110-112), it's just unused. These tests verify the existing function works.

**Step 3: Commit**

```bash
git add test/unit/svelte-ui-store.test.ts
git commit -m "test: add sidebarPanel state transition tests (ticket 10.2)"
```

---

### Task 2: Remove fileBrowserOpen state and wire up sidebarPanel

**Files:**
- Modify: `src/lib/public/stores/ui.svelte.ts`
- Modify: `test/unit/svelte-ui-store.test.ts`

**Step 1: Write failing tests for fileBrowserOpen removal**

Add to end of `test/unit/svelte-ui-store.test.ts`:

```typescript
describe("fileBrowserOpen removal", () => {
	it("uiState does not have fileBrowserOpen property", () => {
		expect("fileBrowserOpen" in uiState).toBe(false);
	});
});

describe("resetProjectUI resets sidebarPanel", () => {
	it("resets sidebarPanel to sessions", () => {
		uiState.sidebarPanel = "files";
		resetProjectUI();
		expect(uiState.sidebarPanel).toBe("sessions");
	});
});
```

Also add `resetProjectUI` to the import from `ui.svelte.js`.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/svelte-ui-store.test.ts`
Expected: FAIL — `fileBrowserOpen` still exists in uiState.

**Step 3: Modify ui.svelte.ts**

In `src/lib/public/stores/ui.svelte.ts`:

1. **Delete line 64** (`fileBrowserOpen: false,`).

2. **Delete lines 245-253** (the `openFileBrowser` and `closeFileBrowser` functions):
```typescript
// DELETE this entire section:
// ─── File browser actions ───────────────────────────────────────────────────

export function openFileBrowser(): void {
	uiState.fileBrowserOpen = true;
}

export function closeFileBrowser(): void {
	uiState.fileBrowserOpen = false;
}
```

3. **In `resetProjectUI` (line 294)**, replace `uiState.fileBrowserOpen = false;` with `uiState.sidebarPanel = "sessions";`.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/svelte-ui-store.test.ts`
Expected: PASS

Note: Other tests may now fail due to removed exports. That's expected — we'll fix consumers in subsequent tasks.

**Step 5: Commit**

```bash
git add src/lib/public/stores/ui.svelte.ts test/unit/svelte-ui-store.test.ts
git commit -m "refactor: remove fileBrowserOpen, wire sidebarPanel to resetProjectUI (ticket 10.2)"
```

---

### Task 3: Create SidebarFilePanel.svelte

**Files:**
- Create: `src/lib/public/components/features/SidebarFilePanel.svelte`

**Step 1: Create the component**

Create `src/lib/public/components/features/SidebarFilePanel.svelte`:

```svelte
<!-- ─── Sidebar File Panel ───────────────────────────────────────────────────── -->
<!-- Inline file browser panel rendered inside the sidebar when sidebarPanel -->
<!-- is "files". Owns WS subscriptions for file_list/file_content. -->

<script lang="ts">
	import type { BreadcrumbSegment, FileEntry, RelayMessage } from "../../types.js";
	import { wsSend, onFileBrowser } from "../../stores/ws.svelte.js";
	import { openFileViewer, setSidebarPanel, closeMobileSidebar } from "../../stores/ui.svelte.js";
	import FileTreeNode from "./FileTreeNode.svelte";
	import Icon from "../shared/Icon.svelte";

	// ─── State ─────────────────────────────────────────────────────────────────

	let currentPath = $state(".");
	let entries = $state<FileEntry[]>([]);
	let loading = $state(false);

	// Directory cache — keyed by full path, stores sorted entries for that directory.
	const dirCache = new Map<string, FileEntry[]>();

	// Subdirectory children — reactive Map so FileTreeNode re-renders when new
	// directory contents arrive. Must be reassigned (not mutated) for Svelte 5.
	let dirChildren = $state(new Map<string, FileEntry[]>());

	// ─── Breadcrumbs ────────────────────────────────────────────────────────────

	const breadcrumbs = $derived.by((): BreadcrumbSegment[] => {
		if (currentPath === ".") return [{ label: "/", path: "." }];
		const parts = currentPath.split("/").filter(Boolean);
		const segments: BreadcrumbSegment[] = [{ label: "/", path: "." }];
		let accum = "";
		for (const part of parts) {
			accum = accum ? `${accum}/${part}` : part;
			segments.push({ label: part, path: accum });
		}
		return segments;
	});

	// ─── Directory loading ──────────────────────────────────────────────────────

	function loadDirectory(path: string) {
		if (dirCache.has(path)) {
			entries = dirCache.get(path)!;
			currentPath = path;
			return;
		}
		loading = true;
		currentPath = path;
		wsSend({ type: "get_file_list", path });
	}

	function sortEntries(fileEntries: FileEntry[]): FileEntry[] {
		return [...fileEntries].sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	function handleFileList(path: string, fileEntries: FileEntry[]) {
		const sorted = sortEntries(fileEntries);
		dirCache.set(path, sorted);

		if (currentPath === path) {
			entries = sorted;
			loading = false;
		}

		dirChildren = new Map([...dirChildren, [path, sorted]]);
	}

	function getChildrenForPath(path: string): FileEntry[] | undefined {
		return dirChildren.get(path);
	}

	function navigateTo(path: string) {
		loadDirectory(path);
	}

	function handleFileClick(fullPath: string) {
		openFileViewer(fullPath);
		wsSend({ type: "get_file_content", path: fullPath });
		// On mobile, close the sidebar so it doesn't overlap the file viewer
		if (typeof window !== "undefined" && window.innerWidth < 768) {
			closeMobileSidebar();
		}
	}

	function handleDirClick(fullPath: string) {
		if (!dirChildren.has(fullPath)) {
			wsSend({ type: "get_file_list", path: fullPath });
		}
	}

	function handleBack() {
		setSidebarPanel("sessions");
	}

	function refresh() {
		dirCache.clear();
		dirChildren = new Map<string, FileEntry[]>();
		loadDirectory(currentPath);
	}

	// ─── WS message subscription ───────────────────────────────────────────────

	$effect(() => {
		const unsub = onFileBrowser((msg: RelayMessage) => {
			if (msg.type === "file_list") {
				handleFileList(msg.path, msg.entries);
			}
		});
		return unsub;
	});

	// Load root directory on mount
	$effect(() => {
		if (entries.length === 0) {
			loadDirectory(".");
		}
	});
</script>

<div
	id="sidebar-panel-files"
	class="sidebar-panel flex flex-col flex-1 overflow-hidden"
>
	<!-- Back button -->
	<div class="px-2.5 py-2 shrink-0">
		<button
			id="file-panel-back"
			class="flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-100 text-left hover:bg-[hsl(0,8%,94%)] hover:text-text"
			onclick={handleBack}
		>
			<Icon name="arrow-left" size={16} class="shrink-0" />
			<span class="overflow-hidden text-ellipsis whitespace-nowrap">Back to sessions</span>
		</button>
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-1 shrink-0">
		<div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.5px] text-text-dimmer">
			<span>Files</span>
		</div>
		<button
			class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-black/[0.04] hover:text-text"
			onclick={refresh}
			title="Refresh"
		>
			<Icon name="refresh-cw" size={14} />
		</button>
	</div>

	<!-- Breadcrumbs -->
	<div class="fb-breadcrumbs flex items-center gap-0.5 px-4 py-1.5 text-xs text-text-muted overflow-x-auto shrink-0">
		{#each breadcrumbs as crumb, i (crumb.path)}
			{#if i > 0}
				<span class="text-text-dimmer">/</span>
			{/if}
			{#if i === breadcrumbs.length - 1}
				<span class="fb-crumb-active text-text font-medium">{crumb.label}</span>
			{:else}
				<button
					class="fb-crumb hover:text-text hover:underline cursor-pointer bg-transparent border-none text-text-muted text-xs p-0"
					onclick={() => navigateTo(crumb.path)}
				>
					{crumb.label}
				</button>
			{/if}
		{/each}
	</div>

	<!-- File tree -->
	<div id="file-tree" class="flex-1 overflow-y-auto px-1">
		{#if loading}
			<div class="flex items-center justify-center py-8 text-text-dimmer text-sm">
				<Icon name="loader" size={16} class="icon-spin" />
				<span class="ml-2">Loading...</span>
			</div>
		{:else if entries.length === 0}
			<div class="text-center py-8 text-text-dimmer text-sm">
				Empty directory
			</div>
		{:else}
			{#each entries as entry (entry.name)}
				<FileTreeNode
					{entry}
					parentPath={currentPath}
					onFileClick={handleFileClick}
					onDirClick={handleDirClick}
					getChildren={getChildrenForPath}
				/>
			{/each}
		{/if}
	</div>
</div>
```

**Step 2: Verify no TypeScript errors**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/public/components/features/SidebarFilePanel.svelte
git commit -m "feat: create SidebarFilePanel component (ticket 10.2)"
```

---

### Task 4: Wire SidebarFilePanel into Sidebar.svelte

**Files:**
- Modify: `src/lib/public/components/layout/Sidebar.svelte`

**Step 1: Update Sidebar.svelte**

1. **Update imports** (lines 6-18). Replace the import of `openFileBrowser` with `setSidebarPanel`:

```typescript
import {
	uiState,
	collapseSidebar,
	closeMobileSidebar,
	setSidebarPanel,
} from "../../stores/ui.svelte.js";
```

2. **Add SidebarFilePanel import** after the `ProjectSwitcher` import (line 8):

```typescript
import SidebarFilePanel from "../features/SidebarFilePanel.svelte";
```

3. **Update handleFileBrowser** (lines 46-49). Replace the body:

```typescript
function handleFileBrowser() {
	setSidebarPanel("files");
	wsSend({ type: "get_file_list", path: "." });
}
```

4. **Add conditional rendering in the nav** (lines 121-216). Wrap the sessions panel in a conditional and add the files panel:

Replace:
```svelte
<nav id="sidebar-nav" class="flex-1 overflow-y-auto overflow-x-hidden">
	<!-- Sessions panel -->
	<div
		id="sidebar-panel-sessions"
		class="sidebar-panel flex flex-col flex-1 overflow-hidden"
	>
		...existing sessions content...
	</div>

	<!-- File browser is rendered as a floating overlay in ChatLayout -->
</nav>
```

With:
```svelte
<nav id="sidebar-nav" class="flex-1 overflow-y-auto overflow-x-hidden">
	{#if uiState.sidebarPanel === "sessions"}
		<!-- Sessions panel -->
		<div
			id="sidebar-panel-sessions"
			class="sidebar-panel flex flex-col flex-1 overflow-hidden"
		>
			...existing sessions content (unchanged)...
		</div>
	{:else}
		<!-- File browser panel -->
		<SidebarFilePanel />
	{/if}
</nav>
```

5. **Delete the comment** on line 215: `<!-- File browser is rendered as a floating overlay in ChatLayout -->`

**Step 2: Verify no TypeScript errors**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/public/components/layout/Sidebar.svelte
git commit -m "feat: wire SidebarFilePanel into Sidebar with panel switching (ticket 10.2)"
```

---

### Task 5: Remove FileBrowser overlay from ChatLayout.svelte

**Files:**
- Modify: `src/lib/public/components/layout/ChatLayout.svelte`

**Step 1: Update ChatLayout.svelte**

1. **Remove FileBrowser import** (line 22):
```typescript
// DELETE: import FileBrowser from "../features/FileBrowser.svelte";
```

2. **Remove closeFileBrowser from imports** (line 24). Update the import to remove `closeFileBrowser`:
```typescript
import { uiState, closeFileViewer, showToast, resetProjectUI } from "../../stores/ui.svelte.js";
```

3. **Delete line 318** — the FileBrowser overlay render:
```svelte
<!-- DELETE: <FileBrowser visible={uiState.fileBrowserOpen} onClose={closeFileBrowser} /> -->
```

**Step 2: Verify no TypeScript errors**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/lib/public/components/layout/ChatLayout.svelte
git commit -m "refactor: remove FileBrowser overlay from ChatLayout (ticket 10.2)"
```

---

### Task 6: Delete FileBrowser.svelte and its stories

**Files:**
- Delete: `src/lib/public/components/features/FileBrowser.svelte`
- Delete: `src/lib/public/components/features/FileBrowser.stories.ts`

**Step 1: Delete the files**

```bash
rm src/lib/public/components/features/FileBrowser.svelte
rm src/lib/public/components/features/FileBrowser.stories.ts
```

**Step 2: Verify no import errors**

Run: `pnpm check`
Expected: PASS — no other files should import `FileBrowser.svelte` after Task 5.

If there are remaining imports of `FileBrowser` or `openFileBrowser` / `closeFileBrowser`, fix them by removing the imports.

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. If any test imports `openFileBrowser` or `closeFileBrowser`, update those imports.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete FileBrowser overlay component (ticket 10.2)"
```

---

### Task 7: Update Sidebar.stories.ts for FileBrowserPanel

**Files:**
- Modify: `src/lib/public/components/layout/Sidebar.stories.ts`

**Step 1: Verify the existing FileBrowserPanel story works**

The story already sets `uiState.sidebarPanel = "files"`. Now that Sidebar reads this state, the story should actually render the file panel. No code changes needed — just verify it renders correctly.

Run: `pnpm storybook` (manual check) or verify build:
Run: `pnpm check`
Expected: PASS

**Step 2: Commit (only if changes were needed)**

If no changes needed, skip this commit.

---

### Task 8: Run full test suite and fix any remaining issues

**Files:**
- Any files that have broken imports

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All 1925+ tests pass.

**Step 2: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "fix: resolve remaining import issues after file browser migration (ticket 10.2)"
```

---

### Task 9: Verify E2E selectors match

**Files:**
- Read-only: `test/e2e/page-objects/sidebar.page.ts`

**Step 1: Verify DOM element IDs match E2E page object**

The E2E page object expects these selectors:
- `#sidebar-panel-files` — our `SidebarFilePanel` outer div ✓
- `#file-panel-back` — our back button ✓
- `#file-tree` — our file tree container ✓
- `#sidebar-panel-sessions` — existing sessions panel ✓

Verify by reading `SidebarFilePanel.svelte` and confirming the IDs match.

**Step 2: No commit needed — just verification**

---

### Summary of changes

| File | Action |
|------|--------|
| `src/lib/public/stores/ui.svelte.ts` | Remove `fileBrowserOpen`, `openFileBrowser()`, `closeFileBrowser()`; update `resetProjectUI` |
| `src/lib/public/components/features/SidebarFilePanel.svelte` | CREATE — new inline file browser panel |
| `src/lib/public/components/layout/Sidebar.svelte` | Conditional panel rendering, import `SidebarFilePanel`, use `setSidebarPanel` |
| `src/lib/public/components/layout/ChatLayout.svelte` | Remove `FileBrowser` import and overlay render |
| `src/lib/public/components/features/FileBrowser.svelte` | DELETE |
| `src/lib/public/components/features/FileBrowser.stories.ts` | DELETE |
| `test/unit/svelte-ui-store.test.ts` | Add sidebarPanel tests, fileBrowserOpen removal test |
