<!--
  Surface — the structural <div> shell behind the app's panels, cards and insets.

  Sixty-nine containers across twenty-eight files were inventoried for
  conduit-test-6hr2 before a single value here was chosen. Every map entry below
  is backed by two or more of them; every as-found value that is NOT here was
  rejected on purpose and recorded in that ticket as site drift for the batch
  tickets to normalize. Nothing in this file is a guess about what a panel
  "should" look like.

  Two findings shaped the prop surface more than anything else:

  1. There is no padding scale in this app. Twenty-two distinct px/py pairings
     across sixty-nine containers. `padding` therefore stays a three-step scale
     that fifteen sites already sit on, and defaults to `none` — see the note on
     PADDING_CLASSES.
  2. A hard-coded radius is split behaviour, not a default. Tailwind emits
     radii alphabetically, so a call-site `rounded-lg` silently LOSES to this
     file's `rounded-panel` while `rounded-xl` silently WINS. Same API, opposite
     result, no error either way. Radius is a prop, and `radius="none"` is how a
     call site takes ownership of it.

  Explicitly not Surface: interactive card-shaped <label>/<button>/<a> controls,
  InputArea's composite form shell, paste thumbnails or QR backings, PlanMode's
  CSS collapse contract, or DebugPanel's deliberately exceptional styling.
