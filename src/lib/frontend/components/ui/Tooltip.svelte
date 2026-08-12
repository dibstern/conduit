<script lang="ts">
	import {
		Tooltip as BitsTooltip,
		type TooltipContentProps,
		type TooltipPortalProps,
	} from "bits-ui";
	import type { Snippet } from "svelte";
	import {
		exemptFromBackgroundInert,
	} from "./actions/use-background-inert.svelte.js";
	import {
		FLOATING_POSITIONING_DEFAULTS,
		FLOATING_TOOLTIP_CLASSES,
	} from "./floating-styles.js";

	/** Bits ships 700/300; see the Tooltip primitive spec for why they are kept. */
	const DEFAULT_DELAY_MS = 700;
	const SKIP_DELAY_MS = 300;

	type TooltipSide = "top" | "right" | "bottom" | "left";
	type TooltipAlign = "start" | "center" | "end";
	type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

	type TooltipOwnProps = {
		open?: boolean | undefined;
		onopenchange?: ((open: boolean) => void) | undefined;
		delayDuration?: number | undefined;
		side?: TooltipSide | undefined;
		align?: TooltipAlign | undefined;
		sideOffset?: number | undefined;
		alignOffset?: number | undefined;
		portalTo?: HTMLElement | string | undefined;
		class?: string | undefined;
		trigger: TriggerSnippet;
		children: Snippet;
	} & Omit<
		TooltipContentProps,
		| "align"
		| "alignOffset"
		| "aria-label"
		| "aria-labelledby"
		| "child"
		| "children"
		| "class"
		| "collisionPadding"
		| "role"
		| "side"
		| "sideOffset"
		| "strategy"
	>;

	let {
		open = $bindable(false),
		onopenchange,
		delayDuration = DEFAULT_DELAY_MS,
		side,
		align = "center",
		sideOffset = FLOATING_POSITIONING_DEFAULTS.sideOffset,
		alignOffset,
		portalTo,
		class: className,
		trigger,
		children,
		...rest
	}: TooltipOwnProps = $props();

	const uid = $props.id();
	const generatedContentId = `${uid}-content`;
	// A consumer `id` is honoured at mount but must not be *swapped while open*: Bits
	// derives `aria-describedby` from the DOM property `contentNode.id`, which is not
	// reactive, so the trigger would keep pointing at the previous id.
	const contentId = $derived(rest.id ?? generatedContentId);
	// Bits only registers an active trigger when the tooltip *transitions* to open,
	// so a controlled-open Root has none and floating-ui renders the content with no
	// reference element -- visible, correctly sized, and pinned off-screen. Naming
	// the trigger on both ends registers it at mount instead.
	const triggerId = `${uid}-trigger`;
	const contentClass = $derived(
		[FLOATING_TOOLTIP_CLASSES, className].filter(Boolean).join(" "),
	);

	let contentNode = $state<HTMLElement | null>(null);

	function handleOpenChange(nextOpen: boolean) {
		onopenchange?.(nextOpen);
	}

	const portalProps: TooltipPortalProps = $derived(
		portalTo === undefined ? {} : { to: portalTo },
	);
	const contentProps: Omit<
		TooltipContentProps,
		"child" | "children"
	> = $derived({
		...rest,
		...(side === undefined ? {} : { side }),
		align,
		sideOffset,
		...(alignOffset === undefined ? {} : { alignOffset }),
		strategy: FLOATING_POSITIONING_DEFAULTS.strategy,
		collisionPadding: FLOATING_POSITIONING_DEFAULTS.collisionPadding,
		role: "tooltip",
		class: contentClass,
	});

	if (import.meta.env.DEV) {
		$effect(() => {
			if (!open) return;
			// The portal mounts after this effect first runs, so `contentNode` is null on
			// that pass. Warning there fires on every valid tooltip; wait for the bind.
			if (!contentNode) return;
			if (contentNode.textContent?.trim()) return;
			console.warn(
				"[ui/Tooltip] tooltip content must render non-whitespace text.",
			);
		});
	}
</script>

<BitsTooltip.Provider skipDelayDuration={SKIP_DELAY_MS}>
	<BitsTooltip.Root
		bind:open
		{triggerId}
		{delayDuration}
		onOpenChange={handleOpenChange}
	>
		<BitsTooltip.Trigger id={triggerId}>
			{#snippet child({ props })}
				{@render trigger({ props })}
			{/snippet}
		</BitsTooltip.Trigger>

		<BitsTooltip.Portal {...portalProps}>
			<BitsTooltip.Content {...contentProps}>
				{#snippet child({ props, wrapperProps })}
					<div {...wrapperProps}>
						<div
							{...props}
							id={contentId}
							bind:this={contentNode}
							use:exemptFromBackgroundInert
						>
							{@render children()}
						</div>
					</div>
				{/snippet}
			</BitsTooltip.Content>
		</BitsTooltip.Portal>
	</BitsTooltip.Root>
</BitsTooltip.Provider>
