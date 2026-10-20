<script lang="ts">
	import UsageFooterMeter from "../UsageFooterMeter.svelte";

	let { phone = false, width = 260 }: { phone?: boolean; width?: number } = $props();
</script>

<div class="@container/sidebar flex max-w-full flex-col bg-sidebar-bg text-text {phone ? 'min-h-dvh' : ''}" style:width="{width}px">
	{#if phone}<div class="flex-1 bg-bg"></div>{/if}
	<UsageFooterMeter {phone} />
</div>
