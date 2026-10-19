<!--
  Pull-down listing a session's live background tasks, opened from
  BackgroundTasksRow. Full width under the header on phones, a popover under
  the row on desktop. Tapping a task with a Child Session opens it. "Stop all"
  and each row's stop button stop background work only; the current turn and
  queued messages keep running. Rows leave only after SDK confirmation.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";
	import BackgroundTaskList from "./BackgroundTaskList.svelte";
	import TaskGlyph from "./TaskGlyph.svelte";

	let { tasks, compact, onstop, onstopall }: { tasks: readonly BackgroundTask[]; compact: boolean; onstop?: ((taskId: string) => void) | undefined; onstopall?: (() => void) | undefined } = $props();
</script>

<Surface id="background-tasks-panel" data-testid="background-tasks-panel" variant={compact ? "plain" : "floating"} radius="none" elevation={compact ? "panel" : "popover"} role="region" aria-label="Background tasks" class="absolute top-full z-[var(--z-popover)] max-h-[70dvh] overflow-y-auto whitespace-normal border-border px-[14px] pt-[12px] pb-[10px] text-[12px] {compact ? 'inset-x-0 rounded-b-[22px] border-b' : 'left-[20px] mt-[8px] w-[440px] max-w-[calc(100%-32px)] rounded-[16px]'}">
	<div class="flex items-center gap-[7px] font-sans text-tool {compact ? 'text-[11px] font-semibold uppercase tracking-[0.08em]' : 'text-[12px] font-medium'}">
		<TaskGlyph />{tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}
	</div>
	<BackgroundTaskList {tasks} {onstop} />
	<p class="m-0 mt-1.5 text-[11px] leading-[1.45] text-text-muted">Claude started these and moved on. They keep running between turns.</p>
	{#if onstopall}
		<div class="mt-2.5 flex">
			<Button variant="task-stop-all" size="content" icon="square" iconSize={9} class="ml-auto" data-testid="background-tasks-stop-all" title="Stops all background tasks; the current turn keeps running" onclick={onstopall}>Stop all</Button>
		</div>
	{/if}
	{#if compact}<div aria-hidden="true" class="mx-auto mt-[10px] h-[3px] w-[34px] rounded-full bg-text-dimmer/30"></div>{/if}
</Surface>
