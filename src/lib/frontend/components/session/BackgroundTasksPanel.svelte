<!--
  Pull-down listing a session's live background tasks, opened from
  BackgroundTasksRow. Full width under the header on phones, a popover under
  the row on desktop. Tapping a task with a Child Session opens it. "Stop all"
  and each row's stop button stop background work only; the current turn and
  queued messages keep running. Rows leave only after SDK confirmation.
-->
<script lang="ts">
	import type { BackgroundTask } from "../../../shared-types.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import Button from "../ui/Button.svelte";
	import Popover from "../ui/Popover.svelte";
	import Surface from "../ui/Surface.svelte";
	import { tasksPanel } from "./background-tasks.svelte.js";
	import BackgroundTaskList from "./BackgroundTaskList.svelte";
	import ConduitMark from "../ui/ConduitMark.svelte";

	let { tasks, compact, onstop, onstopall }: { tasks: readonly BackgroundTask[]; compact: boolean; onstop?: ((taskId: string) => void) | undefined; onstopall?: (() => void) | undefined } = $props();
	let openedForSession: string | null = null;
</script>

{#snippet panel()}
<Surface id="background-tasks-panel" data-testid="background-tasks-panel" variant={compact ? "plain" : "floating"} radius="none" elevation={compact ? "none" : "popover"} role="region" aria-label="Background tasks" class="whitespace-normal border-border px-[14px] pt-[12px] pb-[10px] text-[12px] {compact ? '' : 'absolute top-full z-[var(--z-popover)] max-h-[70dvh] overflow-y-auto left-[20px] mt-[8px] w-[440px] max-w-[calc(100%-32px)] rounded-[16px]'}">
	<div class="flex items-center gap-[7px] font-sans text-tool {compact ? 'text-[11px] font-semibold uppercase tracking-[0.08em]' : 'text-[12px] font-medium'}">
		<ConduitMark size={12} variant="running" tone="inherit" />{tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}
	</div>
	<BackgroundTaskList {tasks} {onstop} />
	<p class="m-0 mt-1.5 text-[11px] leading-[1.45] text-text-muted">Claude started these and moved on. They keep running between turns.</p>
	{#if onstopall}
		<div class="mt-2.5 flex">
			<Button variant="task-stop-all" size="content" icon="square" iconSize={9} class="ml-auto" data-testid="background-tasks-stop-all" title="Stops all background tasks; the current turn keeps running" onclick={onstopall}>Stop all</Button>
		</div>
	{/if}
</Surface>
{/snippet}

{#if compact}
	<Popover
		bind:open={tasksPanel.open}
		presentation="sheet"
		sheetEdge="top"
		ariaLabel="Background tasks"
		portalTo="#session-bar"
		sheetBottomPadding={0}
		sheetScrim={{ testId: "background-tasks-scrim" }}
		onInteractOutside={(event) => {
			// The row owns its click; outside-dismiss must not close before it toggles.
			if (event.target instanceof Element && event.target.closest("#background-tasks-toggle")) event.preventDefault();
		}}
		onOpenAutoFocus={() => { openedForSession = sessionState.currentId; }}
		onCloseAutoFocus={(event) => {
			// The trigger snippet is empty and the open sheet traps focus, so hand focus back to the row,
			// unless the sheet closed because the user navigated into a Child Session.
			const toggle = document.getElementById("background-tasks-toggle");
			if (tasksPanel.open || sessionState.currentId !== openedForSession || !toggle) return;
			event.preventDefault();
			toggle.focus({ preventScroll: true });
		}}
	>
		{#snippet trigger()}{/snippet}
		{@render panel()}
	</Popover>
{:else}
	{@render panel()}
{/if}
