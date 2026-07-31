<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import {
		exemptFromBackgroundInert,
	} from "./actions/use-background-inert.svelte.js";
	import {
		FLOATING_MENU_CONTENT_CLASSES,
		FLOATING_POSITIONING_DEFAULTS,
	} from "./floating-styles.js";

	type MenuSide = "top" | "right" | "bottom" | "left";
	type MenuAlign = "start" | "center" | "end";
	type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

	type MenuOwnProps = {
		open?: boolean;
		onopenchange?: (open: boolean) => void;
		ariaLabel?: string;
		side?: MenuSide;
		align?: MenuAlign;
		sideOffset?: number;
		alignOffset?: number;
		portalTo?: HTMLElement | string;
		customAnchor?: HTMLElement | null;
		class?: string;
		trigger: TriggerSnippet;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		"class" | "children" | "role" | "aria-label"
	>;

	let {
		open = $bindable(false),
		onopenchange,
		ariaLabel,
		side,
		align = FLOATING_POSITIONING_DEFAULTS.align,
		sideOffset = FLOATING_POSITIONING_DEFAULTS.sideOffset,
		alignOffset,
		portalTo,
		customAnchor,
		class: className,
		trigger,
		children,
		...rest
	}: MenuOwnProps = $props();

	const contentClass = $derived(
		[FLOATING_MENU_CONTENT_CLASSES, className].filter(Boolean).join(" "),
	);
</script>

<DropdownMenu.Root bind:open onOpenChange={onopenchange}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Portal to={portalTo}>
		<DropdownMenu.Content
			{...rest}
			{side}
			{align}
			{sideOffset}
			{alignOffset}
			{customAnchor}
			preventScroll={FLOATING_POSITIONING_DEFAULTS.preventScroll}
			strategy={FLOATING_POSITIONING_DEFAULTS.strategy}
			collisionPadding={FLOATING_POSITIONING_DEFAULTS.collisionPadding}
			loop={true}
			aria-label={ariaLabel}
			class={contentClass}
		>
			{#snippet child({ props, wrapperProps })}
				<div {...wrapperProps}>
					<div {...props} use:exemptFromBackgroundInert>
						{@render children()}
					</div>
				</div>
			{/snippet}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
