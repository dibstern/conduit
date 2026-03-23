<!-- ─── File Menu ──────────────────────────────────────────────────────────── -->
<!-- @-mention file autocomplete popup. Filters project files by fuzzy match, -->
<!-- supports keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse selection. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

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
					class="flex items-center gap-2 py-3 px-3.5 text-text-muted text-base"
				>
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
					<span>Loading files…</span>
				</div>
			{:else if entries.length === 0}
				<div class="py-3 px-3.5 text-text-muted text-base">
					No files found
				</div>
			{:else}
				{#each entries as entry, i}
					{@const lastSlash = entry.lastIndexOf("/", entry.endsWith("/") ? entry.length - 2 : entry.length - 1)}
					<div
						class="file-item flex items-center gap-2 py-2 px-3.5 cursor-pointer transition-colors duration-100 max-sm:py-1.5 max-sm:px-2.5 max-sm:gap-1.5 {i === activeIndex ? 'file-item-active bg-accent-bg hover:bg-accent-bg' : 'hover:bg-bg-alt'}"
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
							class="file-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-base max-sm:text-xs"
						>
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
