<!-- ─── Todo Overlay ──────────────────────────────────────────────────────── -->
<!-- Sticky overlay showing TodoWrite task items with progress tracking. -->
<!-- Collapsible header, animated progress bar, auto-hides after all complete. -->
<!-- Preserves #todo-sticky wrapper ID for E2E compatibility. -->

<script lang="ts">
	import type { TodoItem, TodoProgress } from "../../types.js";
	import TodoHeader from "./TodoHeader.svelte";
	import TodoProgressBar from "./TodoProgressBar.svelte";
	import TodoItemRow from "./TodoItemRow.svelte";

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

	// ─── External collapse event (e.g. mobile terminal maximize) ───────────────

	$effect(() => {
		function onTodoCollapse() {
			collapsed = true;
		}
		window.addEventListener("todo:collapse", onTodoCollapse);
		return () => window.removeEventListener("todo:collapse", onTodoCollapse);
	});
</script>

<div id="todo-sticky" class:hidden={isHidden}>
	{#if !isHidden}
		<div
		class="todo-overlay bg-bg-surface border-b border-border p-0 relative z-10 font-brand {fading ? 'todo-fade-out' : ''}"
		>
			<!-- Header -->
			<TodoHeader
				completed={progress.completed}
				total={progress.total}
				{collapsed}
				onToggle={toggleCollapse}
			/>

			<!-- Progress bar -->
			<TodoProgressBar percentage={progress.percentage} />

			<!-- Items -->
			{#if !collapsed}
				<div class="todo-items px-4 pt-1 pb-2">
					{#each items as item (item.id)}
						<TodoItemRow {item} />
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
