<!-- ─── Sidebar File Panel ───────────────────────────────────────────────────── -->
<!-- Inline file browser panel rendered inside the sidebar when sidebarPanel -->
<!-- is "files". Owns WS subscriptions for file_list/file_content. -->

<script lang="ts">
	import type { BreadcrumbSegment, FileEntry, RelayMessage } from "../../types.js";
	import { wsSend, onFileBrowser } from "../../stores/ws.svelte.js";
	import { openFileViewer, closeMobileSidebar, setSidebarPanel } from "../../stores/ui.svelte.js";
	import FileTreeNode from "./FileTreeNode.svelte";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

	// ─── State ─────────────────────────────────────────────────────────────────

	let currentPath = $state(".");
	let entries = $state<FileEntry[]>([]);
	let loading = $state(false);

	const dirCache = new Map<string, FileEntry[]>();
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
			// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after has() check
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
		if (typeof window !== "undefined" && window.innerWidth < 768) {
			closeMobileSidebar();
		}
	}

	function handleDirClick(fullPath: string) {
		if (!dirChildren.has(fullPath)) {
			wsSend({ type: "get_file_list", path: fullPath });
		}
	}

	function refresh() {
		dirCache.clear();
		dirChildren = new Map<string, FileEntry[]>();
		loadDirectory(currentPath);
	}

	function closePanel() {
		setSidebarPanel("sessions");
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
	<!-- Header -->
	<div class="session-list-header flex items-center justify-between px-4 py-1 shrink-0">
		<span class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer">File Browser</span>
		<div class="session-list-header-actions flex items-center gap-0.5">
			<button
				id="file-panel-refresh"
				type="button"
				title="Refresh file tree"
			class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={refresh}
			>
				<Icon name="refresh-cw" size={14} />
			</button>
			<button
				id="file-panel-close"
				type="button"
				title="Close file browser"
			class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={closePanel}
			>
				<Icon name="x" size={14} />
			</button>
		</div>
	</div>

	<!-- Breadcrumbs -->
	<div class="fb-breadcrumbs flex items-center gap-0.5 px-4 py-1.5 text-xs text-text-muted overflow-x-auto shrink-0">
		{#each breadcrumbs as crumb, i (crumb.path)}
			{#if i > 1}
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
				<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
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
