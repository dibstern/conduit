<!--
  The header's row of live background tasks, newest first. On phones it is the
  tool-blue line under the title (an elbow off the goal subtitle when one shows)
  with one chip. Desktop gives it a full-width header row of command chips, each
  with a stop ×, as many as fit (up to four), then "+N" and Stop all. Either opens
  BackgroundTasksPanel.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import { goalDetails } from "../../stores/goal.svelte.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import TaskGlyph from "./TaskGlyph.svelte";
	import { taskAge, taskClock, taskKind, tasksPanel } from "./background-tasks.svelte.js";
	import { sideThreadsPanel } from "./side-threads.svelte.js";

	let { tasks, underGoal, compact, onstop, onstopall }: { tasks: readonly BackgroundTask[]; underGoal: boolean; compact: boolean; onstop?: ((taskId: string) => void) | undefined; onstopall?: (() => void) | undefined } = $props();

	const clock = taskClock(() => tasks);
	let width = $state(0);
	const shown = $derived([...tasks].reverse().slice(0, compact ? 1 : Math.max(0, Math.min(4, Math.floor((width - 230) / 170)))));
	const more = $derived(tasks.length - shown.length);
	function togglePanel() {
		goalDetails.open = false;
		sideThreadsPanel.open = false;
		tasksPanel.open = !tasksPanel.open;
	}
</script>

{#if !compact}
	<div data-testid="background-tasks-row" bind:clientWidth={width} class="flex min-h-[44px] min-w-0 basis-full items-center gap-[8px] border-t border-border text-[12.5px] text-text-secondary">
		<Icon name="loader-circle" size={12} class="shrink-0 motion-safe:animate-spin" />
		<Button variant="ghost" size="content" tone="secondary" touchTarget class="shrink-0" data-testid="background-tasks-toggle" aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" onclick={togglePanel}>{tasks.length} background {tasks.length === 1 ? "task" : "tasks"}</Button>
		{#each shown as task (task.id)}
			<Badge variant="chip" size="command" shape="pill" wrap data-testid="background-task-chip" class="min-w-0 max-w-[230px]">
				<Button variant="ghost" size="content" tone="secondary" touchTarget class="min-w-0" title={task.description} onclick={togglePanel}><span class="truncate">{task.detail ?? task.description}</span></Button>
				{#if onstop}<Button variant="ghost" size="content" tone="dimmer" icon="x" iconSize={11} iconOnly touchTarget class="shrink-0" ariaLabel={`Stop ${task.description}`} title="Stop task" data-testid="background-task-chip-stop" onclick={() => onstop?.(task.id)} />{/if}
			</Badge>
		{/each}
		{#if more > 0}<Button variant="chip" size="command-chip" touchTarget class="shrink-0" data-testid="background-tasks-more" ariaLabel={`Show ${more} more background tasks`} aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" onclick={togglePanel}>+{more}</Button>{/if}
		{#if onstopall}<Button variant="ghost" size="text-action" tone="error" touchTarget class="ml-auto shrink-0" data-testid="background-tasks-row-stop-all" onclick={onstopall}>Stop all</Button>{/if}
	</div>
{:else}
<Button variant="task-row" size="content" layout="block" align="start" data-testid="background-tasks-row" aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" ariaLabel={tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`} class="w-full {underGoal ? '' : 'mt-[6px]'}" onclick={() => { goalDetails.open = false; sideThreadsPanel.open = false; tasksPanel.open = !tasksPanel.open; }}>
	<!-- On phones the one chip may widen the title column. Desktop's four must
	     not set the title row's minimum width, so there the row takes no
	     intrinsic width and the chips truncate in whatever space it is given. -->
	<span class="flex w-full min-w-0 items-center gap-1">
	{#if underGoal}<span aria-hidden="true" data-testid="background-tasks-elbow" class="ml-1 mr-px text-status-goal opacity-65">└</span>{/if}
	<TaskGlyph />
	{#each shown as task (task.id)}
		<Badge variant="task" size="task" wrap data-testid="background-task-chip" class="min-w-0 shrink {tasks.length === 1 ? 'max-w-[210px]' : 'max-w-[168px]'}">
			<Icon name={taskKind(task).icon} size={11} class="shrink-0" />
			<span class="min-w-0 truncate text-text opacity-85">{task.description}</span>
			{#if !compact}<span data-testid="background-task-chip-age" class="shrink-0 text-text-muted">{taskAge(task, clock.now)}</span>{/if}
		</Badge>
	{/each}
	{#if more > 0}<span data-testid="background-tasks-more" class="shrink-0 px-0.5 text-[10.5px] font-semibold">+{more}</span>{/if}
	<Icon name="chevron-down" size={11} class="shrink-0 opacity-75 transition-transform {tasksPanel.open ? 'rotate-180' : ''}" />
	</span>
</Button>
{/if}
