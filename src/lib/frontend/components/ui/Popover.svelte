<script lang="ts">
	import { getDialogTarget } from "./dialog-context.js";
	import {
		Popover as BitsPopover,
		type PopoverContentProps,
		type PopoverContentStaticProps,
		type PopoverPortalProps,
	} from "bits-ui";
	import { type Snippet, untrack } from "svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { dragToDismiss } from "../../actions/drag-to-dismiss.js";
	import SheetChrome from "./SheetChrome.svelte";
	import {
		exemptFromBackgroundInert,
		registerOpenSurface,
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
		presentation?: "popover" | "sheet" | "auto";
		footer?: Snippet | undefined;
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
		presentation = "popover",
		footer,
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
	const dialogTarget = getDialogTarget();
	let autoSheet = $state(sessionViewState.compact);
	// Keep open forms mounted when the layout crosses the compact breakpoint.
	$effect.pre(() => {
		if (open) autoSheet = untrack(() => sessionViewState.compact);
	});
	const sheet = $derived(presentation === "sheet" || (presentation === "auto" && autoSheet));
	let scrimFade = $state({ progress: 0, settling: false });

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const resolvedTitle = $derived(title?.trim() ? title : undefined);
	const resolvedAriaLabel = $derived(ariaLabel?.trim() ? ariaLabel : undefined);
	const contentClass = $derived(
		[FLOATING_SURFACE_CLASSES, className].filter(Boolean).join(" "),
	);

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onopenchange?.(nextOpen);
	}

	$effect(() => {
		if (open) return registerOpenSurface(() => handleOpenChange(false));
		return undefined;
	});
	$effect(() => {
		if (!open || !sheet) scrimFade = { progress: 0, settling: false };
	});

	const portalProps: PopoverPortalProps = $derived.by(() => {
		const target = dialogTarget?.() ?? portalTo;
		return target === undefined ? {} : { to: target };
	});
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
		// bits-ui 2.18.1 makes <body> unselectable during a press in the popover
		// and leaks that when the press turns into a scroll, leaving the page
		// unselectable until reload (conduit-test-l1sh).
		preventOverflowTextSelection: false,
		role: "dialog",
		...(resolvedTitle
			? { "aria-labelledby": titleId }
			: resolvedAriaLabel === undefined
				? {}
				: { "aria-label": resolvedAriaLabel }),
		class: contentClass,
	});
	const sheetContentProps: Omit<PopoverContentStaticProps, "child" | "children"> = $derived({
		...rest,
		preventScroll: true,
		preventOverflowTextSelection: false,
		role: "dialog",
		...(resolvedTitle ? { "aria-labelledby": titleId } : { "aria-label": resolvedAriaLabel }),
		class: "fixed inset-x-0 bottom-0 z-[var(--z-sheet)] w-full outline-hidden",
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

{#snippet content()}
	{#if resolvedTitle}
		<h2 id={titleId} class={`${FLOATING_ITEM_PADDING_CLASSES} text-sm font-semibold text-text`}>{resolvedTitle}</h2>
	{/if}
	{@render children()}
{/snippet}

<BitsPopover.Root bind:open onOpenChange={handleOpenChange}>
	<BitsPopover.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</BitsPopover.Trigger>

	<BitsPopover.Portal {...portalProps}>
		{#if sheet}
			{#if open}<div aria-hidden="true" data-testid="popover-sheet-scrim" class="fixed inset-0 z-[var(--z-sheet)] bg-backdrop" style:opacity={1 - scrimFade.progress} style:transition={scrimFade.settling ? "opacity 220ms linear" : undefined} use:exemptFromBackgroundInert></div>{/if}
			<BitsPopover.ContentStatic {...sheetContentProps}>
				{#snippet child({ props })}
					<div {...props} use:exemptFromBackgroundInert use:dragToDismiss={{ ondismiss: () => handleOpenChange(false), onprogress: (progress, settling) => { scrimFade = { progress, settling }; } }}>
						<SheetChrome {footer} bodyClass={className ?? ""}>{@render content()}</SheetChrome>
					</div>
				{/snippet}
			</BitsPopover.ContentStatic>
		{:else}
		<BitsPopover.Content {...contentProps}>
			{#snippet child({ props, wrapperProps })}
				<div {...wrapperProps}>
					<div {...props} use:exemptFromBackgroundInert>
						{@render content()}
						{#if footer}<div class="mt-[12px] border-t border-border-subtle">{@render footer()}</div>{/if}
					</div>
				</div>
			{/snippet}
		</BitsPopover.Content>
		{/if}
	</BitsPopover.Portal>
</BitsPopover.Root>