-->
<script module lang="ts">
	type SurfaceVariant =
		| "card"
		| "quiet"
		| "plain"
		| "bare"
		| "raised"
		| "inset";
	type SurfacePadding = "none" | "sm" | "md" | "lg";
	type SurfaceRadius = "none" | "sm" | "md" | "lg" | "panel";
	type SurfaceElevation =
		| "none"
		| "menu"
		| "menu-lg"
		| "panel"
		| "modal"
		| "dropdown";

	// Counts are inventoried candidate sites (conduit-test-6hr2).
	//
	// `raised` was called `floating` and is renamed here: it is the largest
	// group at nineteen sites and roughly half of them are static (the setup
	// steps, PastePreview, the callout banners). It names the TONE — one step
	// lifted off the page background — not a shadow and not a position. Shadow
	// is `elevation`, which is deliberately independent.
	//
	// `bare` exists because four grouped tool shells drop their background
	// entirely mid-group. That is a runtime-switchable state, so it is a
	// variant rather than a boolean: `variant={grouped ? "bare" : "plain"}`.
	const VARIANT_CLASSES: Record<SurfaceVariant, string> = {
		card: "bg-bg-surface border border-border", // 8
		quiet: "bg-bg-surface border border-border-subtle", // 2
		plain: "bg-bg-surface", // 8
		bare: "", // 5
		raised: "bg-bg-alt border border-border", // 19
		inset: "bg-code-bg border border-border-subtle", // 6
	};

	// Three steps, not twenty-two, and the default is `none`.
	//
	// The inventory found no scale to extend: twenty-two distinct pairings, the
	// top one used seven times. Naming all of them would encode the drift as
	// API, which is the failure this primitive exists to prevent; naming five of
	// them would look like a scale while still missing most sites. So these are
	// the three coherent steps fifteen sites already sit on, and they are the
	// destination for the convergence work tracked in conduit-test-6hr2.
	//
	// Defaulting to `none` is the load-bearing half. A default that emits
	// padding means every migration that forgets the prop both changes the
	// rendering AND collides with whatever the call site passes. Emitting
	// nothing makes an off-scale site's own `px-2.5 py-1.5` the sole owner —
	// not an override, because there is nothing to override.
	const PADDING_CLASSES: Record<SurfacePadding, string> = {
		none: "",
		sm: "px-3 py-2", // 5
		md: "px-4 py-3", // 7
		lg: "px-5 py-4", // 3
	};

	// `panel` (--radius-panel, 10px) and `lg` (rounded-xl, 9px) are one pixel
	// apart and that is drift, not design. Both are kept so the batches stay
	// zero-diff; collapsing them is tracked separately.
	//
	// `none` is not a filler value. It is how the grouped tool shells pass a
	// computed `rounded-t-[10px]` / `rounded-b-[10px]`, how DiffView flips
	// between `rounded-lg` and `rounded-b-lg`, and how the two genuine one-offs
	// (rounded-[14px], rounded-3xl) survive without this file arbitrating them.
	const RADIUS_CLASSES: Record<SurfaceRadius, string> = {
		none: "", // 11
		sm: "rounded", // 4
		md: "rounded-lg", // 24
		lg: "rounded-xl", // 7
		panel: "rounded-panel", // 21
	};

	// Every shadow token declared in style.css, and nothing else.
	//
	// `menu-lg` and `dropdown` let menu shells and the sidebar projects panel
	// use the shipped shadow tokens without class overrides.
	//
	// Deliberately absent: shadow-2xl (3), shadow-lg (2), shadow-xl (1). Those
	// are raw Tailwind defaults, visibly unlike the token set, and mapping them
	// would launder drift into the design system. Those sites pass
	// `elevation="none"` and keep their class until a separate, explicitly
	// non-zero-diff ticket converges them.
	const ELEVATION_CLASSES: Record<SurfaceElevation, string> = {
		none: "", // 50
		menu: "shadow-menu", // 1
		"menu-lg": "shadow-menu-lg", // 3
		panel: "shadow-panel", // 5
		modal: "shadow-modal", // 2
		dropdown: "shadow-dropdown", // 1
	};
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type SurfaceProps = {
		variant?: SurfaceVariant;
		padding?: SurfacePadding;
		radius?: SurfaceRadius;
		elevation?: SurfaceElevation;
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "class">;

	let {
		variant = "card",
		padding = "none",
		radius = "panel",
		elevation = "none",
		class: className,
		children,
		...rest
	}: SurfaceProps = $props();

	const surfaceClass = $derived(
		[
			VARIANT_CLASSES[variant],
			PADDING_CLASSES[padding],
			RADIUS_CLASSES[radius],
			ELEVATION_CLASSES[elevation],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);

	if (import.meta.env.DEV) {
		// Surface composes four Tailwind groups at once, which makes it the most
		// exposed primitive in the system to the one hazard that has now bitten
		// this migration three times: when two utilities from the SAME group
		// reach one element, the winner is Tailwind's emission order in the
		// built stylesheet, not the order of the class string. There is no
		// error, and the result reads as a working default right up until
		// someone passes the other value.
		//
		// Border colour is deliberately NOT checked. Several tool cards layer a
		// conditional `border-error/30` over `border-border-subtle` on purpose,
		// and that works because `border-e…` is emitted after `border-b…`.
		// Warning on an intended pattern is how a guard gets ignored.
		$effect(() => {
			const groups: ReadonlyArray<
				readonly [label: string, prop: string, active: boolean, re: RegExp]
			> = [
				["radius", "radius", radius !== "none", /^rounded(-|$)/],
				["shadow", "elevation", elevation !== "none", /^shadow(-|$)/],
				["padding", "padding", padding !== "none", /^p[xytrbl]?-/],
				[
					"background",
					"variant",
					VARIANT_CLASSES[variant].includes("bg-"),
					/^bg-/,
				],
			];

			for (const token of (className ?? "").split(/\s+/)) {
				// Variant-prefixed (`hover:`, `max-md:`) utilities apply under a
				// condition this element is not in by default, so they do not
				// collide. `!` overrides are an explicit, working escape hatch.
				if (!token || token.includes(":") || token.endsWith("!")) continue;
				for (const [label, prop, active, re] of groups) {
					if (active && re.test(token)) {
						console.warn(
							`[ui/Surface] class="${token}" collides with the ${label} this Surface already emits. Which one wins is decided by Tailwind's emission order, not by this string. Pass ${prop}="none" to hand ${label} to the call site, or drop the class.`,
						);
					}
				}
			}
		});
	}
</script>

<div {...rest} class={surfaceClass}>{@render children()}</div>
