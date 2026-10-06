<script lang="ts">
	import type { GoalView } from "../../stores/goal.svelte.js";
	import { fmtClock } from "../../utils/turns.js";
	import Icon from "../ui/Icon.svelte";
	import TextButton from "../ui/TextButton.svelte";

	let {
		elapsed,
		missingPrompt = false,
		activity = "",
		following = true,
		onlive,
		goal,
		class: className = "",
	}: {
		elapsed: number | undefined;
		missingPrompt?: boolean | undefined;
		activity?: string | undefined;
		following?: boolean | undefined;
		onlive?: (() => void) | undefined;
		goal?: GoalView | undefined;
		class?: string | undefined;
	} = $props();
</script>

<div
	data-testid="composer-status-header"
	class="border-b border-border-subtle px-3 pt-[7px] pb-1.5 text-[11.5px] text-text-secondary {className}"
>
	<div class="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
		{#if goal?.phase === "checking"}
			<Icon name="loader-circle" size={12} class="shrink-0 text-status-violet motion-safe:animate-spin" />
			<b data-testid="composer-status-checking" class="shrink-0 font-semibold text-status-violet">Checking goal</b>
			<span class="min-w-0 truncate text-text-muted">{goal.subtitle.slice("Checking goal".length).trim()}</span>
		{:else}
		<span
			aria-hidden="true"
			class="size-[7px] shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
		></span>
		<b data-testid="composer-status-elapsed" class="shrink-0 font-semibold tabular-nums">
			Working{#if missingPrompt}{" (no prompt to time from)"}{:else if elapsed !== undefined}{` ${fmtClock(elapsed)}`}{/if}
		</b>
		{#if activity}
			<span
				data-testid="composer-status-activity"
				class="min-w-0 truncate text-text-muted"
				title={activity}
			>· {activity}</span>
		{/if}
		{#if !following}
			<TextButton
				tone="inherit"
				class="ml-auto shrink-0"
				data-testid="composer-status-live"
				aria-label="Follow latest output"
				onclick={onlive}
			>↓ live</TextButton>
		{/if}
		{/if}
	</div>
</div>
