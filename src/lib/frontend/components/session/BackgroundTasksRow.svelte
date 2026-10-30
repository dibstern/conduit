<!--
  The header's live background tasks, as pills coloured by kind: each names
  what the task is for, its age, and the launching command on hover. The pills
  are one button that opens BackgroundTasksPanel, which owns every stop control.
  `subtitle` (desktop) sits in the title's subline, as many pills as fit, then
  "+N". `swipe` (phones) is a row of every pill that scrolls sideways. `strip`
  is the folded Duo's count strip.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import { goalDetails } from "../../stores/goal.svelte.js";
	import Button from "../ui/Button.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import Surface from "../ui/Surface.svelte";
	import { taskAge, taskClock, taskKind, tasksPanel } from "./background-tasks.svelte.js";
	import { sideThreadsPanel } from "./side-threads.svelte.js";

	let { tasks, layout, onstopall }: { tasks: readonly BackgroundTask[]; layout: "subtitle" | "swipe" | "strip"; onstopall?: (() => void) | undefined } = $props();

	const clock = taskClock(() => tasks);
	let width = $state(0);
	const newest = $derived([...tasks].reverse());
	// A pill is at most 200px; 40px keeps room for "+N".
	const shown = $derived(layout === "subtitle" ? newest.slice(0, Math.max(1, Math.min(3, Math.floor((width - 40) / 160)))) : newest);
	const hidden = $derived(newest.slice(shown.length));
	const count = $derived(`${tasks.length} background ${tasks.length === 1 ? "task" : "tasks"}`);
	// The pills' names stay in the button's name, so voice control can target what is on screen.
	const label = $derived(`${count}: ${newest.map((task) => task.description).join(", ")}`);
	function togglePanel() {
		goalDetails.open = false;
		sideThreadsPanel.open = false;
		tasksPanel.open = !tasksPanel.open;
	}
</script>

{#if layout === "strip"}
	<Surface variant="task-strip" radius="none" data-testid="background-tasks-row" class="min-w-0">
		<Button id="background-tasks-toggle" variant="ghost" size="phone-task" touchTarget="always" tone="secondary" align="start" class="flex-1 pointer-events-auto" data-testid="background-tasks-toggle" aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" onclick={togglePanel}>
			<ConduitMark size={12} variant="running" tone="inherit" />
			<span class="truncate">{tasks.length} <span class="task-strip-word">background</span> {tasks.length === 1 ? "task" : "tasks"}</span>
		</Button>
		{#if onstopall}<Button variant="ghost" size="phone-task" touchTarget="always" tone="error" class="shrink-0 px-[8px]" data-testid="background-tasks-row-stop-all" onclick={onstopall}>Stop all</Button>{/if}
	</Surface>
{:else}
	<div data-testid="background-tasks-row" data-layout={layout} bind:clientWidth={width} class="task-row min-w-0 {layout === 'subtitle' ? 'flex flex-1' : 'basis-full overflow-x-auto'}">
		<Button id="background-tasks-toggle" variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="none" touchTarget={layout === "swipe" ? "always" : false} data-testid="background-tasks-toggle" ariaLabel={label} aria-expanded={tasksPanel.open} aria-controls="background-tasks-panel" class="task-pills flex items-center {layout === 'subtitle' ? 'min-w-0 gap-[5px]' : 'w-max gap-[6px] px-[4px]'}" onclick={togglePanel}>
			{#each shown as task (task.id)}
				{@const kind = taskKind(task)}
				<span data-testid="background-task-chip" class="task-pill" style:--hue={kind.hue} title={task.detail ?? task.description}>
					<span class="task-dot" data-monitor={kind.label === "monitor" ? "" : undefined}></span>
					<span class="truncate">{task.description}</span>
					<span class="task-age">{taskAge(task, clock.now)}</span>
				</span>
			{/each}
			{#if hidden.length > 0}
				<span data-testid="background-tasks-more" class="task-more">
					<span class="flex gap-[2px]" aria-hidden="true">{#each hidden.slice(0, 3) as task (task.id)}<span class="size-[5px] rounded-full" style:background={taskKind(task).hue}></span>{/each}</span>+{hidden.length}
				</span>
			{/if}
		</Button>
	</div>
{/if}

<style>
	.task-row[data-layout="swipe"] {
		scrollbar-width: none;
		mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
	}
	.task-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 200px;
		height: 20px;
		padding: 0 7px 0 6px;
		border-radius: 6px;
		font-size: 11.5px;
		color: var(--color-text);
		background: color-mix(in srgb, var(--hue) 11%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 26%, transparent);
		transition: background-color 120ms;
	}
	:global(.task-pills:hover) .task-pill { background: color-mix(in srgb, var(--hue) 18%, transparent); }
	[data-layout="swipe"] .task-pill {
		flex: none;
		gap: 7px;
		max-width: 240px;
		height: 30px;
		padding: 0 12px 0 11px;
		border-radius: 9999px;
		font-size: 13px;
	}
	.task-dot {
		position: relative;
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--hue);
	}
	[data-layout="swipe"] .task-dot { width: 7px; height: 7px; }
	.task-age {
		flex: none;
		font-family: var(--font-mono);
		font-size: 10.5px;
		/* Dimmer fails contrast on the tinted pill. */
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.task-more {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 4px;
		height: 20px;
		padding: 0 7px;
		border-radius: 6px;
		background: var(--color-bg-alt);
		font-size: 11.5px;
		color: var(--color-text-secondary);
	}
	/* Monitors ping (watching); every other kind breathes (working). */
	@media (prefers-reduced-motion: no-preference) {
		.task-dot[data-monitor]::after {
			content: "";
			position: absolute;
			inset: 0;
			border-radius: 50%;
			background: var(--hue);
			animation: task-ping 2s ease-out infinite;
		}
		.task-dot:not([data-monitor]) { animation: task-breathe 2.4s ease-in-out infinite; }
	}
	@keyframes task-ping {
		0% { transform: scale(1); opacity: 0.55; }
		80%, 100% { transform: scale(2.6); opacity: 0; }
	}
	@keyframes task-breathe {
		50% { opacity: 0.45; }
	}
</style>
