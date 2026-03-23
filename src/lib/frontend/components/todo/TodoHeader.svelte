<!-- ─── Todo Header ───────────────────────────────────────────────────────── -->
<!-- Collapsible header showing "Tasks" label, completion count, and chevron. -->

<script lang="ts">
	let {
		completed,
		total,
		collapsed,
		onToggle,
	}: {
		completed: number;
		total: number;
		collapsed: boolean;
		onToggle: () => void;
	} = $props();

	function handleHeaderKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onToggle();
		}
	}
</script>

<div
	class="todo-header flex items-center gap-2 py-2 px-4 cursor-pointer select-none text-base font-medium text-text-secondary hover:text-text"
	role="button"
	tabindex="0"
	aria-expanded={!collapsed}
	onclick={onToggle}
	onkeydown={handleHeaderKeydown}
>
	<span class="todo-header-label shrink-0">Tasks</span>
	<span class="todo-header-count text-sm text-text-muted font-normal">
		{completed}/{total}
	</span>
	<span
		class="todo-chevron ml-auto text-xs text-text-dimmer transition-transform duration-150 inline-block {collapsed ? '' : 'todo-chevron-open rotate-90'}"
	>
		&#x25B8;
	</span>
</div>
