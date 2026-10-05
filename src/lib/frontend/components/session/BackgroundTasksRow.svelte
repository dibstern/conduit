<!--
  The header's tool-blue row of live background tasks (design: 2026-10-03
  background-tasks-header). It hangs off the goal subtitle with an elbow when
  a goal is showing, and sits under the title otherwise. Newest task first;
  phones fit one chip, desktop up to four with ages, then "+N". Tapping it
  opens BackgroundTasksPanel.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import { goalDetails } from "../../stores/goal.svelte.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import TaskGlyph from "./TaskGlyph.svelte";
	import { taskAge, taskClock, taskKind, tasksPanel } from "./background-tasks.svelte.js";

	let { tasks, underGoal, compact }: { tasks: readonly BackgroundTask[]; underGoal: boolean; compact: boolean } = $props();

	const clock = taskClock(() => tasks);
	const shown = $derived([...tasks].reverse().slice(0, compact ? 1 : 4));
	const more = $derived(tasks.length - shown.length);
</script>

<Button variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="none" data-testid="background-tasks-row" aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" ariaLabel={tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`} class="flex items-center justify-start whitespace-nowrap select-none {compact ? 'w-full' : 'w-0 min-w-full'} {underGoal ? '' : 'mt-[6px]'} gap-1 text-[11px] leading-[1.5] text-tool" onclick={() => { goalDetails.open = false; tasksPanel.open = !tasksPanel.open; }}>
	<!-- On phones the one chip may widen the title column. Desktop's four must
	     not set the title row's minimum width, so there the row takes no
	     intrinsic width and the chips truncate in whatever space it is given. -->
	<span class="flex w-full min-w-0 items-center gap-1">
	{#if underGoal}<span aria-hidden="true" data-testid="background-tasks-elbow" class="ml-1 mr-px text-status-violet opacity-65">└</span>{/if}
	<TaskGlyph />
	{#each shown as task (task.id)}
		<span data-testid="background-task-chip" class="inline-flex min-w-0 shrink items-center gap-1 rounded-[6px] bg-tool/13 py-0 pr-1.5 pl-[5px] text-[10.5px] {compact ? (tasks.length === 1 ? 'max-w-[210px]' : 'max-w-[168px]') : 'max-w-[230px]'}">
			<Icon name={taskKind(task).icon} size={11} class="shrink-0" />
			<span class="min-w-0 truncate text-text opacity-85">{task.description}</span>
			{#if !compact}<span data-testid="background-task-chip-age" class="shrink-0 text-text-muted">{taskAge(task, clock.now)}</span>{/if}
		</span>
	{/each}
	{#if more > 0}<span data-testid="background-tasks-more" class="shrink-0 px-0.5 text-[10.5px] font-semibold">+{more}</span>{/if}
	<Icon name="chevron-down" size={11} class="shrink-0 opacity-75 transition-transform {tasksPanel.open ? 'rotate-180' : ''}" />
	</span>
</Button>
