<!--
  TextButton — a button whose entire affordance is a colour step on hover.

  No box: no background, no border, no padding, no radius. The eleven sites this
  replaces (conduit-test-de3.35.9.1) had each hand-written the same three ideas —
  "it is clickable", "it is dimmer than body text", "it brightens under the
  cursor" — and agreed on all three. What they disagreed about was everything
  structural, which is why almost nothing lives in BASE_CLASSES here.

  Why this is NOT a Button variant: every Button variant that sets a neutral text
  colour also sets a hover background, and a consumer `class` can only ADD
  utilities, never subtract one. The empty-fill column was unreachable from
  Button by construction, not by omission (conduit-test-de3.35.9.2).

  BASE is deliberately almost empty, and each absence was measured rather than
  assumed:

  - No `p-0` / `border-none` / `bg-transparent`. Tailwind v4 preflight already
    emits `*,::before,::after{border:0 solid;margin:0;padding:0}` and
    `button{background-color:transparent}`, so all three were pure noise in the
    as-found strings. Leaving padding unclaimed also means a call site can pass
    `px-1 py-0.5` with nothing to collide against.
  - No `display`. Only one of the eleven wanted flex; the rest are happy as the
    default inline-block. Emitting one here would put BASE in the display group
    and force that site to fight it — the exact trap `align` was created to
    remove (conduit-test-ixfu).
  - No `transition`. Five sites animate the hover, five do not, and one animates
    opacity instead. That is a real inconsistency, but it is a taste call, so it
    stays visible at the call site rather than being decided by a refactor.

  The focus ring IS new, and is the point of the ticket rather than a side
  effect: not one of the eleven had any focus indicator, so eleven keyboard-
  reachable controls were invisible when focused. Nothing moves at rest, so it
  costs no baseline.
-->
<script module lang="ts">
	/**
	 * Resting tone paired with its hover step. Both halves live in one string
	 * because they are one decision: "dim, brightening to full" is the
	 * affordance, and splitting it across two props would let a call site
	 * assemble a pairing nobody designed.
	 *
	 * Three deliberate omissions, all of them as-found strings whose hover step
	 * makes the control LESS prominent, which is almost certainly a bug rather
	 * than an intent worth preserving:
	 *
	 *   chat/ForkDivider.svelte:24   muted -> secondary
	 *   setup/StepPwa.svelte:213     muted -> dimmer
	 *   chat/SystemMessage.svelte:53 opacity-60 -> opacity-100 (no colour at all)
	 *
	 * They are left alone here so this migration stays zero-diff; fixing them is
	 * a visible change and belongs in its own ticket.
	 */
	const TONE_CLASSES = {
		muted: { rest: "text-text-muted", hover: "hover:text-text" },
		dimmer: { rest: "text-text-dimmer", hover: "hover:text-text" },
		accent: { rest: "text-accent", hover: "hover:text-accent/80" },
	} as const;

	const UNDERLINE_CLASSES = {
		none: "",
		hover: "hover:underline",
		always: "underline",
	} as const;

	// `focus-visible` only, and neutral rather than accent, matching Button —
	// see its BASE_CLASSES for why `ring-text` and not `ring-accent`.
	const BASE_CLASSES =
		"cursor-pointer " +
		"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text " +
		"disabled:opacity-50 disabled:cursor-not-allowed";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";

	type TextButtonTone = keyof typeof TONE_CLASSES;

	let {
		tone = "muted",
		underline = "none",
		disabled = false,
		type = "button",
		class: className,
		children,
		...rest
	}: {
		/** Resting colour and its hover step. See TONE_CLASSES. */
		tone?: TextButtonTone;
		/** `always` for link-like text, `hover` for a reveal-on-hover affordance. */
		underline?: keyof typeof UNDERLINE_CLASSES;
		disabled?: boolean;
		type?: "button" | "submit" | "reset";
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	} = $props();

	// The hover step is dropped rather than overridden when disabled. A CSS-only
	// fix would need a second utility in the same group, and the one that wins is
	// decided by stylesheet order — the failure mode conduit-test-or29 was filed
	// for, where disabled buttons still lit up under the cursor.
	const buttonClass = $derived(
		[
			BASE_CLASSES,
			TONE_CLASSES[tone].rest,
			disabled ? "" : TONE_CLASSES[tone].hover,
			UNDERLINE_CLASSES[underline],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<button {type} {disabled} class={buttonClass} {...rest}>
	{@render children()}
</button>
