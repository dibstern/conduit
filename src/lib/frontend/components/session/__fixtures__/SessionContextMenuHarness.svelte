<script lang="ts">
	import type { SessionInfo } from "../../../types.js";
	import SessionContextMenu from "../SessionContextMenu.svelte";
	import Button from "../../ui/Button.svelte";

	let { session, projectLabel, branch, presentation = "menu" }: { session: SessionInfo; projectLabel?: string; branch?: string; presentation?: "menu" | "sheet" } = $props();

	/**
	 * A real element, not a `getBoundingClientRect` stub. Since
	 * conduit-test-de3.35.4 the menu is positioned by floating-ui through
	 * bits-ui's `customAnchor`, which needs a live node to measure and to
	 * collide against — a stub returning only `bottom`/`right` silently
	 * produced a menu pinned to the top-left corner.
	 */
	let anchor: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
</script>

<div class="flex h-40 items-start justify-end p-4">
	<Button
		bind:element={anchor}
		variant="ghost"
		size="sm"
		ariaLabel="Session actions"
	>
		…
	</Button>
</div>

{#if anchor}
	<SessionContextMenu
		{session}
		{anchor}
		{projectLabel}
		{branch}
		{presentation}
		host={{ rename: () => {} }}
		onclose={() => {}}
	/>
{/if}
