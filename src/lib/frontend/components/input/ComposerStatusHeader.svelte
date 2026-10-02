<script lang="ts">
	import type { GoalView } from "../../stores/goal.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import TextButton from "../ui/TextButton.svelte";

	let {
		startedAt,
		activity = "",
		following = true,
		onlive,
		goal,
		goalReason,
		class: className = "",
	}: {
		startedAt: number | null;
		activity?: string | undefined;
		following?: boolean | undefined;
		onlive?: (() => void) | undefined;
		goal?: GoalView | undefined;
		goalReason?: string | undefined;
		class?: string | undefined;
	} = $props();

	let now = $state(Date.now());
	$effect(() => {
		// Restart the tick when a different session or turn is displayed.
		const start = startedAt;
		now = Date.now();
		if (start === null || goal?.phase === "checking") return;
		const timer = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	const elapsed = $derived.by(() => {
		const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
		const minutes = Math.floor(seconds / 60);
		const ss = String(seconds % 60).padStart(2, "0");
		return minutes < 60
			? `${minutes}:${ss}`
			: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
	});
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
			Working {elapsed}
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
	{#if goal?.phase !== "checking" && goalReason}
		<div data-testid="composer-status-goal-reason" class="mt-[3px] flex items-start gap-1.5 text-status-amber leading-[1.35]">
			<Icon name="target" size={12} class="mt-px shrink-0" />
			<span>Not yet: {goalReason.replace(/\.$/, "")}. Continuing.</span>
		</div>
	{/if}
</div>
