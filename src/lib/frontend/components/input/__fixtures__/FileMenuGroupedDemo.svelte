<script lang="ts">
	import type { ComponentProps } from "svelte";
	// biome-ignore lint/style/useImportType: rendered as a component in the markup
	import FileMenu from "../FileMenu.svelte";

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

<!-- The story's menuOpensUpwardFrame supplies headroom above this anchor. -->
<div class="flex w-full max-w-96 flex-col gap-2 p-4">
	<div class="relative flex flex-col">
		<textarea
			data-testid="composer"
			aria-label="Message"
			aria-controls={visible ? listboxId : undefined}
			aria-activedescendant={visible && entries.length > 0
				? `${listboxId}-option-${activeIndex}`
				: undefined}
			rows="1"
			class="rounded-md border border-border bg-bg-alt px-2 py-1 text-text"
			onkeydown={(event) => fileMenuRef?.handleKeydown(event)}
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
