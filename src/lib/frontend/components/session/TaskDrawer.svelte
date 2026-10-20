<!--
  Desktop task drawer beside the transcript (mockup 04): the session's one task
  list with the selected task's Child Session transcript beneath it. It never
  changes the open session, so closing it leaves the parent exactly as it was.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { attachedProjectState } from "../../stores/router.svelte.js";
	import { rootBackgroundTasks, sessionState } from "../../stores/session.svelte.js";
	import { viewTaskTranscript } from "../../stores/transcript.svelte.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import MessageList from "../chat/MessageList.svelte";
	import Button from "../ui/Button.svelte";
	import BackgroundTaskList from "./BackgroundTaskList.svelte";
	import TaskGlyph from "./TaskGlyph.svelte";
	import { type OpenedTask, taskDrawer, taskKind } from "./background-tasks.svelte.js";

	let { task }: { task: OpenedTask } = $props();

	let drawerEl: HTMLElement | undefined = $state();
	// Whoever opened the drawer gets focus back when it closes.
	const active = document.activeElement;
	const opener = active instanceof HTMLElement && active !== document.body ? active : null;

	// The list is the open session's; the transcript is the selected task's.
	const tasks = $derived(rootBackgroundTasks(sessionState.currentId ?? ""));
	const listed = $derived(tasks.find((candidate) => candidate.id === task.id));

	$effect(() => {
		const project = attachedProjectState.slug ?? "";
		const sessionId = project ? task.sessionId : null;
		untrack(() => viewTaskTranscript(project, sessionId));
		return () => viewTaskTranscript(project, null);
	});

	$effect(() => {
		const drawer = drawerEl;
		if (!drawer) return;
		drawer.focus();
		drawer.addEventListener("keydown", handleKeydown);
		return () => drawer.removeEventListener("keydown", handleKeydown);
	});

	function close() {
		taskDrawer.task = null;
		const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>("[data-testid='background-tasks-toggle'], button[data-testid='background-tasks-row']") ?? document.getElementById("messages");
		target?.focus({ preventScroll: true });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape" || event.defaultPrevented || uiState.confirmDialog) return;
		const focused = document.activeElement;
		if (focused && focused !== document.body && !drawerEl?.contains(focused)) return;
		event.preventDefault();
		event.stopPropagation();
		close();
	}
</script>

<aside bind:this={drawerEl} data-testid="task-drawer" tabindex="-1" aria-label="Background task: {task.description}" class="flex w-[380px] shrink-0 min-h-0 flex-col border-l border-border bg-bg-surface text-[12px] outline-none">
	<div class="flex items-center gap-[7px] px-[14px] pt-[12px] font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-tool">
		<TaskGlyph />{tasks.length === 0 ? "Background tasks" : tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`}
		<Button variant="toolbar" size="content" tone="dimmer" hoverFill="overlay" class="ml-auto h-6 w-6 shrink-0 rounded-md" iconOnly icon="x" iconSize={14} ariaLabel="Close task drawer" title="Close (Esc)" data-testid="task-drawer-close" onclick={close} />
	</div>
	{#if tasks.length > 0}
		<div class="max-h-[40%] shrink-0 overflow-y-auto px-[14px]"><BackgroundTaskList {tasks} selected={task.id} /></div>
	{/if}
	<div data-testid="task-drawer-selected" class="flex min-w-0 items-baseline gap-1.5 border-y border-border-subtle px-[14px] py-2 text-[11px] text-text-muted">
		<b class="min-w-0 truncate font-semibold text-text">{task.description}</b>
		<span class="shrink-0">· {listed ? `${taskKind(listed).label} · running` : "ended"}</span>
	</div>
	<div data-testid="task-drawer-transcript" class="flex flex-1 min-h-0 flex-col overflow-hidden">
		<MessageList sessionId={task.sessionId} />
	</div>
</aside>
