<!-- ─── Todo Item Row ─────────────────────────────────────────────────────── -->
<!-- Single todo item with status icon, subject text, and optional description. -->

<script lang="ts">
	import type { TodoItem, TodoStatus } from "../../types.js";
	import { assertNever } from "../../../utils.js";

	let { item }: { item: TodoItem } = $props();

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

<div
	class="todo-item flex items-start gap-2 py-[3px] text-base"
	data-todo-id={item.id}
>
	<span
		class="todo-icon inline-block w-3.5 h-3.5 shrink-0 mt-0.5 rounded-full relative {getStatusIconClass(item.status)}"
	>
		{#if item.status === "completed"}
			<span
				class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs leading-none text-white font-bold"
				>&#x2713;</span
			>
		{:else if item.status === "cancelled"}
			<span
				class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs leading-none text-text-dimmer font-bold"
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
