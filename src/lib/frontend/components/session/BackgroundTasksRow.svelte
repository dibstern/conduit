<!--
  The header's row of live background tasks. Phones show the count and Stop all.
  Desktop gives it a full-width header row of command chips, each
  with a stop ×, as many as fit (up to four), then "+N" and Stop all. Either opens
  BackgroundTasksPanel.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import { goalDetails } from "../../stores/goal.svelte.js";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import Surface from "../ui/Surface.svelte";
	import { tasksPanel } from "./background-tasks.svelte.js";
	import { sideThreadsPanel } from "./side-threads.svelte.js";

	let { tasks, compact, onstop, onstopall }: { tasks: readonly BackgroundTask[]; compact: boolean; onstop?: ((taskId: string) => void) | undefined; onstopall?: (() => void) | undefined } = $props();

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
	<div data-testid="background-tasks-row" bind:clientWidth={width} class="flex min-h-[36px] min-w-0 basis-full items-center gap-[8px] pl-[20px] pr-[16px] border-t border-border-subtle text-[12.5px] text-text-secondary">
		<ConduitMark size={12} variant="running" tone="inherit" />
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
	<Surface variant="task-strip" radius="none" data-testid="background-tasks-row" class="min-w-0">
		<Button id="background-tasks-toggle" variant="ghost" size="phone-task" touchTarget="always" tone="secondary" align="start" class="flex-1 pointer-events-auto" data-testid="background-tasks-toggle" aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" onclick={togglePanel}>
			<ConduitMark size={12} variant="running" tone="inherit" />
			<span class="truncate">{tasks.length} background {tasks.length === 1 ? "task" : "tasks"}</span>
		</Button>
		{#if onstopall}<Button variant="ghost" size="phone-task" touchTarget="always" tone="error" class="shrink-0 px-[8px]" data-testid="background-tasks-row-stop-all" onclick={onstopall}>Stop all</Button>{/if}
	</Surface>
{/if}
