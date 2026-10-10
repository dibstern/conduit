<!--
  Pull-down listing a session's live background tasks, opened from
  BackgroundTasksRow. Full width under the header on phones, a popover under
  the row on desktop. Tapping a task with a Child Session opens it. "Stop all"
  stops the whole session until per-task stop lands (conduit-test-va96.2).
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";
	import BackgroundTaskList from "./BackgroundTaskList.svelte";
	import TaskGlyph from "./TaskGlyph.svelte";

	let { tasks, compact, onstopall }: { tasks: readonly BackgroundTask[]; compact: boolean; onstopall: () => void } = $props();
</script>

<Surface id="background-tasks-panel" data-testid="background-tasks-panel" variant="plain" radius="none" elevation="panel" role="region" aria-label="Background tasks" class="absolute top-full z-[var(--z-popover)] max-h-[70dvh] overflow-y-auto whitespace-normal border-border px-[14px] pt-[12px] pb-[10px] text-[12px] {compact ? 'inset-x-0 rounded-b-[22px] border-b' : 'left-4 mt-1 w-[440px] max-w-[calc(100%-32px)] rounded-[14px] border'}">
	<div class="flex items-center gap-[7px] font-brand text-[11px] font-semibold uppercase tracking-[0.08em] text-tool">
		<TaskGlyph />{tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}
	</div>
	<BackgroundTaskList {tasks} />
	<p class="m-0 mt-1.5 text-[11px] leading-[1.45] text-text-muted">Claude started these and moved on. They keep running between turns.</p>
	<div class="mt-2.5 flex">
		<Button variant="secondary" size="content" tone="inherit" icon="square" iconSize={9} class="ml-auto gap-1.5 rounded-[9px] px-[10px] py-[6px] text-[11.5px] text-status-red" data-testid="background-tasks-stop-all" title="Stops the session and everything it started" onclick={onstopall}>Stop all</Button>
	</div>
	{#if compact}<div aria-hidden="true" class="mx-auto mt-[10px] h-[3px] w-[34px] rounded-full bg-text-dimmer/30"></div>{/if}
</Surface>
