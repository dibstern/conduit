<!--
  Button — the primitive action control (components/ui exemplar).

  Variant + size are selected from typed maps of plain Tailwind token classes
  (no clsx/tailwind-merge dependency; consistent with Toggle.svelte). The
  consumer `class` is appended for ADDITIVE utilities (layout/spacing); it does
  NOT reliably override a variant/size utility — see ./component-conventions.mdx.

  Renders a <button>, or an <a> when `href` is set. The anchor branch exists
  because "link-styled buttons are out of scope" did not stop anyone needing
  one: it just moved the recipe into feature components, where four <a> tags
  ended up hand-copying `bg-accent text-bg ...` (conduit-test-75iq). The shape
  mirrors ui/MenuItem.svelte, which has resolved the same question the same way
  since conduit-test-de3.3.4 -- one idiom for "styled control that is sometimes
  a link", not two.
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

	// `text-bg`, not `text-white`, on the two filled variants. In the dark theme
	// (the default) the accent and error fills are both light pinks, so a white
	// label on either measures 2.56:1 — under AA's 3:1 large-text floor, on the
	// app's most prominent call to action. `text-bg` measures 6.93:1 dark and
	// 5.60:1 light, so it passes in BOTH themes where white passes in only one
	// (conduit-test-tpdw).
	const VARIANT_CLASSES: Record<ButtonVariant, string> = {
		primary: "bg-accent text-bg hover:bg-accent-hover",
		secondary: "border border-border text-text hover:bg-text/10",
		ghost: "text-text-secondary hover:bg-text/10 hover:text-text",
		"ghost-accent": "text-accent hover:bg-accent/10",
		danger: "bg-error text-bg hover:bg-error/90",
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
		"inline-flex items-center justify-center whitespace-nowrap no-underline " +
		"select-none cursor-pointer transition-colors " +
		// Neutral, not accent. An accent ring against an accent-filled button
		// (`primary`) is the same colour as the button, so the old
		// `ring-accent/70` was invisible on the one variant that most needed it.
		// `ring-text` contrasts with every surface in both themes. Keyboard only:
		// `focus-visible` never fires on a mouse click. See conduit-test-de3.19.
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text " +
		"disabled:opacity-50 disabled:cursor-not-allowed " +
		"aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";

	const SHARED_SIZE_CLASSES = "rounded-lg font-medium";
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
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
		/**
		 * Renders an <a> instead of a <button>, wearing the same variant/size.
		 *
		 * Deliberately a plain optional prop rather than a discriminated union
		 * forbidding `type`/`disabled`, which is what ui/MenuItem.svelte does
		 * and what this file tried first. It does not survive here: `iconOnly`
		 * is ALREADY a union, and intersecting a second two-branch union with
		 * it over a base as wide as `HTMLButtonAttributes` makes tsc give up
		 * with "Expression produces a union type that is too complex to
		 * represent" at the call sites that spread meta args (Button.stories.ts).
		 * MenuItem gets away with it because its base type is small.
		 *
		 * So the `href` + `type`/`disabled` conflict is caught by the DEV
		 * warning below instead — the same mechanism this file already uses for
		 * `iconOnly` without an `ariaLabel`, for the same reason.
		 */
		href?: string;
		target?: HTMLAnchorAttributes["target"];
		rel?: HTMLAnchorAttributes["rel"];
		download?: HTMLAnchorAttributes["download"];
		onclick?: (event: MouseEvent) => void;
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
		href,
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
	/**
	 * `rest` is typed against `HTMLButtonAttributes`, so every element-generic
	 * event handler it carries is parameterised on `HTMLButtonElement`. Spread
	 * onto an <a> those are structurally wrong even though no caller can
	 * actually hit it — you cannot pass `onsubmit` to a Button and also read it
	 * back off the anchor. Narrowing the props type per branch to make this
	 * precise is exactly what exceeded tsc's union budget (see `href` above), so
	 * this is the one place the two shapes are reconciled by hand.
	 */
	const anchorRest = $derived(rest as unknown as HTMLAnchorAttributes);

	const handleClick = (event: MouseEvent) => {
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
			// A <a> has no `disabled` and no `type`. Silently dropping either is
			// how "this link ignores its disabled state" ships unnoticed.
			if (href !== undefined && disabled) {
				console.warn(
					"[ui/Button] `disabled` has no effect with `href` — an anchor cannot be disabled. Render a real <button>, or omit the href while the action is unavailable.",
				);
			}
		});
	}
</script>

{#snippet content()}
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
{/snippet}

{#if href !== undefined}
	<!-- `{#if}` rather than <svelte:element>, matching ui/MenuItem.svelte. It
	     also keeps the two attribute sets honestly separate: an <a> takes no
	     `type` and no `disabled`, so there is nothing here to conditionally
	     suppress. -->
	<a
		{...anchorRest}
		{href}
		class={buttonClass}
		aria-disabled={loading || undefined}
		aria-busy={loading || undefined}
		aria-label={ariaLabel}
		onclick={handleClick}
	>
		{@render content()}
	</a>
{:else}
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
		{@render content()}
	</button>
{/if}
