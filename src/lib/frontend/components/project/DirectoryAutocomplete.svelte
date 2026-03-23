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
	let lastRequestPath = "";

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	let unsubDir: (() => void) | undefined;

	onMount(() => {
		unsubDir = onDirectoryList((msg) => {
			if (msg.type !== "directory_list") return;
			const dirMsg = msg as {
				type: "directory_list";
				path: string;
				entries: string[];
			};
			// Only accept responses that match our last request to avoid stale data
			if (dirMsg.path !== lastRequestPath) return;
			entries = dirMsg.entries;
			loading = false;
			visible = entries.length > 0;
		});
	});

	onDestroy(() => {
		unsubDir?.();
		if (debounceTimer) clearTimeout(debounceTimer);
	});

	// Reset active index when entries change
	$effect(() => {
		void entries.length;
		activeIndex = 0;
	});

	// ─── Input handling ─────────────────────────────────────────────────────────

	function requestDirectories(path: string) {
		if (!path || path.length < 1) {
			entries = [];
			visible = false;
			return;
		}
		loading = true;
		lastRequestPath = path;
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
			// When popup is not showing, only handle Enter for form submission
			// Do NOT handle Escape here — let it bubble up to the parent
			if (e.key === "Enter") {
				e.preventDefault();
				onsubmit?.();
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
				e.stopPropagation();
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
</script>

<div class="relative">
	<!-- Drop-up popup -->
	{#if visible && entries.length > 0}
		<div
			class="dir-autocomplete-list absolute bottom-full left-0 right-0 mb-1 bg-bg-surface border border-border rounded-lg shadow-[0_-4px_16px_rgba(0,0,0,0.3)] max-h-[200px] overflow-y-auto z-[130] py-1"
		>
			{#each entries as entry, i}
				{@const lastSlash = entry.lastIndexOf(
					"/",
					entry.length - 2,
				)}
				{@const displayName = entry.slice(lastSlash + 1)}
				{@const parentPath = entry.slice(0, lastSlash + 1)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="dir-item flex items-center gap-2 py-1.5 px-3 cursor-pointer transition-colors duration-100 text-[12px] font-mono
						{i === activeIndex
						? 'dir-item-active bg-accent-bg'
						: 'hover:bg-bg-alt'}"
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					onmousedown={(e) => {
						e.preventDefault();
						selectEntry(entry);
					}}
					onmouseenter={() => {
						activeIndex = i;
					}}
				>
					<Icon
						name="folder"
						size={13}
						class="shrink-0 text-warning"
					/>
					<span
						class="flex-1 min-w-0 flex items-baseline"
					>
						<span class="text-text-muted overflow-hidden text-ellipsis whitespace-nowrap min-w-0" style="flex-shrink:100;direction:rtl;text-align:left;">{parentPath}</span
						><span class="text-text overflow-hidden text-ellipsis whitespace-nowrap min-w-0 shrink">{displayName}</span>
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
