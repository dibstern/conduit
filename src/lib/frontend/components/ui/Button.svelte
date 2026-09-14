<!--
  Button — the primitive action control (components/ui exemplar).

  Variant + size are selected from typed maps of plain Tailwind token classes
  (no clsx/tailwind-merge dependency; consistent with Toggle.svelte). The
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
		| "danger"
		| "success-soft"
		| "danger-outline"
		| "accent-soft";

	/**
	 * `content` is an opt-out, not a third size: it emits no padding, radius,
	 * weight or type scale, so the call site supplies its own ADDITIVELY via
	 * `class`. It exists because the de3.5 audit found 64 of 81 migration
	 * candidates need intrinsic height — `sm`/`md` hard-code `h-8`/`h-9`, and
	 * a call site cannot reliably override that (see component-conventions.mdx:
	 * consumer `class` is additive; beating a size utility needs `h-auto!`).
	 * Without this, migrating the codebase onto Button means 64 `!` overrides.
	 */
	type ButtonSize = "sm" | "md" | "content";

	const VARIANT_CLASSES: Record<ButtonVariant, string> = {
		primary: "bg-accent text-white hover:bg-accent-hover",
		secondary: "border border-border text-text hover:bg-text/10",
		ghost: "text-text-secondary hover:bg-text/10 hover:text-text",
		"ghost-accent": "text-accent hover:bg-accent/10",
		danger: "bg-error text-white hover:bg-error/90",
		// The three below are the approve / deny / tool-action language already
		// duplicated across QuestionCard, PermissionCard, ToolGenericCard and
		// ToolGroupItem. Added on cross-file evidence only; single-file recipes
		// (e.g. Header's toolbar buttons) deliberately stay local.
		"success-soft":
			"border border-success/20 bg-success/10 text-success hover:bg-success/15",
		"danger-outline":
			"border border-border bg-transparent text-error hover:bg-error/[0.08]",
		"accent-soft": "text-accent bg-accent/10 hover:bg-accent/20",
	};

	// `focus-visible:outline-hidden` (not `outline-none`) keeps a transparent
	// outline that forced-colors mode renders visibly, so the focus indicator
	// survives when the box-shadow ring is stripped.
	//
	// `rounded-lg` and `font-medium` live in the size map rather than here: two
	// utilities setting the same property collide on stylesheet order, not class
	// order, so a size (or a consumer) could not override a base radius without
	// `!`. Anything in BASE is therefore genuinely invariant.
	const BASE_CLASSES =
		"inline-flex items-center justify-center whitespace-nowrap " +
		"select-none cursor-pointer transition-colors " +
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent/70 " +
		"disabled:opacity-50 disabled:cursor-not-allowed " +
		"aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";

	const SHARED_SIZE_CLASSES = "rounded-lg font-medium";
</script>

<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

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
	} & Omit<
		HTMLButtonAttributes,
		| "class"
		| "type"
		| "disabled"
		| "onclick"
		| "aria-label"
		| "aria-busy"
		| "aria-disabled"
		// `children` is omitted here so the union below is its SOLE declaration.
		// HTMLButtonAttributes already declares `children?: Snippet`, and an
		// intersection of that with the icon-only branch's `children?: undefined`
		// is `never` — which rejects even an explicit `children: undefined`, the
		// one spelling a story needs to clear an inherited meta arg.
		| "children"
	>;

	/**
	 * Two compile-time guarantees:
	 *
	 * 1. Icon-only buttons carry an accessible name.
	 * 2. Icon-only buttons cannot be given children. This used to be enforced at
	 *    RENDER time by an `{#if !iconOnly}` guard, which silently discarded
	 *    them: `<Button iconOnly><Icon name="x" /></Button>` produced a
	 *    completely empty button with no warning. That is what made Modal's
	 *    close control invisible in every committed visual baseline, and it was
	 *    invisible to the baselines too — hiding an invisible button and showing
	 *    it produce the same frame. See conduit-test-arl1.
	 *
	 * Spelled `children?: undefined` rather than `?: never`: under
	 * `exactOptionalPropertyTypes` a `never` property rejects even an EXPLICIT
	 * `children: undefined`, which is precisely how a story clears an inherited
	 * meta-level default (see Button.stories.ts::IconOnly). `undefined` forbids a
	 * Snippet just as firmly while still permitting the explicit clear.
	 *
	 * It sits on the branch rather than intersected with the base props so the
	 * error names `children` instead of resolving to an unreadable `Snippet & never`.
	 */
	type ButtonProps = ButtonOwnProps &
		(
			| { iconOnly: true; ariaLabel: string; children?: undefined }
			| { iconOnly?: false; ariaLabel?: string; children?: Snippet }
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

	const sizeClasses = $derived.by(() => {
		// Literally no classes, by design — see the ButtonSize doc comment. Not
		// even `h-auto`: that is a button's default height anyway, so emitting it
		// buys nothing and costs a `!` at every call site that wants an explicit
		// height (RewindBanner's `w-6 h-6` exit control, for one), which is the
		// exact tax this size exists to avoid.
		if (size === "content") return "";
		if (iconOnly) {
			return `${size === "sm" ? "h-8 w-8" : "h-9 w-9"} ${SHARED_SIZE_CLASSES}`;
		}
		return `${
			size === "sm" ? "h-8 px-3 text-xs gap-1.5" : "h-9 px-4 text-sm gap-2"
		} ${SHARED_SIZE_CLASSES}`;
	});

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
	<!-- Rendered unconditionally: `iconOnly` now forbids children in the type, so
	     the old `{#if !iconOnly}` guard could only ever fire for a caller that
	     had already bypassed the compiler — and silently swallowing its content
	     is the worse of the two failures. See conduit-test-arl1. -->
	{@render children?.()}
</button>
