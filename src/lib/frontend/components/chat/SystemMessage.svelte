<!-- ─── System Message ──────────────────────────────────────────────────────── -->
<!-- Displays system info/error messages with left-border accent. -->

<script lang="ts">
	import type { SystemMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { message }: { message: SystemMessage } = $props();

	const isError = $derived(message.variant === "error");

	const containerClasses = $derived(
		isError
			? "glow-tool-error text-error bg-bg-surface"
			: "bg-bg-surface text-text-muted",
	);
</script>

<div class="max-w-[760px] mx-auto my-2 px-5">
	<div
		class="flex items-start gap-2 py-2 px-3 text-base rounded-[10px] {containerClasses}"
	>
		<span class="shrink-0 mt-0.5 [&_.lucide]:w-3 [&_.lucide]:h-3">
			{#if isError}
				<Icon name="circle-alert" size={12} />
			{:else}
				<Icon name="info" size={12} />
			{/if}
		</span>
		<span>{message.text}</span>
	</div>
</div>
