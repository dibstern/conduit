<!-- "3 running" beside a turn's bill: the tasks it launched that are still live, -->
<!-- nested tasks included (liveLaunchedTasks). Absent once they all finish.      -->
<!-- .turn-running is an E2E hook; it stays outside .turn-meta, which is the bill. -->
<script lang="ts">
	import ConduitMark from "../ui/ConduitMark.svelte";

	let { count }: { count: number } = $props();
</script>

{#if count > 0}
	<span
		class="turn-running inline-flex shrink-0 items-center gap-1.5 rounded-full border border-tool/35 bg-tool/7 px-2 py-px font-mono text-[11px] text-tool whitespace-nowrap"
		title="{count} background {count === 1 ? 'task' : 'tasks'} still running"
	>
		<ConduitMark size={12} variant="running" tone="inherit" />
		<span>{count}</span>
		<span class="@max-[336px]:hidden">running</span>
	</span>
{/if}
