<!-- ─── File Tree Panel ─────────────────────────────────────────────────────── -->
<!-- File browser shared by the desktop pane and phone session view. -->
<!-- Owns WS subscriptions for file_list/file_content. -->

<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import type { BreadcrumbSegment, FileEntry, RelayMessage } from "../../types.js";
	import { onFileBrowser } from "../../stores/ws.svelte.js";
	import { openFileViewer, uiState } from "../../stores/ui.svelte.js";
	import { setFilesOpen } from "../../stores/session-view.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getFileListRpc } from "../../transport/ws-rpc-client.js";
	import { applyGetFileListResponse } from "../../stores/ws-dispatch.js";
	import FileTreeNode from "./FileTreeNode.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import Button from "../ui/Button.svelte";
	import { fileTreeState } from "../../stores/file-tree.svelte.js";

	let { onClose, pane = false, paneTitle, paneActions }: { onClose?: () => void; pane?: boolean; paneTitle?: Snippet | undefined; paneActions?: Snippet | undefined } = $props();

	// ─── State ─────────────────────────────────────────────────────────────────

	let loading = $state(false);
	let fileTreeEl: HTMLDivElement | undefined = $state(undefined);
	// Restore the saved scroll once per mount; tracking browserScrollTop here
	// would re-run on every scroll event.
	$effect(() => {
		if (fileTreeEl) fileTreeEl.scrollTop = untrack(() => fileTreeState.browserScrollTop);
	});

	// ─── Breadcrumbs ────────────────────────────────────────────────────────────

	const breadcrumbs = $derived.by((): BreadcrumbSegment[] => {
		if (fileTreeState.browserPath === ".") return [{ label: "/", path: "." }];
		const parts = fileTreeState.browserPath.split("/").filter(Boolean);
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
		if (fileTreeState.browserCache.has(path)) {
			// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after has() check
			fileTreeState.browserEntries = fileTreeState.browserCache.get(path)!;
			fileTreeState.browserPath = path;
			return;
		}
		const slug = getCurrentSlug();
		if (!slug) return;
		loading = true;
		fileTreeState.browserPath = path;
		void getFileListRpc({ projectSlug: slug, path })
			.then(applyGetFileListResponse)
			.catch(() => {
				if (fileTreeState.browserPath === path) loading = false;
			});
	}

	function sortEntries(fileEntries: FileEntry[]): FileEntry[] {
		return [...fileEntries].sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	function handleFileList(path: string, fileEntries: FileEntry[]) {
		const sorted = sortEntries(fileEntries);
		fileTreeState.browserCache = new Map([...fileTreeState.browserCache, [path, sorted]]);

		if (fileTreeState.browserPath === path) {
			fileTreeState.browserEntries = sorted;
			loading = false;
		}

		fileTreeState.browserChildren = new Map([...fileTreeState.browserChildren, [path, sorted]]);
	}

	function getChildrenForPath(path: string): FileEntry[] | undefined {
		return fileTreeState.browserChildren.get(path);
	}

	function navigateTo(path: string) {
		loadDirectory(path);
	}

	// The tree is inert while a preview covers it, so closing the preview hands
	// focus back to the row that opened it. Found by path rather than by
	// activeElement because Safari does not focus buttons on click.
	let previewedPath: string | undefined;
	$effect(() => {
		if (uiState.fileViewerOpen || !previewedPath || !fileTreeEl) return;
		fileTreeEl
			.querySelector<HTMLElement>(`[data-path="${CSS.escape(previewedPath)}"]`)
			?.focus({ preventScroll: true });
		previewedPath = undefined;
	});

	function handleFileClick(fullPath: string) {
		previewedPath = fullPath;
		openFileViewer(fullPath);
	}

	function handleDirClick(fullPath: string) {
		const slug = getCurrentSlug();
		if (slug && !fileTreeState.browserChildren.has(fullPath)) {
			void getFileListRpc({ projectSlug: slug, path: fullPath }).then(
				applyGetFileListResponse,
			);
		}
	}

	function refresh() {
		fileTreeState.browserCache = new Map();
		fileTreeState.browserChildren = new Map();
		fileTreeState.browserExpandedPaths = new Set();
		loadDirectory(fileTreeState.browserPath);
	}

	function closePanel() {
		if (onClose) onClose();
		else setFilesOpen(false);
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
		if (!fileTreeState.browserCache.has(fileTreeState.browserPath)) {
			loadDirectory(fileTreeState.browserPath);
		}
	});
</script>

<div
	id="sidebar-panel-files"
	class="sidebar-panel flex flex-col flex-1 overflow-hidden"
>
	{#snippet refreshButton()}
		<Button
			id="file-panel-refresh"
			variant="toolbar"
			size="content"
			class="h-6 w-6 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-md"
			iconOnly
			iconSize={14}
			icon="refresh-cw"
			title="Refresh file tree"
			ariaLabel="Refresh file tree"
			onclick={refresh}
		/>
	{/snippet}
	{#if pane && paneTitle && paneActions}
		<div class="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
			{@render paneTitle()}
			<span class="flex-1"></span>
			{@render refreshButton()}
			{@render paneActions()}
		</div>
	{:else if !pane}
	<div class="session-list-header flex items-center justify-between px-4 py-1 shrink-0">
		<span class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer">File Browser</span>
		<div class="session-list-header-actions flex items-center gap-0.5">
			{@render refreshButton()}
			<Button
				id="file-panel-close"
				variant="toolbar"
				size="content"
				class="h-6 w-6 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-md"
				iconOnly
				iconSize={14}
				icon="x"
				title="Close file browser"
				ariaLabel="Close file browser"
				onclick={closePanel}
			/>
		</div>
	</div>{/if}

	<!-- Breadcrumbs -->
	<div class="fb-breadcrumbs flex items-center gap-0.5 px-4 py-1.5 text-xs text-text-muted overflow-x-auto shrink-0">
		{#each breadcrumbs as crumb, i (crumb.path)}
			{#if i > 1}
				<span class="text-text-dimmer">/</span>
			{/if}
			{#if i === breadcrumbs.length - 1}
				<span class="fb-crumb-active text-text font-medium">{crumb.label}</span>
			{:else}
				<TextButton
					underline="hover" class="fb-crumb text-xs"
					onclick={() => navigateTo(crumb.path)}
				>
					{crumb.label}
				</TextButton>
			{/if}
		{/each}
	</div>

	<!-- File tree -->
	<div id="file-tree" class="flex-1 overflow-y-auto px-1" bind:this={fileTreeEl} onscroll={(event) => { fileTreeState.browserScrollTop = event.currentTarget.scrollTop; }}>
		{#if loading}
			<div class="flex items-center justify-center py-8 text-text-dimmer text-sm">
				<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
				<span class="ml-2">Loading...</span>
			</div>
		{:else if fileTreeState.browserEntries.length === 0}
			<div class="text-center py-8 text-text-dimmer text-sm">
				Empty directory
			</div>
		{:else}
			{#each fileTreeState.browserEntries as entry (entry.name)}
				<FileTreeNode
					{entry}
					parentPath={fileTreeState.browserPath}
					onFileClick={handleFileClick}
					onDirClick={handleDirClick}
					getChildren={getChildrenForPath}
				/>
			{/each}
		{/if}
	</div>
</div>
