<script lang="ts">
	import { Popover as BitsPopover } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
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
		open?: boolean;
		onopenchange?: (open: boolean) => void;
		side?: PopoverSide;
		align?: PopoverAlign;
		sideOffset?: number;
		alignOffset?: number;
		portalTo?: HTMLElement | string;
		class?: string;
		trigger: TriggerSnippet;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		| "class"
		| "children"
		| "title"
		| "role"
		| "aria-label"
		| "aria-labelledby"
	> &
		(
			| { title: string; ariaLabel?: never }
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

<BitsPopover.Root bind:open onOpenChange={onopenchange}>
	<BitsPopover.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</BitsPopover.Trigger>

	<BitsPopover.Portal to={portalTo}>
		<BitsPopover.Content
			{...rest}
			{side}
			{align}
			{sideOffset}
			{alignOffset}
			preventScroll={FLOATING_POSITIONING_DEFAULTS.preventScroll}
			strategy={FLOATING_POSITIONING_DEFAULTS.strategy}
			collisionPadding={FLOATING_POSITIONING_DEFAULTS.collisionPadding}
			role="dialog"
			aria-label={resolvedTitle ? undefined : resolvedAriaLabel}
			aria-labelledby={resolvedTitle ? titleId : undefined}
			class={contentClass}
		>
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
