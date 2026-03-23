<!-- Fork Context Block -->
<!-- Collapsible block showing inherited messages from the parent session. -->
<!-- Collapsed by default. Expand/collapse state stored in sessionStorage. -->

<script lang="ts">
	import { sessionState } from "../../stores/session.svelte.js";
	import Icon from "../shared/Icon.svelte";

	interface Props {
		children: import("svelte").Snippet;
	}

	let { children }: Props = $props();

	const storageKey = $derived(
		`fork-collapsed-${sessionState.currentId ?? ""}`,
	);

	// Default to collapsed; read from sessionStorage if available
	let collapsed = $state(true);

	$effect(() => {
		const key = storageKey;
		if (key) {
			const stored = sessionStorage.getItem(key);
			collapsed = stored !== "false";
		}
	});

	function toggle() {
		collapsed = !collapsed;
		const key = storageKey;
		if (key) {
			sessionStorage.setItem(key, String(collapsed));
		}
	}
</script>

<div class="fork-context-block max-w-[760px] mx-auto px-5 mt-2">
	<button
		type="button"
		class="fork-context-toggle flex items-center gap-2 w-full py-2 px-3 rounded-lg bg-bg-surface/50 border border-border/50 text-text-dimmer text-xs font-mono cursor-pointer hover:bg-bg-surface transition-colors"
		onclick={toggle}
	>
		<Icon
			name="chevron-right"
			size={12}
			class="transition-transform duration-200 {collapsed ? '' : 'rotate-90'}"
		/>
		<span>Prior conversation</span>
	</button>

	{#if !collapsed}
		<div class="fork-context-messages mt-2 pl-3 border-l-2 border-border/40 opacity-75">
			{@render children()}
		</div>
	{/if}
</div>
