<!--
  The session's one list of background tasks, nested tasks indented under the
  agent that started them. The pull-down and the desktop task drawer both show
  it. A task with a Child Session opens it. Optional stop buttons are separate
  from navigation and leave the task visible until the SDK confirms its stop.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import { nestTasks, openTask, taskAge, taskChildSession, taskClock, taskKind } from "./background-tasks.svelte.js";

	let { tasks, selected, onstop }: { tasks: readonly BackgroundTask[]; selected?: string | undefined; onstop?: ((taskId: string) => void) | undefined } = $props();

	const clock = taskClock(() => tasks);
	const rowClass = "grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)_auto_12px] items-center gap-2 py-1.5 text-left";
</script>

<ul data-testid="background-tasks-list" class="m-0 mt-2 list-none p-0">
	{#each nestTasks(tasks) as { task, depth } (task.id)}
		{@const sessionId = taskChildSession(task)}
		<!-- A nested task indents under the agent that started it, on a tool-blue rule. -->
		<li data-testid="background-task" data-depth={depth} aria-current={task.id === selected ? "true" : undefined} style:margin-left={depth ? `${depth * 18}px` : undefined} class="flex items-center gap-2 border-t border-border-subtle text-text {depth ? 'border-l-2 border-l-tool/35 pl-2' : ''} {task.id === selected ? 'bg-tool/10' : ''}">
			{#snippet row()}
				<Icon name={taskKind(task).icon} size={14} class="text-tool" />
				<span class="flex min-w-0 flex-col">
					<span data-testid="background-task-description" class="truncate">{task.description}</span>
					<small data-testid="background-task-kind" class="text-[11px] text-text-muted">{taskKind(task).label}</small>
				</span>
				<span data-testid="background-task-age" class="text-[11px] text-text-muted">{taskAge(task, clock.now)}</span>
			{/snippet}
			{#if sessionId}
				<Button variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="overlay" data-testid="background-task-open" class="{rowClass} rounded-[6px]" ariaLabel="Open {task.description}" onclick={() => openTask({ id: task.id, sessionId, description: task.description })}>
					{@render row()}
					<Icon name="arrow-right" size={12} class="text-text-dimmer" />
				</Button>
			{:else}
				<div class={rowClass}>{@render row()}</div>
			{/if}
			{#if onstop}
				<Button variant="secondary" size="content" tone="inherit" icon="square" iconSize={9} iconOnly class="h-7 w-7 shrink-0 rounded-[8px] text-status-red" data-testid="background-task-stop" ariaLabel="Stop {task.description}" onclick={() => onstop?.(task.id)} />
			{/if}
		</li>
	{/each}
</ul>
