<!--
  TerminalFind — the find bar over a terminal, opened by ⌘ then F.

  Searches the terminal it was opened on, loading the search addon there the
  first time. Enter goes to the next match, ⇧Enter the previous; esc closes
  and hands focus back to the terminal. Nothing typed here reaches the shell.
-->
<script module lang="ts">
	import { SearchAddon } from "@xterm/addon-search";
	import type { Terminal } from "@xterm/xterm";

	const addons = new WeakMap<Terminal, SearchAddon>();

	function addonFor(terminal: Terminal): SearchAddon {
		let addon = addons.get(terminal);
		if (!addon) {
			addon = new SearchAddon();
			terminal.loadAddon(addon);
			addons.set(terminal, addon);
		}
		return addon;
	}
</script>

<script lang="ts">
	import { themeState } from "../../stores/theme.svelte.js";
	import { FIND_DECORATIONS } from "../../utils/xterm-themes.js";
	import Button from "../ui/Button.svelte";
	import SearchInput from "../ui/SearchInput.svelte";

	let { terminal, onclose }: { terminal: Terminal; onclose: () => void } = $props();

	let query = $state("");
	let results = $state<{ index: number; count: number } | null>(null);
	let input = $state<HTMLInputElement>();
	const search = $derived(addonFor(terminal));

	$effect(() => input?.focus());

	$effect(() => {
		const changes = search.onDidChangeResults(({ resultIndex, resultCount }) => {
			results = { index: resultIndex, count: resultCount };
		});
		return () => {
			changes.dispose();
			search.clearDecorations();
		};
	});

	function find(direction: "next" | "previous", incremental = false) {
		if (!query) {
			search.clearDecorations();
			results = null;
			return;
		}
		const options = { incremental, decorations: FIND_DECORATIONS[themeState.resolved] };
		if (direction === "next") search.findNext(query, options);
		else search.findPrevious(query, options);
	}

	function close() {
		// Read before closing: the prop comes from state that closing clears.
		const target = terminal;
		onclose();
		target.focus();
	}
</script>

<div
	class="absolute z-20 top-[6px] right-[10px] flex w-[340px] items-center gap-1 rounded-[12px] border border-border bg-popover-bg p-1 shadow-dropdown"
	role="search"
>
	<SearchInput
		bind:element={input}
		value={query}
		placeholder="Find"
		aria-label="Find in terminal"
		oninput={(event) => {
			query = event.currentTarget.value;
			find("next", true);
		}}
		onkeydown={(event) => {
			if (event.key === "Enter") find(event.shiftKey ? "previous" : "next");
			else if (event.key !== "Escape") return;
			else close();
			event.preventDefault();
			event.stopPropagation();
		}}
	/>
	<span class="min-w-[64px] shrink-0 text-center text-xs tabular-nums text-text-dimmer" aria-live="polite">
		{#if results}{results.count ? `${results.index + 1} of ${results.count}` : "No results"}{/if}
	</span>
	<Button variant="ghost" size="sm" iconOnly icon="chevron-up" ariaLabel="Previous match" onclick={() => find("previous")} />
	<Button variant="ghost" size="sm" iconOnly icon="chevron-down" ariaLabel="Next match" onclick={() => find("next")} />
	<Button variant="ghost" size="sm" iconOnly icon="x" ariaLabel="Close find" onclick={close} />
</div>
