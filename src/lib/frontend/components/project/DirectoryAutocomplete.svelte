<!-- ─── DirectoryAutocomplete ──────────────────────────────────────────────── -->
<!-- Drop-up autocomplete for filesystem directory paths. Uses RPC on         -->
<!-- debounced input changes. Arrow keys + Enter to select,                  -->
<!-- Tab to drill into a directory level (terminal-style tab-completion).       -->

<script lang="ts">
	import { onDestroy } from "svelte";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { listDirectoriesRpc } from "../../transport/ws-rpc-client.js";
	import DetachedListbox from "../ui/DetachedListbox.svelte";
	import Icon from "../ui/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	type DirectoryLoadResult = {
		readonly path: string;
		readonly entries: readonly string[];
	};

	/** Returns `null` synchronously when no listing can be requested at all. */
	type DirectoryLoader = (path: string) => Promise<DirectoryLoadResult> | null;

	let {
		value = $bindable(""),
		placeholder = "/path/to/project",
		onsubmit,
		loadDirectories,
	}: {
		value?: string;
		placeholder?: string;
		onsubmit?: () => void;
		loadDirectories?: DirectoryLoader | undefined;
	} = $props();

	const defaultLoader: DirectoryLoader = (path) => {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return null;
		return listDirectoriesRpc({ projectSlug, path });
	};

	// ─── Identity ───────────────────────────────────────────────────────────────

	// This component owns both halves of the combobox relationship, so it derives
	// the ids locally instead of taking a `listboxId` prop.
	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (index: number) => `${listboxId}-option-${index}`;

	// ─── State ──────────────────────────────────────────────────────────────────

	let entries: string[] = $state([]);
	let activeIndex = $state(0);
	let visible = $state(false);
	let loading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inputEl: HTMLInputElement | undefined = $state(undefined);
	let lastRequestPath = "";

	const expanded = $derived(visible && entries.length > 0);
	const activeOptionId = $derived(expanded ? optionId(activeIndex) : undefined);

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	onDestroy(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
	});

	// Reset active index when entries change
	$effect(() => {
		void entries.length;
		activeIndex = 0;
	});

	// ─── Input handling ─────────────────────────────────────────────────────────

	async function requestDirectories(path: string) {
		if (!path || path.length < 1) {
			entries = [];
			visible = false;
			loading = false;
			return;
		}
		// Resolve the loader before touching `loading`/`lastRequestPath` so the
		// no-request path stays exactly as inert as the old slug guard was.
		const pending = (loadDirectories ?? defaultLoader)(path);
		if (!pending) {
			entries = [];
			visible = false;
			loading = false;
			return;
		}
		loading = true;
		lastRequestPath = path;
		try {
			const response = await pending;
			if (response.path !== lastRequestPath) return;
			entries = [...response.entries];
			loading = false;
			visible = entries.length > 0;
		} catch {
			if (path !== lastRequestPath) return;
			entries = [];
			loading = false;
			visible = false;
		}
	}

	function handleInput() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void requestDirectories(value);
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
		void requestDirectories(entry);
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
			void requestDirectories(value);
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
	{#if expanded}
		<DetachedListbox
			id={listboxId}
			ariaLabel="Directory suggestions"
			class="dir-autocomplete-list absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto z-[var(--z-dropdown)]!"
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
					id={optionId(i)}
					role="option"
					tabindex="-1"
					aria-selected={i === activeIndex}
					onmousedown={(e) => {
						e.preventDefault();
						// Click behaves like Tab, not like Enter: fill the directory in
						// (trailing slash included) and list its children, so the user can
						// keep drilling. Enter remains the "this is the path I want" commit.
						drillInto(entry);
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
		</DetachedListbox>
	{/if}

	<!-- Input -->
	<input
		bind:this={inputEl}
		type="text"
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		role="combobox"
		aria-label="Project directory"
		aria-autocomplete="list"
		aria-haspopup="listbox"
		aria-expanded={expanded}
		aria-controls={expanded ? listboxId : undefined}
		aria-activedescendant={activeOptionId}
		class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-[12px] text-text font-mono outline-none focus:border-accent placeholder:text-text-dimmer"
		bind:value
		oninput={handleInput}
		onkeydown={handleKeydown}
		onblur={handleBlur}
		onfocus={handleFocus}
	/>
</div>
