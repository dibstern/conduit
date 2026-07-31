<script lang="ts">
	import {
		Popover as BitsPopover,
		type PopoverContentProps,
		type PopoverPortalProps,
	} from "bits-ui";
	import type { Snippet } from "svelte";
	import {
		exemptFromBackgroundInert,
	} from "./actions/use-background-inert.svelte.js";
	import {
		FLOATING_POSITIONING_DEFAULTS,
		FLOATING_ITEM_PADDING_CLASSES,
		FLOATING_SURFACE_CLASSES,
	} from "./floating-styles.js";

	type PopoverSide = "top" | "right" | "bottom" | "left";
	type PopoverAlign = "start" | "center" | "end";
	type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

	type PopoverOwnProps = {
		open?: boolean | undefined;
		onopenchange?: ((open: boolean) => void) | undefined;
		side?: PopoverSide | undefined;
		align?: PopoverAlign | undefined;
		sideOffset?: number | undefined;
		alignOffset?: number | undefined;
		portalTo?: HTMLElement | string | undefined;
		class?: string | undefined;
		trigger: TriggerSnippet;
		children: Snippet;
	} & Omit<
		PopoverContentProps,
		| "class"
		| "child"
		| "children"
		| "collisionPadding"
		| "preventScroll"
		| "side"
		| "sideOffset"
		| "align"
		| "alignOffset"
		| "strategy"
		| "aria-label"
		| "aria-labelledby"
	> &
		(
			| { title: string; ariaLabel?: undefined }
			| { title?: undefined; ariaLabel: string }
		);

	let {
		open = $bindable(false),
		onopenchange,
		title,
		ariaLabel,
		side,
		align = FLOATING_POSITIONING_DEFAULTS.align,
		sideOffset = FLOATING_POSITIONING_DEFAULTS.sideOffset,
		alignOffset,
		portalTo,
		class: className,
		trigger,
		children,
		...rest
	}: PopoverOwnProps = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const resolvedTitle = $derived(title?.trim() ? title : undefined);
	const resolvedAriaLabel = $derived(ariaLabel?.trim() ? ariaLabel : undefined);
	const contentClass = $derived(
		[FLOATING_SURFACE_CLASSES, className].filter(Boolean).join(" "),
	);

	function handleOpenChange(nextOpen: boolean) {
		onopenchange?.(nextOpen);
	}

	const portalProps: PopoverPortalProps = $derived(
		portalTo === undefined ? {} : { to: portalTo },
	);
	const contentProps: Omit<
		PopoverContentProps,
		"child" | "children"
	> = $derived({
		...rest,
		...(side === undefined ? {} : { side }),
		align,
		sideOffset,
		...(alignOffset === undefined ? {} : { alignOffset }),
		preventScroll: FLOATING_POSITIONING_DEFAULTS.preventScroll,
		strategy: FLOATING_POSITIONING_DEFAULTS.strategy,
		collisionPadding: FLOATING_POSITIONING_DEFAULTS.collisionPadding,
		role: "dialog",
		...(resolvedTitle
			? { "aria-labelledby": titleId }
			: resolvedAriaLabel === undefined
				? {}
				: { "aria-label": resolvedAriaLabel }),
		class: contentClass,
	});

	if (import.meta.env.DEV) {
		$effect(() => {
			if (!resolvedTitle && !resolvedAriaLabel) {
				console.warn(
					"[ui/Popover] `title` or `ariaLabel` must contain a non-whitespace accessible name.",
				);
			}
		});
	}
</script>

<BitsPopover.Root bind:open onOpenChange={handleOpenChange}>
	<BitsPopover.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</BitsPopover.Trigger>

	<BitsPopover.Portal {...portalProps}>
		<BitsPopover.Content {...contentProps}>
			{#snippet child({ props, wrapperProps })}
				<div {...wrapperProps}>
					<div {...props} use:exemptFromBackgroundInert>
						{#if resolvedTitle}
							<h2
								id={titleId}
								class={`${FLOATING_ITEM_PADDING_CLASSES} text-sm font-semibold text-text`}
							>
								{resolvedTitle}
							</h2>
						{/if}
						{@render children()}
					</div>
				</div>
			{/snippet}
		</BitsPopover.Content>
	</BitsPopover.Portal>
</BitsPopover.Root>
