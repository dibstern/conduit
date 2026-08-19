<!--
  FileMenu owns no keydown listener of its own — InputArea forwards the composer's
  keydown into the exported `handleKeydown`. This fixture reproduces exactly that
  wiring around a plain textarea, so a story can drive real ArrowDown/ArrowUp
  traffic through the component and observe where `activeIndex` lands.

  Deliberately NOT a combobox: the textarea/role="combobox" pairing is InputArea's
  own contract (and the open `aria-allowed-role` question in conduit-test-n9s).
  Keeping it off here leaves the strict axe gate maximally live on the thing this
  story exists to check — the divider's effect on the listbox's owned children.
-->
<script lang="ts">
	import type { ComponentProps } from "svelte";
	import FileMenu from "../FileMenu.svelte";

	// The fixture owns `activeIndex`, `onSelect` and `onClose`; it accepts the
	// component's full prop shape only so a story can render it in FileMenu's place.
	let {
		listboxId,
		query,
		visible,
		entries,
		dividerAt = 0,
	}: ComponentProps<typeof FileMenu> = $props();

	let fileMenuRef: FileMenu | undefined = $state();
	let activeIndex = $state(0);
	let selected = $state("");
</script>

<!--
	Two nested divs, and the split is load-bearing for the visual baseline.

	The menu is a drop-up: `absolute bottom-full`, so its bottom edge lands on the TOP
	edge of its nearest positioned ancestor. That ancestor must hug the textarea — as it
	does in InputArea — or the menu floats above the whole demo. So `relative` goes on the
	inner wrapper only, and the headroom padding on the outer, unpositioned one.

	`pt-80` is 20rem = 240px (conduit's root font-size is 12px, not 16), plus `p-4`, versus
	a ~205px six-row list with divider. Reserved so nothing renders above y=0 and gets
	cropped out of the capture.
-->
<div class="flex w-96 flex-col gap-2 p-4 pt-80">
	<div class="relative flex flex-col">
		<textarea
			data-testid="composer"
			aria-label="Message"
			rows="1"
			class="rounded-md border border-border bg-bg-alt px-2 py-1 text-text"
			onkeydown={(event) => {
				fileMenuRef?.handleKeydown(event);
			}}
		></textarea>
		<FileMenu
			bind:this={fileMenuRef}
			bind:activeIndex
			{listboxId}
			{query}
			{visible}
			{entries}
			{dividerAt}
			onSelect={(path) => {
				selected = path;
			}}
			onClose={() => {}}
		/>
	</div>
	<dl class="text-text text-base">
		<dt>Active index</dt>
		<dd data-testid="active-index">{activeIndex}</dd>
		<dt>Selected</dt>
		<dd data-testid="selected-path">{selected}</dd>
	</dl>
</div>
