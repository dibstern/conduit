<!--
  Badge — a passive <span> for labels, counts, and tags.

  The seven real badge sites agreed on the shape (inline tinted chip, small
  text, no interaction) and disagreed on almost every value: three radii, four
  text colours, four font weights, two of them sizing by height and five by
  padding. This primitive picks one of each and records the divergences in
  conduit-test-7oga rather than encoding the drift as props.

  Deliberately NOT a Badge: the "CCS detected on port 8317" chip in
  overlays/SettingsPanel. It is an icon plus a full sentence on a green fill,
  which is an inline alert; shared appearance is not shared meaning. Also not
  badges: status dots, todo markers, setup step numbers, /skill highlight
  spans, <kbd>/<code> sites, and the scroll-to-bottom action in MessageList
  (that one is a Button).
-->
<script module lang="ts">
	type BadgeVariant = "neutral" | "accent" | "accent-solid" | "tag";
	type BadgeSize = "xs" | "sm" | "count";
	type BadgeShape = "rounded" | "pill";

	const VARIANT_CLASSES: Record<BadgeVariant, string> = {
		neutral: "bg-bg text-text-dimmer border border-border",
		accent: "bg-accent-bg text-accent",
		"accent-solid": "bg-accent text-bg",
		// The tag tint is theme-aware on purpose: the two SettingsPanel chips
		// used bg-white/[0.08], which is white-on-white in the light theme.
		// An arbitrary rgba() belongs here, inside the design system, rather
		// than in seven feature files — and one shared use needs no new token.
		tag: "bg-[rgba(var(--overlay-rgb),0.05)] text-text-dimmer",
	};

	// `xs` and `sm` size by padding, which is what six of the seven sites did.
	// `count` is the odd one out and stays height-driven: the client-count
	// bubble must stay a circle whatever digit is in it, and only an explicit
	// box guarantees that. 18px is literal rather than h-6 because the bubble
	// is a circle paired with rounded-[9px], and the pair must not drift apart.
	const SIZE_CLASSES: Record<BadgeSize, string> = {
		xs: "px-1.5 py-0.5 text-xs font-medium",
		sm: "px-2 py-0.5 text-sm font-medium",
		// font-semibold rather than the others' font-medium: this is a 10px
		// digit on a solid accent fill, and the extra weight is what keeps it
		// readable. Weight lives here, not in BASE_CLASSES, so that exactly one
		// weight class is ever emitted -- two would leave the winner up to
		// Tailwind's emission order rather than this file.
		count: "min-w-[18px] h-[18px] px-[5px] text-xs font-semibold leading-none justify-center",
	};

	// Two shapes, not three. A rounded-panel (10px) radius on an
	// ~18px-tall chip already clamps to a capsule, so it and rounded-full are
	// the same rendering and collapse into one name.
	const SHAPE_CLASSES: Record<BadgeShape, string> = {
		rounded: "rounded",
		pill: "rounded-full",
	};

	// No line-height here on purpose. Five of the seven sites inherited the
	// text size's own line-height and Badge v1's leading-none shaved 5px off
	// every tag chip -- a real tightening dressed up as a migration. Only
	// `count` pins it, where the box height makes it moot anyway.
	const BASE_CLASSES =
		"inline-flex items-center gap-1 whitespace-nowrap shrink-0";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type BadgeProps = {
		variant?: BadgeVariant;
		size?: BadgeSize;
		shape?: BadgeShape;
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLSpanElement>, "class">;

	let {
		variant = "neutral",
		size = "xs",
		shape = "rounded",
		class: className,
		children,
		...rest
	}: BadgeProps = $props();

	const badgeClass = $derived(
		[
			BASE_CLASSES,
			VARIANT_CLASSES[variant],
			SIZE_CLASSES[size],
			SHAPE_CLASSES[shape],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<span {...rest} class={badgeClass}>{@render children()}</span>
