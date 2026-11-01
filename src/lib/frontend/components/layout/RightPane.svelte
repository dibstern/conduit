<script lang="ts">
	import { tick, type Snippet } from "svelte";
	import { closeFileViewer, RIGHT_PANE_MIN_WIDTH, isBarCollapsed, sessionViewState, setRightPaneView, setRightPaneWidth } from "../../stores/session-view.svelte.js";
	import { activeSessionView, sessionViews } from "./session-views.js";
	import Button from "../ui/Button.svelte";
	import Tabs from "../ui/Tabs.svelte";

	let { children }: { children: Snippet } = $props();
	const CHAT_MIN_WIDTH = 360;
	const DIVIDER_WIDTH = 6;
	const paneViews = sessionViews.filter((view) => view.loadPane);
	let row: HTMLDivElement | undefined = $state();
	let rowWidth = $state(0);
	let drag: { pointerId: number; startX: number; startWidth: number } | null = $state(null);
	let opened = $state(new Set<string>());
	const view = $derived(sessionViewState.rightPaneView);
	const open = $derived(view !== "closed" && (!sessionViewState.compact || activeSessionView() === view));
	const maxWidth = $derived(Math.max(RIGHT_PANE_MIN_WIDTH, rowWidth - DIVIDER_WIDTH - CHAT_MIN_WIDTH));
	const defaultWidth = $derived(Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(640, rowWidth * 0.4)));
	const width = $derived(Math.min(maxWidth, sessionViewState.rightPaneWidth ?? defaultWidth));
	const forcedExpanded = $derived(!sessionViewState.compact && rowWidth < CHAT_MIN_WIDTH + DIVIDER_WIDTH + RIGHT_PANE_MIN_WIDTH);
	const expanded = $derived(open && !sessionViewState.compact && (sessionViewState.rightPaneExpanded || forcedExpanded));
	const label = $derived(sessionViews.find((entry) => entry.id === view)?.label ?? "Files");
	const expandLabel = $derived(forcedExpanded ? `Not enough room to show chat beside ${label}` : `${expanded ? "Restore" : "Expand"} ${label} pane`);
	const preview = $derived(view === "files" && sessionViewState.filePreview !== null);

	$effect(() => {
		if (view !== "closed" && !opened.has(view)) opened = new Set([...opened, view]);
	});

	$effect(() => {
		if (!row) return;
		const measure = () => { rowWidth = row?.clientWidth ?? 0; };
		measure();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure);
			return () => window.removeEventListener("resize", measure);
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) rowWidth = entry.contentRect.width;
		});
		observer.observe(row);
		return () => observer.disconnect();
	});

	function closePane() {
		const previous = view;
		setRightPaneView("closed");
		void tick().then(() => {
			const target = sessionViewState.compact ? document.getElementById("input") : document.querySelector<HTMLButtonElement>(`[data-testid="views-rail-${previous}"]`);
			target?.focus({ preventScroll: true });
		});
	}

	function toggleExpanded() {
		sessionViewState.rightPaneExpanded = !expanded;
		void tick().then(() => document.getElementById("files-pane-expand")?.focus({ preventScroll: true }));
	}

	function pointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
		if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
	}

	function pointerMove(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		setRightPaneWidth(Math.min(maxWidth, Math.max(RIGHT_PANE_MIN_WIDTH, drag.startWidth + drag.startX - event.clientX)));
	}

	function pointerEnd(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		drag = null;
		if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	}

	function resizeKey(event: KeyboardEvent) {
		let next: number;
		switch (event.key) {
			case "ArrowLeft": next = width + 16; break;
			case "ArrowRight": next = width - 16; break;
			case "Home": next = RIGHT_PANE_MIN_WIDTH; break;
			case "End": next = maxWidth; break;
			default: return;
		}
		event.preventDefault();
		setRightPaneWidth(Math.min(maxWidth, Math.max(RIGHT_PANE_MIN_WIDTH, next)));
	}

</script>


