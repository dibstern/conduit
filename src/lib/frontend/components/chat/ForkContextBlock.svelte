<!-- Fork Context Block -->
<!-- Collapsible block showing inherited messages from the parent session. -->
<!-- The containing transcript owns expansion and its persistence. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";

	let { children, collapsed = $bindable(true), onCollapsedChange }: {
		children: import("svelte").Snippet;
		collapsed?: boolean;
		onCollapsedChange?: (collapsed: boolean) => void;
	} = $props();
	const messagesId = $props.id();
	function toggle() {
		collapsed = !collapsed;
		onCollapsedChange?.(collapsed);
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
		aria-expanded={!collapsed}
		aria-controls={messagesId}
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
		<div
			id={messagesId}
			class="fork-context-messages mt-2 pl-3 border-l-2 border-border/40 opacity-75"
		>
			{@render children()}
		</div>
	{/if}
</div>
