<!-- File browser shared by the desktop pane and phone session view. -->
<!-- Owns the GetFileList/GetFileContent reply subscriptions. -->

<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import type { BreadcrumbSegment, FileEntry } from "../../types.js";
	import { onFileBrowser, applyGetFileListResponse } from "../../stores/ws-listeners.js";
	import { openFileViewer, uiState } from "../../stores/ui.svelte.js";
	import { setFilesOpen } from "../../stores/session-view.svelte.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getFileListRpc } from "../../transport/ws-rpc-client.js";
	import FileTreeNode from "./FileTreeNode.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import Button from "../ui/Button.svelte";
	import { fileBrowserKey, fileTreeState } from "../../stores/file-tree.svelte.js";

	let { onClose, pane = false, paneTitle, paneActions }: { onClose?: () => void; pane?: boolean; paneTitle?: Snippet | undefined; paneActions?: Snippet | undefined } = $props();

	let loading = $state(false);
	const showRoots = $derived(fileTreeState.roots.length > 1 || fileTreeState.roots.some((folder) => folder.shared));
	let fileTreeEl: HTMLDivElement | undefined = $state(undefined);
	// Restore the saved scroll once per mount; tracking browserScrollTop here
	// would re-run on every scroll event.
	$effect(() => {
		if (fileTreeEl) fileTreeEl.scrollTop = untrack(() => fileTreeState.browserScrollTop);
	});

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

	function loadDirectory(path: string) {
		const scope = fileTreeState.scope;
		const cachedEntries = fileTreeState.browserCache.get(path);
		if (cachedEntries !== undefined) {
			fileTreeState.browserEntries = cachedEntries;
			fileTreeState.browserPath = path;
			return;
		}
		const slug = getCurrentSlug();
		const sessionId = getCurrentSessionId();
		if (!slug) return;
		loading = true;
		fileTreeState.browserPath = path;
		void getFileListRpc({ ...(sessionId ? { sessionId } : { projectSlug: slug }), path })
			.then((response) => {
				if (fileTreeState.scope === scope) applyGetFileListResponse(response);
			})
			.catch(() => {
				if (fileTreeState.scope === scope && fileTreeState.browserPath === path) loading = false;
			});
	}

	function sortEntries(fileEntries: readonly FileEntry[]): FileEntry[] {
		return [...fileEntries].sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	function handleFileList(path: string, fileEntries: readonly FileEntry[], root?: string) {
		const key = fileBrowserKey(path, root);
		const sorted = sortEntries(fileEntries);
		fileTreeState.browserCache = new Map([...fileTreeState.browserCache, [key, sorted]]);

		if (root === undefined && fileTreeState.browserPath === path) {
			fileTreeState.browserEntries = sorted;
			loading = false;
		}

		fileTreeState.browserChildren = new Map([...fileTreeState.browserChildren, [key, sorted]]);
	}

	function getChildrenForPath(path: string, root?: string): FileEntry[] | undefined {
		return fileTreeState.browserChildren.get(fileBrowserKey(path, root));
	}

	function navigateTo(path: string) {
		loadDirectory(path);
	}

	// The tree is inert while a preview covers it, so closing the preview hands
	// focus back to the row that opened it. Found by path rather than by
	// activeElement because Safari does not focus buttons on click.
	let previewedPath: string | undefined;
	let previewedRoot: string | undefined;
	$effect(() => {
		if (uiState.fileViewerOpen || !previewedPath || !fileTreeEl) return;
		const folder = previewedRoot === undefined ? ":not([data-root])" : `[data-root="${CSS.escape(previewedRoot)}"]`;
		fileTreeEl
			.querySelector<HTMLElement>(`[data-path="${CSS.escape(previewedPath)}"]${folder}`)
			?.focus({ preventScroll: true });
		previewedPath = undefined;
		previewedRoot = undefined;
	});

	function handleFileClick(fullPath: string, root?: string) {
		previewedPath = fullPath;
		previewedRoot = root;
		openFileViewer(fullPath, root);
	}

	function handleDirClick(fullPath: string, root?: string) {
		const slug = getCurrentSlug();
		const sessionId = getCurrentSessionId();
		const scope = fileTreeState.scope;
		if (slug && !fileTreeState.browserChildren.has(fileBrowserKey(fullPath, root))) {
			void getFileListRpc({ ...(sessionId ? { sessionId } : { projectSlug: slug }), path: fullPath, ...(root !== undefined ? { root } : {}) }).then(
				(response) => { if (fileTreeState.scope === scope) applyGetFileListResponse(response); },
			).catch(() => undefined);
		}
	}

	function refresh() {
		fileTreeState.browserCache = new Map();
		fileTreeState.browserChildren = new Map();
		fileTreeState.browserExpandedPaths = new Set();
		if (!showRoots) loadDirectory(fileTreeState.browserPath);
	}

	function closePanel() {
		if (onClose) onClose();
		else setFilesOpen(false);
	}

	$effect(() => {
		const unsub = onFileBrowser((reply) => {
			if (reply.kind === "list") {
				handleFileList(reply.response.path, reply.response.entries, reply.response.root);
			}
		});
		return unsub;
	});

	// Load root directory on mount
	$effect(() => {
		if (!showRoots && !fileTreeState.browserCache.has(fileTreeState.browserPath)) {
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
	{#if !showRoots}
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
	{/if}

	<!-- File tree -->
	<div id="file-tree" class="flex-1 overflow-y-auto px-1" bind:this={fileTreeEl} onscroll={(event) => { fileTreeState.browserScrollTop = event.currentTarget.scrollTop; }}>
		{#if showRoots}
			{#each fileTreeState.roots as folder (folder.root)}
				<FileTreeNode
					entry={{ name: folder.label, type: "directory" }}
					path="."
					root={folder.root}
					shared={folder.shared}
					onFileClick={handleFileClick}
					onDirClick={handleDirClick}
					getChildren={getChildrenForPath}
				/>
			{/each}
		{:else if loading}
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
