<!--
  DirectoryAutocomplete driven by a deterministic in-memory directory tree
  instead of the router + WebSocket RPC pair, so a story can drill through two
  levels with no backend. The observation panes make the three things the swap
  must not change externally visible: which paths the loader was asked for, how
  many submits fired, and how many Escapes reached the parent.
-->
<script lang="ts">
	import type { ComponentProps } from "svelte";
	import DirectoryAutocomplete from "../DirectoryAutocomplete.svelte";

	// The fixture owns `value`, `onsubmit` and `loadDirectories` — it accepts the
	// component's prop shape only so a story can render it in place of the
	// component itself.
	let {
		placeholder = "/path/to/project",
	}: ComponentProps<typeof import("../DirectoryAutocomplete.svelte").default> =
		$props();

	// Level one is deliberately taller than the surface's preserved max-h-[200px]
	// so the story can prove the list still scrolls inside its own box.
	const tree: Record<string, readonly string[]> = {
		"/src": [
			"/src/lib/",
			"/src/routes/",
			...Array.from({ length: 10 }, (_, index) => `/src/generated-${index}/`),
		],
		"/src/routes/": ["/src/routes/api/", "/src/routes/app/"],
	};

	let value = $state("");
	let requested = $state<string[]>([]);
	let submits = $state(0);
	let parentEscapes = $state(0);

	function loadDirectories(path: string) {
		requested = [...requested, path];
		return Promise.resolve({ path, entries: tree[path] ?? [] });
	}
</script>

<!--
	`pt-40` is not decoration: DirectoryAutocomplete's surface is a drop-up
	(`bottom-full`), so with the input near the top of the canvas an expanded list
	renders above y=0 and the visual baseline captures it cropped to its last row.
	Reserving headroom is what makes the open-surface story capturable at all.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="flex w-80 flex-col gap-2 p-4 pt-40"
	onkeydown={(event) => {
		if (event.key === "Escape") parentEscapes += 1;
	}}
>
	<DirectoryAutocomplete
		bind:value
		{placeholder}
		{loadDirectories}
		onsubmit={() => {
			submits += 1;
		}}
	/>
	<button
		type="button"
		data-testid="outside-target"
		class="rounded-md border border-border px-2 py-1 text-[12px] text-text"
	>
		Outside
	</button>
	<dl class="text-[12px] text-text">
		<dt>Loader calls</dt>
		<dd data-testid="loader-calls">{requested.join(" ")}</dd>
		<dt>Submits</dt>
		<dd data-testid="submit-count">{submits}</dd>
		<dt>Parent escapes</dt>
		<dd data-testid="parent-escape-count">{parentEscapes}</dd>
	</dl>
</div>
