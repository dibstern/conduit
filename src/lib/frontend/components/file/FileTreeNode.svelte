<!-- ─── File Tree Node ────────────────────────────────────────────────────────── -->
<!-- Recursive tree node for file browser. Directories expand on click and -->
<!-- fetch children lazily via getChildren callback. -->

<script lang="ts">
	import type { FileEntry } from "../../types.js";
	import { formatFileSize } from "../../utils/format.js";
	import FileTreeNode from "./FileTreeNode.svelte";

	let {
		entry,
		depth = 0,
		parentPath = ".",
		onFileClick,
		onDirClick,
		getChildren,
	}: {
		entry: FileEntry;
		depth?: number;
		parentPath?: string;
		onFileClick?: (path: string) => void;
		onDirClick?: (path: string) => void;
		getChildren?: (path: string) => FileEntry[] | undefined;
	} = $props();

	let expanded = $state(false);

	const isDir = $derived(entry.type === "directory");
	const isHidden = $derived(entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".vscode");

	// Full path of this entry (used for WS requests and child lookups)
	const fullPath = $derived(parentPath === "." ? entry.name : `${parentPath}/${entry.name}`);

	// Directories that should be collapsed by default
	const COLLAPSE_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__", ".next", ".svelte-kit", "coverage"];
	const shouldCollapse = $derived(isDir && COLLAPSE_DIRS.includes(entry.name));

	const hiddenClass = $derived(isHidden ? "opacity-55" : "");

	function handleClick() {
		if (isDir) {
			if (shouldCollapse && !expanded) {
				// First click on collapsed-by-default dir expands
				expanded = true;
				onDirClick?.(fullPath);
			} else {
				expanded = !expanded;
				if (expanded) onDirClick?.(fullPath);
			}
		} else {
			onFileClick?.(fullPath);
		}
	}
</script>

<div class="fb-entry-wrapper">
	<button
		class="fb-entry flex items-center gap-1.5 w-full py-1 px-2 cursor-pointer bg-transparent border-none text-left text-base text-text-secondary hover:bg-[rgba(var(--overlay-rgb),0.03)] rounded transition-colors duration-100 {hiddenClass}"
		style="padding-left: {depth * 16 + 8}px"
		onclick={handleClick}
	>
		{#if isDir}
			<!-- Chevron indicator — rotates when expanded -->
			<svg
				class="fb-chevron shrink-0 transition-transform duration-100"
				class:rotate-90={expanded}
				width="12" height="12" viewBox="0 0 20 20" fill="none"
			>
				<path d="M8 5L13 10L8 15" stroke="currentColor" stroke-linecap="square"/>
			</svg>
			<!-- Folder icon (from OpenCode icon set) -->
			<svg class="shrink-0 text-text-dimmer" width="14" height="14" viewBox="0 0 20 20" fill="none">
				<path d="M2.08 2.92V16.25H17.92V5.42H10L8.33 2.92H2.08Z" stroke="currentColor" stroke-linecap="round"/>
			</svg>
		{:else}
			<!-- Spacer matching chevron width to align files with folder names -->
			<span class="inline-block shrink-0" style="width: 12px"></span>
			<!-- Document icon -->
			<svg class="shrink-0 text-text-dimmer" width="14" height="14" viewBox="0 0 20 20" fill="none">
				<path d="M5 2.5H12.5L15 5V17.5H5V2.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M12.5 2.5V5H15" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		{/if}
		<span class="fb-entry-name flex-1 truncate">{entry.name}</span>
		{#if !isDir && entry.size !== undefined}
			<span class="fb-entry-size text-sm text-text-dimmer shrink-0">
				{formatFileSize(entry.size)}
			</span>
		{/if}
		{#if shouldCollapse && !expanded}
			<span class="fb-collapsed-hint text-xs text-text-dimmer italic">(click to expand)</span>
		{/if}
	</button>

	{#if isDir && expanded}
		{@const children = getChildren?.(fullPath)}
		{#if children}
			{#each children as child (child.name)}
				<FileTreeNode
					entry={child}
					depth={depth + 1}
					parentPath={fullPath}
					{onFileClick}
					{onDirClick}
					{getChildren}
				/>
			{/each}
		{:else}
			<div class="py-1.5 text-sm text-text-dimmer" style="padding-left: {(depth + 1) * 16 + 8}px">
				Loading…
			</div>
		{/if}
	{/if}
</div>
