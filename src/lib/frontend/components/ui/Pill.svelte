<!--
  Pill — an interactive <button> that opens a menu.

  Phase 4 migration targets: model/ModelVariant.svelte:119,
  model/ContextWindowSelector.svelte:103,
  input/PermissionModeSelector.svelte:87 (neutral, warning when elevated), and
  layout/Header.svelte:161.
-->
<script module lang="ts">
	type PillVariant = "neutral" | "warning";

	const VARIANT_CLASSES: Record<PillVariant, string> = {
		neutral:
			"border-border bg-bg-alt text-text-muted hover:bg-bg hover:text-text-secondary",
		warning: "border-warning/30 bg-warning-bg text-warning",
	};

	// Match Button's focus-ring and disabled treatments so every interactive
	// primitive in ui/ exposes the same visible focus and unavailable states.
	const BASE_CLASSES =
		"inline-flex items-center gap-1 h-6 px-2 rounded-full border text-xs font-medium " +
		"whitespace-nowrap cursor-pointer select-none transition-colors font-brand " +
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 " +
		"disabled:opacity-50 disabled:cursor-not-allowed";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";

	type PillProps = {
		variant?: PillVariant;
		onclick?: HTMLButtonAttributes["onclick"];
		class?: string;
		children: Snippet;
	} & Omit<HTMLButtonAttributes, "class" | "onclick" | "type">;

	let {
		variant = "neutral",
		onclick,
		class: className,
		children,
		...rest
	}: PillProps = $props();

	const pillClass = $derived(
		[BASE_CLASSES, VARIANT_CLASSES[variant], className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<button {...rest} type="button" class={pillClass} {onclick}>
	{@render children()}
</button>
