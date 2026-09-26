<script lang="ts">
	import type { SessionInfo } from "../../../types.js";
	import SessionContextMenu from "../SessionContextMenu.svelte";

	let { session, projectLabel, branch }: { session: SessionInfo; projectLabel?: string; branch?: string } = $props();

	/**
	 * A real element, not a `getBoundingClientRect` stub. Since
	 * conduit-test-de3.35.4 the menu is positioned by floating-ui through
	 * bits-ui's `customAnchor`, which needs a live node to measure and to
	 * collide against — a stub returning only `bottom`/`right` silently
	 * produced a menu pinned to the top-left corner.
	 */
	let anchor: HTMLElement | null = $state(null);
</script>

<div class="flex h-40 items-start justify-end p-4">
	<button
		bind:this={anchor}
		type="button"
		aria-label="Session actions"
		class="rounded-md px-2 py-1 text-text-muted"
	>
		…
	</button>
</div>

{#if anchor}
	<SessionContextMenu
		{session}
		{anchor}
		{projectLabel}
		{branch}
		onrename={() => {}}
		onsettle={() => {}}
		onpin={() => {}}
		onsnooze={() => {}}
		onunsnooze={() => {}}
		ondelete={() => {}}
		oncopyresume={() => {}}
		onfork={() => {}}
		onclose={() => {}}
	/>
{/if}
