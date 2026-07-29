<!--
  Badge — a passive <span> for labels, counts, and tags.

  Phase 4 migration targets:
  - accent: project/ProjectSwitcher.svelte:310, layout/Header.svelte:266
  - neutral: model/AgentSelector.svelte:298, overlays/SettingsPanel.svelte:612,
    chat/ToolGenericCard.svelte:171, chat/ToolGroupItem.svelte:105
  - success: overlays/SettingsPanel.svelte:660

  Explicitly not Badge: status dots or todo markers, setup step numbers,
  /skill highlight spans, <kbd>/<code> sites, or the scroll-to-bottom action
  at chat/MessageList.svelte:320 (that is a Button).
-->
<script module lang="ts">
	type BadgeVariant = "neutral" | "accent" | "success";
	type BadgeSize = "xs" | "sm";

	const VARIANT_CLASSES: Record<BadgeVariant, string> = {
		neutral: "bg-bg-alt text-text-muted border border-border",
		accent: "bg-accent-bg text-accent",
		success: "bg-success/10 text-success",
	};

	// Heights are on the spacing scale, not literals. The root font-size is 12px,
	// so h-6 is 18px (the client-count bubble's old `h-[18px]`) and h-8 is 24px
	// — the same height as Button size="sm", so a badge beside a small button
	// shares its baseline box. Explicit heights are what keep a rounded-full
	// badge a capsule instead of letting content make it ovoid.
	const SIZE_CLASSES: Record<BadgeSize, string> = {
		xs: "h-6 px-1.5 text-xs",
		sm: "h-8 px-2 text-sm",
	};

	const BASE_CLASSES =
		"inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap leading-none";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type BadgeProps = {
		variant?: BadgeVariant;
		size?: BadgeSize;
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLSpanElement>, "class">;

	let {
		variant = "neutral",
		size = "xs",
		class: className,
		children,
		...rest
	}: BadgeProps = $props();

	const badgeClass = $derived(
		[
			BASE_CLASSES,
			VARIANT_CLASSES[variant],
			SIZE_CLASSES[size],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<span {...rest} class={badgeClass}>{@render children()}</span>
