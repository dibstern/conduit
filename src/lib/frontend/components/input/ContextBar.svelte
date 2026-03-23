<!-- ─── Context Bar ─────────────────────────────────────────────────────────── -->
<!-- Mini context usage percentage bar displayed above the input area. -->

<script lang="ts">
	let { percent }: { percent: number } = $props();

	const contextFillColor = $derived.by(() => {
		if (percent >= 80) return "bg-brand-a";
		if (percent >= 50) return "bg-warning";
		return "bg-brand-b";
	});
</script>

<div
	id="context-mini"
	class="flex items-center gap-2 pb-1.5 px-2"
>
	<span
		class="context-mini-label font-mono text-xs font-semibold whitespace-nowrap min-w-6 {contextFillColor === 'bg-brand-a' ? 'text-brand-a' : contextFillColor === 'bg-warning' ? 'text-warning' : 'text-brand-b'}"
		id="context-mini-label"
	>
		{percent}%
	</span>
	<div
		class="context-mini-bar flex-1 h-1 rounded-[2px] bg-border overflow-hidden"
	>
		<div
			class="context-mini-fill h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out {contextFillColor}"
			id="context-mini-fill"
			style="width: {percent}%"
		></div>
	</div>
</div>
