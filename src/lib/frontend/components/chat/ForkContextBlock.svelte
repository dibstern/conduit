<!-- Fork Context Block -->
<!-- Collapsible block showing inherited messages from the parent session. -->
<!-- Collapsed by default. Expand/collapse state stored in sessionStorage. -->

<script lang="ts">
	import { sessionState } from "../../stores/session.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";

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
	<!--
		`layout="flow"` keeps the as-found `flex items-center` on the call site.
		The default `center` would swap it for `inline-flex` and add
		`whitespace-nowrap`, which this label must not have: "Prior conversation"
		sits above a variable-width column and is meant to wrap.
	-->
	<Button
		variant="ghost"
		size="content"
		layout="flow"
		tone="inherit"
		hoverFill="surface"
		class="fork-context-toggle flex items-center gap-2 w-full py-2 px-3 rounded-lg bg-bg-surface/50 border border-border/50 text-text-dimmer text-xs font-mono"
		onclick={toggle}
	>
		<Icon
			name="chevron-right"
			size={12}
			class="transition-transform duration-200 {collapsed ? '' : 'rotate-90'}"
		/>
		<span>Prior conversation</span>
	</Button>

	{#if !collapsed}
		<div class="fork-context-messages mt-2 pl-3 border-l-2 border-border/40 opacity-75">
			{@render children()}
		</div>
	{/if}
</div>
