<!--
  Button — the primitive action control (components/ui exemplar).

  Variant + size are selected from typed maps of plain Tailwind token classes
  (no clsx/tailwind-merge dependency; consistent with ToggleSetting.svelte). The
  consumer `class` is appended for ADDITIVE utilities (layout/spacing); it does
  NOT reliably override a variant/size utility — see ./component-conventions.mdx.

  Strictly renders a <button>; link-styled buttons are out of scope by design.
-->
<script module lang="ts">
	type ButtonVariant =
		| "primary"
		| "secondary"
		| "ghost"
		| "ghost-accent"
		| "danger";
	type ButtonSize = "sm" | "md";

	const VARIANT_CLASSES: Record<ButtonVariant, string> = {
		primary: "bg-accent text-white hover:bg-accent-hover",
		secondary: "border border-border text-text hover:bg-text/10",
		ghost: "text-text-secondary hover:bg-text/10 hover:text-text",
		"ghost-accent": "text-accent hover:bg-accent/10",
		danger: "bg-error text-white hover:bg-error/90",
	};

	// `focus-visible:outline-hidden` (not `outline-none`) keeps a transparent
	// outline that forced-colors mode renders visibly, so the focus indicator
	// survives when the box-shadow ring is stripped.
	const BASE_CLASSES =
		"inline-flex items-center justify-center font-medium rounded-lg whitespace-nowrap " +
		"select-none cursor-pointer transition-colors " +
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 " +
		"disabled:opacity-50 disabled:cursor-not-allowed " +
		"aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
</script>

<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";
	import Icon from "../shared/Icon.svelte";

	type ButtonOwnProps = {
		variant?: ButtonVariant;
		size?: ButtonSize;
		type?: "button" | "submit" | "reset";
		/** Leading lucide icon name (see Icon.svelte). */
		icon?: string;
		/** Spinner + `aria-busy`; stays focusable and swallows clicks. */
		loading?: boolean;
		disabled?: boolean;
		onclick?: HTMLButtonAttributes["onclick"];
		class?: string;
		children?: Snippet;
	} & Omit<
		HTMLButtonAttributes,
		| "class"
		| "type"
		| "disabled"
		| "onclick"
		| "aria-label"
		| "aria-busy"
		| "aria-disabled"
	>;

	// Icon-only buttons must carry an accessible name — enforced at compile time.
	type ButtonProps = ButtonOwnProps &
		(
			| { iconOnly: true; ariaLabel: string }
			| { iconOnly?: false; ariaLabel?: string }
		);

	let {
		variant = "secondary",
		size = "md",
		type = "button",
		icon,
		iconOnly = false,
		loading = false,
		disabled = false,
		ariaLabel,
		onclick,
		class: className,
		children,
		...rest
	}: ButtonProps = $props();

	const sizeClasses = $derived(
		iconOnly
			? size === "sm"
				? "h-8 w-8"
				: "h-9 w-9"
			: size === "sm"
				? "h-8 px-3 text-xs gap-1.5"
				: "h-9 px-4 text-sm gap-2",
	);

	const buttonClass = $derived(
		[BASE_CLASSES, VARIANT_CLASSES[variant], sizeClasses, className]
			.filter(Boolean)
			.join(" "),
	);

	const iconSize = $derived(size === "sm" ? 14 : 16);

	// `loading` is a soft-disable: the button stays focusable (so keyboard/SR
	// context is not lost mid-action), so the handler must guard it explicitly.
	const handleClick: NonNullable<HTMLButtonAttributes["onclick"]> = (event) => {
		if (disabled || loading) return;
		onclick?.(event);
	};

	if (import.meta.env.DEV) {
		$effect(() => {
			if (iconOnly && !ariaLabel?.trim()) {
				console.warn(
					"[ui/Button] `iconOnly` buttons require an `ariaLabel` for screen readers.",
				);
			}
		});
	}
</script>

<button
	{...rest}
	{type}
	class={buttonClass}
	{disabled}
	aria-disabled={loading || undefined}
	aria-busy={loading || undefined}
	aria-label={ariaLabel}
	onclick={handleClick}
>
	{#if loading}
		<Icon name="loader-circle" size={iconSize} class="animate-spin" />
	{:else if icon}
		<Icon name={icon} size={iconSize} />
	{/if}
	{#if !iconOnly}
		{@render children?.()}
	{/if}
</button>
