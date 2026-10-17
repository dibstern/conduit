<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		tone = "neutral",
		variant = "strip",
		class: className,
		children,
		...rest
	}: {
		tone?: "neutral" | "goal" | "success" | "ask" | "risk";
		variant?: "strip" | "tray";
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "class"> = $props();

	const tones = {
		neutral: "var(--color-text-muted)",
		goal: "var(--color-status-goal)",
		success: "var(--color-success)",
		ask: "var(--color-status-ask)",
		risk: "var(--color-error)",
	};
</script>

<div
	{...rest}
	data-composer-tab
	data-variant={variant}
	class={`composer-strip ${className ?? ""}`}
	style:--strip-tone={tones[tone]}
>
	{@render children()}
</div>

<style>
	.composer-strip {
		container: composer-strip / inline-size;
		margin: 0 14px;
		padding: 7px 7px 7px 12px;
		border-radius: 16px 16px 0 0;
		background: color-mix(in srgb, var(--strip-tone) 13%, var(--color-bg-surface));
		color: var(--color-text-secondary);
		font-size: 12.5px;
		line-height: 1.35;
	}

	.composer-strip[data-variant="tray"] {
		padding: 6px 6px 4px;
		background: color-mix(in srgb, var(--strip-tone) 11%, var(--color-bg-surface));
	}

	:global([data-composer-tab]) + .composer-strip {
		border-radius: 0;
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--strip-tone) 18%, transparent);
	}
	@media (max-width: 767px) { .composer-strip { margin-inline: 12px; } }
</style>
