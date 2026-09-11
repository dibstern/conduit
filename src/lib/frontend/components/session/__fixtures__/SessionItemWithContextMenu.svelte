<script lang="ts">
	import type { SessionInfo } from "../../../types.js";
	import SessionContextMenu from "../SessionContextMenu.svelte";
	import SessionItem from "../SessionItem.svelte";

	let { session, active = false }: { session: SessionInfo; active?: boolean } = $props();
	let anchor: HTMLElement | null = $state(null);
</script>

<!-- conduit-test-732b: compose the menu owner just as SessionList does. -->
<SessionItem {session} {active} oncontextmenu={(_session, element) => { anchor = element; }} />
{#if anchor}
	<SessionContextMenu
		{session}
		{anchor}
		onrename={() => {}}
		ondelete={() => {}}
		oncopyresume={() => {}}
		onfork={() => {}}
		onclose={() => { anchor = null; }}
	/>
{/if}
