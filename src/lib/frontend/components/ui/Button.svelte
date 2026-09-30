<!--
  Button — the primitive action control (components/ui exemplar).

  Variant + size are selected from typed maps of plain Tailwind token classes
  (no clsx/tailwind-merge dependency; consistent with Toggle.svelte). The
  consumer `class` is appended for ADDITIVE utilities (layout/spacing); it does
  NOT reliably override a variant/size utility — see ./component-conventions.mdx.

  Renders a <button>, or an <a> when `href` is set. The anchor branch exists
  because "link-styled buttons are out of scope" did not stop anyone needing
  one: it just moved the recipe into feature components, where four <a> tags
  ended up hand-copying `bg-accent text-bg ...`. The shape
  mirrors ui/MenuItem.svelte, which has resolved the same question the same way
  — one idiom for "styled control that is sometimes
  a link", not two.
-->
<script lang="ts">
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";
	import {
		buttonClasses,
		type ButtonAlign,
		type ButtonDisabledStyle,
		type ButtonHoverFill,
		type ButtonLayout,
		type ButtonSize,
		type ButtonTone,
		type ButtonVariant,
	} from "./button-recipes.js";

	type ButtonOwnProps = {
		variant?: ButtonVariant;
		size?: ButtonSize;
		/**
		 * Main-axis alignment. Only matters when the button is wider than its
		 * content -- a fixed icon box, `w-full`, `flex-1`, or a stretched child
		 * of a column flex/grid parent. See ALIGN_CLASSES.
		 */
		align?: ButtonAlign;
		/** See LAYOUT_CLASSES. */
		layout?: ButtonLayout;
		/**
		 * Resting label colour and its hover step, REPLACING the variant's.
		 * Omit to keep the variant's own. See TONE_CLASSES.
		 */
		tone?: ButtonTone;
		/**
		 * Hover background wash, REPLACING the variant's. Omit to keep the
		 * variant's own; pass `"none"` to remove it entirely. See
		 * HOVER_FILL_CLASSES.
		 */
		hoverFill?: ButtonHoverFill;
		/**
		 * How the button looks when it is off. REPLACES the default pair rather
		 * than adding to it, so there is never more than one `opacity` and one
		 * `cursor` in the disabled state. See DISABLED_CLASSES.
		 */
		disabledStyle?: ButtonDisabledStyle;
		type?: "button" | "submit" | "reset";
		/** Leading lucide icon name (see Icon.svelte). */
		icon?: string;
		/**
		 * Glyph px, overriding the size-derived default (14 for `sm`, 16 for the
		 * rest). `size="content"` emits no geometry by design, so without this a
		 * call site that supplies its own box has no way to scale the glyph to
		 * match -- it silently gets the 16px default. That cost SessionList a
		 * 2px-too-large icon in four toolbar buttons.
		 */
		iconSize?: number;
		/** Spinner + `aria-busy`; stays focusable and swallows clicks. */
		loading?: boolean;
		disabled?: boolean;
		/**
		 * Soft-disable: announced as unavailable and swallows clicks, but stays
		 * focusable AND still fires pointer events.
		 *
		 * `disabled` is right when a control is simply off. This one is for a
		 * control that has to stay hoverable in order to EXPLAIN why it is off:
		 * InstanceModelPicker's rail dims every instance the current session is
		 * not bound to, and a hover tooltip is the only place that says so. A
		 * real `disabled` button fires no `mouseenter`, so the explanation would
		 * be unreachable exactly when it is needed.
		 *
		 * Not reachable through `rest`: `aria-disabled` is omitted from the base
		 * attributes below because the primitive owns that attribute, and a
		 * spread value would be clobbered by `loading`'s.
		 */
		ariaDisabled?: boolean;
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
		/**
		 * Svelte 5 does not let `bind:this` reach through a component tag, so a
		 * caller that needs the real element (session/SessionItem anchors its
		 * overflow menu off `getBoundingClientRect`) has no way to ask for it
		 * unless the primitive hands it back. Typed as the union rather than made
		 * generic: both branches answer `getBoundingClientRect` and `focus`, which
		 * is the whole reason anyone reaches for this, and a type parameter would
		 * tax every call site to serve none of them.
		 */
		element?: HTMLButtonElement | HTMLAnchorElement | undefined;
		/**
		 * Paint at the designed size, take the tap at 44px on phones: a
		 * transparent ::before, centred, at least 44x44 below `md`. Growing the
		 * control itself turns a rounded-full pill into a tall empty lozenge.
		 * Literal px because the root font-size is 12px.
		 * Adds `relative`, so not for a control that is itself positioned.
		 */
		touchTarget?: boolean;
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
	 *    it produce the same frame.
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
		align = "center",
		layout = "center",
		tone,
		hoverFill,
		disabledStyle = "dim",
		href,
		type = "button",
		icon,
	iconSize: iconSizeProp,
		iconOnly = false,
		loading = false,
		disabled = false,
		ariaDisabled = false,
		ariaLabel,
		onclick,
		element = $bindable(),
		touchTarget = false,
		class: className,
		children,
		...rest
	}: ButtonProps = $props();

	const inert = $derived(disabled || loading || ariaDisabled);
	const buttonClass = $derived(
		buttonClasses({
			variant,
			tone,
			hoverFill,
			disabledStyle,
			layout,
			align,
			size,
			iconOnly,
			touchTarget,
			inert,
			className,
		}),
	);

	const iconSize = $derived(iconSizeProp ?? (size === "sm" ? 14 : 16));

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
		if (inert) return;
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
	     is the worse of the two failures. -->
	{@render children?.()}
{/snippet}

{#if href !== undefined}
	<!-- `{#if}` rather than <svelte:element>, matching ui/MenuItem.svelte. It
	     also keeps the two attribute sets honestly separate: an <a> takes no
	     `type` and no `disabled`, so there is nothing here to conditionally
	     suppress. -->
	<a
		bind:this={element}
		{...anchorRest}
		{href}
		class={buttonClass}
		aria-disabled={loading || ariaDisabled || undefined}
		aria-busy={loading || undefined}
		aria-label={ariaLabel}
		onclick={handleClick}
	>
		{@render content()}
	</a>
{:else}
	<button
		bind:this={element}
		{...rest}
		{type}
		class={buttonClass}
		{disabled}
		aria-disabled={loading || ariaDisabled || undefined}
		aria-busy={loading || undefined}
		aria-label={ariaLabel}
		onclick={handleClick}
	>
		{@render content()}
	</button>
{/if}