<div bind:this={row} class="relative flex flex-1 min-h-0 min-w-0" class:select-none={drag !== null}>
	<div id="chat-area" class="flex flex-col flex-1 min-h-0 min-w-0 has-[#model-picker]:overflow-x-visible" class:overflow-x-clip={open && !sessionViewState.compact && !expanded} class:relative={!expanded} class:absolute={expanded} class:inset-0={expanded} class:invisible={expanded} class:island-transcript={isBarCollapsed() && activeSessionView() === "chat"} inert={expanded || (open && sessionViewState.compact)} style:min-width={open && !sessionViewState.compact && !expanded ? `${CHAT_MIN_WIDTH}px` : undefined}>
		{@render children()}
	</div>
	{#if open}
		{#if !sessionViewState.compact && !expanded}
			<Button variant="toolbar" size="content" tone="inherit" hoverFill="none" role="separator" aria-orientation="vertical" ariaLabel={`Resize ${label} pane`} aria-valuemin={RIGHT_PANE_MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width}px`} tabindex={0} class="group relative z-10 w-1.5 shrink-0 cursor-col-resize aria-[orientation=vertical]:cursor-col-resize touch-none rounded-none after:absolute after:inset-y-0 after:-inset-x-px after:content-[''] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-text" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerEnd} onpointercancel={pointerEnd} onlostpointercapture={pointerEnd} onkeydown={resizeKey}>
				<span aria-hidden="true" class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 {drag ? 'bg-accent' : 'bg-border group-hover:bg-accent/50 group-focus-visible:bg-accent'}"></span>
			</Button>
		{/if}
		<div id="right-pane" data-testid="side-pane-files" aria-label={`${label} pane`} class="flex min-h-0 min-w-0 flex-col bg-bg-surface" class:fixed={sessionViewState.compact} class:inset-0={sessionViewState.compact} class:z-50={sessionViewState.compact} class:relative={!sessionViewState.compact} style:flex={expanded ? "1 1 0%" : "0 0 auto"} style:width={sessionViewState.compact || expanded ? undefined : `${width}px`} style:padding-top={sessionViewState.compact ? "max(env(safe-area-inset-top, 0px), var(--phone-chrome-clearance, 0px))" : undefined} style:padding-bottom={sessionViewState.compact ? "env(safe-area-inset-bottom, 0px)" : undefined}>
			<div class="flex min-h-[44px] md:min-h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
				<div id="files-pane-title" class="shrink-0">
					{#if view === "servers"}
						<h2 class="m-0 px-1 text-sm font-medium text-text">Servers</h2>
					{:else}
						<Tabs value={view} options={[{ value: "files", label: "Files" }, { value: "diff", label: "Diff" }]} label="Right pane" variant="pill" onValueChange={setRightPaneView} />
					{/if}
				</div>
				{#if preview}
					<span class="min-w-0 truncate rounded-full border border-border-subtle bg-bg-alt px-2 py-0.5 font-mono text-xs text-text-muted" dir="rtl" title={sessionViewState.filePreview?.path}>{sessionViewState.filePreview?.path}</span>
				{/if}
				<span class="flex-1"></span>
				{#if !sessionViewState.compact}
					<Button id="files-pane-expand" variant="toolbar" size="content" tone="dimmer" hoverFill="overlay" class="h-6 w-6 shrink-0 rounded-md" iconOnly icon={expanded ? "minimize" : "maximize"} iconSize={14} ariaLabel={expandLabel} title={expandLabel} aria-pressed={expanded} disabled={forcedExpanded} onclick={toggleExpanded} />
				{/if}
				<Button data-testid="right-pane-close" variant="toolbar" size="content" tone="dimmer" hoverFill="overlay" class="h-6 w-6 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 rounded-md" iconOnly icon="x" iconSize={14} ariaLabel={`Close ${label} pane`} title={`Close ${label} pane`} onclick={closePane} />
			</div>
			{#each paneViews as entry (entry.id)}
				{#if opened.has(entry.id) && entry.loadPane}
					<div id={`right-pane-panel-${entry.id}`} role="tabpanel" aria-label={entry.label} class="relative flex flex-1 min-h-0 min-w-0" class:hidden={view !== entry.id} inert={view !== entry.id}>
						<div class="flex flex-1 min-h-0 min-w-0" class:invisible={preview && entry.id === "files"} inert={preview && entry.id === "files"}>
							{#await entry.loadPane() then { default: PaneView }}
								<PaneView pane visible={view === entry.id} onClose={closePane} />
							{/await}
							</div>
						{#if entry.id === "files" && sessionViewState.filePreview}
							<div class="absolute inset-0 flex min-h-0">
								{#await import("../file/FileViewer.svelte") then { default: FileViewer }}
									<FileViewer pane visible={view === "files"} onClose={closeFileViewer} />
								{/await}
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
