<!-- Icon button with a micro label under its glyph. Tap (or Enter/Space) calls
     onTap. A ~450ms long-press, Shift+F10 or the ContextMenu key calls onHold
     instead, and the click that ends a long-press is swallowed. -->
<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import { hold } from "./actions/hold.js";

	let {
		label,
		variant = "micro",
		accessibleName,
		tone = "var(--color-text-secondary)",
		tinted = false,
		pending = false,
		pulseKey,
		onTap,
		onHold,
		disabled = false,
		type = "button",
		class: className = "",
		children,
		...rest
	}: {
		label: string;
		variant?: "micro" | "chip" | "words" | undefined;
		accessibleName: string;
		tone?: string | undefined;
		tinted?: boolean | undefined;
		pending?: boolean | undefined;
		pulseKey?: unknown;
		onTap?: ((event: MouseEvent) => void) | undefined;
		onHold?: (() => void) | undefined;
		disabled?: boolean | undefined;
		type?: "button" | "submit" | "reset" | undefined;
		class?: string | undefined;
		children?: Snippet | undefined;
	} & Omit<
		HTMLButtonAttributes,
		"children" | "class" | "type" | "disabled" | "onclick" | "aria-label" | "aria-busy" | "aria-disabled"
	> = $props();

	let button = $state<HTMLButtonElement>();
	const layoutClasses: Record<"micro" | "chip" | "words", string> = {
		micro: "flex-col",
		chip: "flex-row",
		words: "flex-row",
	};
	const labelClasses: Record<"micro" | "chip" | "words", string> = {
		micro: "font-bold uppercase",
		chip: "font-semibold normal-case",
		words: "font-normal normal-case border-b border-dotted border-border-chip",
	};
	let initialized = false;
	let previousPulseKey: unknown;

	$effect(() => {
		const key = pulseKey;
		const node = button;
		if (!initialized) {
			initialized = true;
			previousPulseKey = key;
			return;
		}
		if (Object.is(key, previousPulseKey)) return;
		previousPulseKey = key;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const animation = node?.animate(
			[
				{ transform: "scale(1)" },
				{ transform: "scale(1.14)", offset: 0.4 },
				{ transform: "scale(1)" },
			],
			{ duration: 240, easing: "ease-out" },
		);
		return () => animation?.cancel();
	});
</script>

<button
	bind:this={button}
	{...rest}
	{type}
	{disabled}
	class={[
		"micro-label-button inline-flex shrink-0 items-center justify-center rounded-panel transition-colors duration-150 hover:bg-text/[0.07] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:cursor-not-allowed",
		layoutClasses[variant],
		pending || disabled ? "opacity-50" : "",
		className,
	].filter(Boolean).join(" ")}
	style:--micro-label-tone={tone}
	data-variant={variant}
	data-tinted={tinted}
	aria-label={accessibleName}
	aria-busy={pending || undefined}
	aria-disabled={pending || disabled || undefined}
	use:hold={{ onHold: pending || disabled ? undefined : onHold }}
	onclick={(event) => {
		if (pending || disabled) {
			event.preventDefault();
			return;
		}
		onTap?.(event);
	}}
>
	{#if variant !== "words"}
		<span class="glyph" aria-hidden="true">{@render children?.()}</span>
	{/if}
	<span class={["micro-label font-brand", labelClasses[variant]].join(" ")} aria-hidden="true">{label}</span>
</button>

<style>
	.micro-label-button {
		height: 32px;
		min-width: 32px;
		padding: 0 2px;
		gap: 1px;
		color: var(--micro-label-tone);
	}

	.micro-label-button[data-tinted="true"] {
		background-color: color-mix(in srgb, var(--micro-label-tone) 14%, transparent);
	}

	.micro-label-button[data-variant="chip"] {
		padding: 0 9px;
		gap: 6px;
	}

	.glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 15px;
		min-width: 15px;
	}

	.glyph :global(svg) {
		width: 15px;
		height: 15px;
	}

	.micro-label {
		font-size: 7.5px;
		line-height: 1;
		letter-spacing: 0.03em;
		white-space: nowrap;
	}

	.micro-label-button[data-variant="chip"] .micro-label {
		font-size: 12px;
		line-height: normal;
		letter-spacing: normal;
	}

	.micro-label-button[data-variant="words"] {
		height: auto;
		min-width: 0;
		padding: 2px 5px;
		gap: 5px;
		border-radius: 6px;
	}

	.micro-label-button[data-variant="words"] .micro-label {
		font-size: 11.5px;
		line-height: normal;
		letter-spacing: normal;
	}
</style>
