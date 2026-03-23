<!-- ─── Todo Overlay ──────────────────────────────────────────────────────── -->
<!-- Sticky overlay showing TodoWrite task items with progress tracking. -->
<!-- Collapsible header, animated progress bar, auto-hides after all complete. -->
<!-- Preserves #todo-sticky wrapper ID for E2E compatibility. -->

<script lang="ts">
	import type { TodoItem, TodoProgress, TodoStatus } from "../../types.js";
	import { assertNever } from "../../../utils.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let { items }: { items: TodoItem[] } = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let collapsed = $state(false);
	let fading = $state(false);
	let hidden = $state(false);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const progress: TodoProgress = $derived.by(() => {
		const total = items.length;
		if (total === 0) return { completed: 0, total: 0, percentage: 0 };
		const completed = items.filter(
			(i) => i.status === "completed" || i.status === "cancelled",
		).length;
		const percentage = Math.round((completed / total) * 100);
		return { completed, total, percentage };
	});

	const allCompleted = $derived(
		items.length > 0 &&
			items.every(
				(i) => i.status === "completed" || i.status === "cancelled",
			),
	);

	const isHidden = $derived(items.length === 0 || hidden);

	// ─── Auto-hide after all items completed ────────────────────────────────────

	let fadeTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!allCompleted) {
			// Reset hide state if items change and are no longer all complete
			fading = false;
			hidden = false;
			return;
		}

		// Schedule auto-hide: 5s delay, then fade
		const autoHideTimer = setTimeout(() => {
			fading = true;
			fadeTimer = setTimeout(() => {
				hidden = true;
				fading = false;
				fadeTimer = null;
			}, 500);
		}, 5000);

		return () => {
			clearTimeout(autoHideTimer);
			if (fadeTimer) {
				clearTimeout(fadeTimer);
				fadeTimer = null;
			}
		};
	});

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function toggleCollapse(): void {
		collapsed = !collapsed;
	}

	function handleHeaderKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggleCollapse();
		}
	}

	// ─── External collapse event (e.g. mobile terminal maximize) ───────────────

	$effect(() => {
		function onTodoCollapse() {
			collapsed = true;
		}
		window.addEventListener("todo:collapse", onTodoCollapse);
		return () => window.removeEventListener("todo:collapse", onTodoCollapse);
	});

	// ─── Status icon helpers ────────────────────────────────────────────────────

	function getStatusIconClass(status: TodoStatus): string {
		switch (status) {
			case "pending":
				return "todo-icon-pending border-2 border-text-muted bg-transparent";
			case "in_progress":
				return "todo-icon-progress border-2 border-border border-t-accent animate-todo-spin";
			case "completed":
				return "todo-icon-completed bg-success border-none";
			case "cancelled":
				return "todo-icon-cancelled border-2 border-text-dimmer bg-transparent";
			default:
				return assertNever(status);
		}
	}
</script>

<div id="todo-sticky" class:hidden={isHidden}>
	{#if !isHidden}
		<div
			class="todo-overlay bg-bg-surface border-b border-border p-0 relative z-10 {fading ? 'todo-fade-out' : ''}"
			style="font-family: var(--font-brand);"
		>
			<!-- Header -->
			<div
				class="todo-header flex items-center gap-2 py-2 px-4 cursor-pointer select-none text-[12px] font-medium text-text-secondary hover:text-text"
				role="button"
				tabindex="0"
				aria-expanded={!collapsed}
				onclick={toggleCollapse}
				onkeydown={handleHeaderKeydown}
			>
				<span class="todo-header-label shrink-0">Tasks</span>
				<span
					class="todo-header-count text-[11px] text-text-muted font-normal"
				>
					{progress.completed}/{progress.total}
				</span>
				<span
					class="todo-chevron ml-auto text-[10px] text-text-dimmer transition-transform duration-150 inline-block {collapsed ? '' : 'todo-chevron-open rotate-90'}"
				>
					&#x25B8;
				</span>
			</div>

			<!-- Progress bar -->
			<div
				class="todo-progress-bar-track h-[3px] bg-border-subtle overflow-hidden"
			>
				<div
					class="todo-progress-bar-fill h-full bg-success transition-[width] duration-300 ease-out rounded-r-sm"
					style="width: {progress.percentage}%"
				></div>
			</div>

			<!-- Items -->
			{#if !collapsed}
				<div class="todo-items px-4 pt-1 pb-2">
					{#each items as item (item.id)}
						<div
							class="todo-item flex items-start gap-2 py-[3px] text-[13px]"
							data-todo-id={item.id}
						>
							<span
								class="todo-icon inline-block w-3.5 h-3.5 shrink-0 mt-0.5 rounded-full relative {getStatusIconClass(item.status)}"
							>
								{#if item.status === "completed"}
									<span
										class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] leading-none text-white font-bold"
										>&#x2713;</span
									>
								{:else if item.status === "cancelled"}
									<span
										class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] leading-none text-text-dimmer font-bold"
										>&#x2715;</span
									>
								{/if}
							</span>
							<div class="todo-item-text flex-1 min-w-0">
								<span
									class="todo-subject text-text leading-[1.4] {item.status === 'completed' || item.status === 'cancelled' ? 'todo-subject-done line-through text-text-muted' : ''}"
								>
									{item.subject}
								</span>
								{#if item.description}
									<div
										class="todo-description text-xs text-text-dimmer mt-px leading-[1.3]"
									>
										{item.description}
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
