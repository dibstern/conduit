<!-- ─── File Tree Node ────────────────────────────────────────────────────────── -->
<!-- Recursive tree node for file browser. Directories expand on click and -->
<!-- fetch children lazily via getChildren callback. -->

<script lang="ts">
	import type { FileEntry } from "../../types.js";
	import { formatFileSize } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
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
		depth?: number | undefined;
		parentPath?: string | undefined;
		onFileClick?: ((path: string) => void) | undefined;
		onDirClick?: ((path: string) => void) | undefined;
		getChildren?:
			| ((path: string) => FileEntry[] | undefined)
			| undefined;
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

<!--
	`flex flex-col` is load-bearing, not tidying. ui/Button's BASE is
	`inline-flex`, and an inline-level box in a block parent sits on a line box,
	so every tree row would gain a descender gap below it. Making the wrapper a
	flex container blockifies the child per spec, and a column of full-width
	items lays out identically to the block stacking it replaces.
-->
<div class="fb-entry-wrapper flex flex-col">
	<!--
		`tone="inherit"` rather than `secondary`: the row is `text-text-secondary`
		with NO hover colour change as-found, and every real tone member pairs its
		colour with one. `inherit` emits nothing, so the class below owns the
		group uncontested. Dropped: `flex items-center cursor-pointer
		transition-colors` (all in BASE) and `bg-transparent border-none`, both of
		which Tailwind v4's preflight already does on a button. `duration-100`
		stays — it beats BASE's default 150ms.

		`aria-expanded` is conditional: a file row is not expandable, and
		`aria-expanded="false"` on one announces a collapsed disclosure that can
		never open.
	-->
	<Button
		variant="ghost"
		size="content"
		align="start"
		tone="inherit"
		hoverFill="overlay-soft"
		class="fb-entry gap-1.5 w-full py-1 px-2 text-left text-base text-text-secondary rounded duration-100 {hiddenClass}"
		style="padding-left: {depth * 16 + 8}px"
		aria-expanded={isDir ? expanded : undefined}
		onclick={handleClick}
	>
		{#if isDir}
			<!-- Chevron indicator — rotates when expanded. Decorative: the rotation
			     is what a sighted user reads, `aria-expanded` above is what a screen
			     reader reads. -->
			<svg
				aria-hidden="true"
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
	</Button>

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
