<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import ToggleGroup from "../ui/ToggleGroup.svelte";
	import { sessionViews, viewShortcutHint } from "./session-views.js";

	// Chat is always visible on desktop, so the rail only toggles side views.
	const railViews = sessionViews.filter((view) => view.id !== "chat");
	const options = railViews.map((view) => ({
		value: view.id,
		label: view.label,
		shortcut: viewShortcutHint(view),
		disabled: view.disabled === true,
		testId: `views-rail-${view.id}`,
	}));
	const pressed = $derived(railViews.filter((view) => view.isOn()).map((view) => view.id));
</script>

<div data-testid="views-rail" class="hidden md:flex w-[38px] shrink-0 justify-center border-l border-border bg-bg-surface">
	<ToggleGroup
		value={pressed}
		{options}
		variant="rail"
		orientation="vertical"
		label="Views"
		onToggle={(id) => railViews.find((view) => view.id === id)?.select()}
	>
		{#snippet optionContent(option)}
			{@const view = railViews.find((entry) => entry.id === option.value)}
			{@const badge = view?.badge?.()}
			{#if view}<Icon name={view.icon} size={16} />{/if}
			{#if badge}
				<Badge variant="accent-solid" size="count" shape="pill" class="absolute -top-1 -right-1">{badge}</Badge>
			{/if}
		{/snippet}
	</ToggleGroup>
</div>
