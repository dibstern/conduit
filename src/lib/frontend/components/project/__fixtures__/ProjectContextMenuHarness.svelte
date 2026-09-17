<script lang="ts">
	import type { ProjectInfo } from "../../../types.js";
	import ProjectContextMenu from "../ProjectContextMenu.svelte";

	let {
		project,
		withRename = true,
	}: { project: ProjectInfo; withRename?: boolean } = $props();

	/**
	 * A real element, not a `getBoundingClientRect` stub. The menu is positioned
	 * by floating-ui through bits-ui's `customAnchor`, which needs a live node to
	 * measure and to collide against; the stub this story used to pass returned
	 * only `bottom`/`right` and would now pin the menu to the top-left corner.
	 */
	let anchor: HTMLElement | null = $state(null);
</script>

<div class="flex h-40 items-start justify-end p-4">
	<button
		bind:this={anchor}
		type="button"
		aria-label="Project actions"
		class="rounded-md px-2 py-1 text-text-muted"
	>
		…
	</button>
</div>

{#if anchor}
	<ProjectContextMenu
		{project}
		{anchor}
		onrename={withRename ? () => {} : undefined}
		ondelete={() => {}}
		onclose={() => {}}
	/>
{/if}
