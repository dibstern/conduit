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
	import {
		HOVER_FILL_CLASSES,
		DISABLED_CLASSES,
		TONE_CLASSES,
		VARIANT_RECIPES,
		type ButtonDisabledStyle,
		type ButtonHoverFill,
		type ButtonTone,
		type ButtonVariant,
	} from "./button-recipes.js";

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

	type ButtonAlign = keyof typeof ALIGN_CLASSES;

	// `focus-visible:outline-hidden` (not `outline-none`) keeps a transparent
	// outline that forced-colors mode renders visibly, so the focus indicator
	// survives when the box-shadow ring is stripped.
	//
	// `rounded-lg` and `font-medium` live in the size map rather than here: two
	// utilities setting the same property collide on stylesheet order, not class
	// order, so a size (or a consumer) could not override a base radius without
	// `!`. Anything in BASE is therefore genuinely invariant.
	//
	// `justify-*` is not here either, for the same reason, but it could not just
	// move to the size map: unlike radius, a `content`-sized button still needs
	// SOME alignment, and every fixed-size icon box in the app was relying on
	// the base one. It became `align` instead — see ALIGN_CLASSES below.
	//
	// The disabled appearance left for the same reason and by the same route:
	// nine controls dissented on how far a dead button should dim, and none of
	// them could win against a BASE utility. It is now `disabledStyle` — see
	// DISABLED_CLASSES in button-recipes.ts (conduit-test-8lxm).
	const BASE_CLASSES =
		"inline-flex items-center whitespace-nowrap no-underline " +
		"select-none cursor-pointer transition-colors " +
		// Neutral, not accent. An accent ring against an accent-filled button
		// (`primary`) is the same colour as the button, so the old
		// `ring-accent/70` was invisible on the one variant that most needed it.
		// `ring-text` contrasts with every surface in both themes. Keyboard only:
		// `focus-visible` never fires on a mouse click. See conduit-test-de3.19.
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text";

	const SHARED_SIZE_CLASSES = "rounded-lg font-medium";

	/**
	 * Main-axis alignment, as a prop rather than a base class, because the base
	 * class was a coin flip nobody could see (conduit-test-ixfu).
	 *
	 * BASE_CLASSES used to hard-code `justify-center`, so a call site wanting
	 * something else had to append a competing utility and hope. Whether it won
	 * depended on Tailwind's emission order, which is not alphabetical across
	 * groups: `justify-start` is emitted AFTER `justify-center` and wins,
	 * `justify-between` is emitted BEFORE it and silently loses. Identical-
	 * looking call sites, opposite outcomes, and the only way to tell was to
	 * probe byte offsets in the built stylesheet.
	 *
	 * Exactly one of these is ever emitted, so there is no collision to resolve
	 * and no order to know. `center` is the default, which is what BASE already
	 * did, so every existing call site is unchanged to the pixel.
	 *
	 * This matters well beyond tidiness: an audit of the 79 native controls
	 * still outside the design system found 34 of them are `w-full text-left`
	 * rows. No Button VARIANT could ever have reached them — a variant appends,
	 * and BASE had already emitted the conflict — so the largest single group in
	 * the migration backlog was unreachable until this moved.
	 */
	const ALIGN_CLASSES = {
		center: "justify-center",
		start: "justify-start",
		between: "justify-between",
	} as const;
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";
	import Icon from "./Icon.svelte";

	type ButtonOwnProps = {
		variant?: ButtonVariant;
		size?: ButtonSize;
		/**
		 * Main-axis alignment. Only matters when the button is wider than its
		 * content -- a fixed icon box, `w-full`, `flex-1`, or a stretched child
		 * of a column flex/grid parent. See ALIGN_CLASSES.
		 */
		align?: ButtonAlign;
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
		 * 2px-too-large icon in four toolbar buttons (conduit-test-de3.35.3).
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
		 * be unreachable exactly when it is needed (conduit-test-de3.35.6).
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
		align = "center",
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

	/**
	 * Nearly every variant declares a `hover:bg-*`, and `:hover` keeps matching while a
	 * button is disabled, so until conduit-test-or29 a dead button still lit up
	 * under the cursor -- in every variant, everywhere in the app. It read as
	 * interactive at the exact moment it is not.
	 *
	 * Dropped in JS rather than fixed in CSS because the primitive already knows.
	 * The two CSS routes both cost something: `disabled:pointer-events-none`
	 * takes `cursor-not-allowed` with it (no pointer events, no cursor style),
	 * and chaining `not-disabled:not-aria-disabled:hover:` across eleven variants
	 * writes the inert condition a second time, in a second language, where it
	 * can drift from the one `handleClick` already guards on. This reuses that
	 * single flag.
	 *
	 * The recipe strings above stay literal, so Tailwind's scanner still emits
	 * every hover class it always did; only whether they are APPLIED is dynamic.
	 * That holds for the `tone` / `hoverFill` unions too -- the utilities live
	 * as literals in TONE_CLASSES and HOVER_FILL_CLASSES, which the scanner
	 * reads, so a wash keeps being emitted after the last hand-written call
	 * site that spelled it out is migrated away.
	 *
	 * Scope is the variant. A consumer `class` that brings its own `hover:` is
	 * left alone -- it is the call site's string, and silently editing a
	 * prop we were handed is a worse surprise than the one being fixed.
	 */
	const inert = $derived(disabled || loading || ariaDisabled);
	const variantClass = $derived.by(() => {
		const recipe = VARIANT_RECIPES[variant];
		const assembled = [
			recipe.chrome,
			tone === undefined ? recipe.tone : TONE_CLASSES[tone],
			hoverFill === undefined
				? recipe.hoverFill
				: HOVER_FILL_CLASSES[hoverFill],
		]
			.filter(Boolean)
			.join(" ");
		return inert
			? assembled
					.split(" ")
					.filter((cls) => !cls.startsWith("hover:"))
					.join(" ")
			: assembled;
	});

	const buttonClass = $derived(
		[
			BASE_CLASSES,
			DISABLED_CLASSES[disabledStyle],
			ALIGN_CLASSES[align],
			variantClass,
			sizeClasses,
			className,
		]
			.filter(Boolean)
			.join(" "),
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
		if (disabled || loading || ariaDisabled) return;
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
		aria-disabled={loading || ariaDisabled || undefined}
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
		aria-disabled={loading || ariaDisabled || undefined}
		aria-busy={loading || undefined}
		aria-label={ariaLabel}
		onclick={handleClick}
	>
		{@render content()}
	</button>
{/if}
