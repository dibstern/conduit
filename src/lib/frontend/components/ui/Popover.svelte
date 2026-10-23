<script lang="ts">
	import { getDialogTarget } from "./dialog-context.js";
	import {
		Popover as BitsPopover,
		type PopoverContentProps,
		type PopoverContentStaticProps,
		type PopoverPortalProps,
	} from "bits-ui";
	import { type Snippet, tick, untrack } from "svelte";
	import { fade } from "svelte/transition";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { dimThemeColor } from "../../stores/theme.svelte.js";
	import { dragToDismiss, sheetGlide, sheetPosition, settleMs, sheetScrimStyle } from "../../actions/drag-to-dismiss.js";
	import SheetChrome from "./SheetChrome.svelte";
	import {
		backgroundInert,
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
		sheetEdge?: "bottom" | "top";
		/** Sheet modality is opt-in so existing anchored popovers retain their behavior. */
		modal?: boolean;
		initialFocus?: "first" | "content";
		sheetBottomPadding?: number;
		/** Keep a scrim below raised chrome while the sheet lives inside that chrome. */
		sheetScrim?: {
			portalTo?: HTMLElement | string | undefined;
			zIndex?: string;
			testId?: string;
		};
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
			| { title: string; ariaLabel?: undefined; labelledBy?: undefined }
			| { title?: undefined; ariaLabel: string; labelledBy?: undefined }
			| { title?: undefined; ariaLabel?: undefined; labelledBy: string }
		);

	let {
		open = $bindable(false),
		onopenchange,
		presentation = "popover",
		sheetEdge = "bottom",
		modal = false,
		initialFocus = "first",
		sheetBottomPadding = 12,
		sheetScrim,
		footer,
		title,
		ariaLabel,
		labelledBy,
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
	const scrimStyle = $derived(sheetScrimStyle(scrimFade));
	let sheetEl = $state<HTMLDivElement | null>(null);
	let triggerEl = $state<HTMLButtonElement | null>(null);

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const resolvedTitle = $derived(title?.trim() ? title : undefined);
	const resolvedAriaLabel = $derived(ariaLabel?.trim() ? ariaLabel : undefined);
	const resolvedLabelledBy = $derived(labelledBy?.trim() ? labelledBy : undefined);
	const accessibleName = $derived(resolvedTitle || resolvedLabelledBy
		? { "aria-labelledby": resolvedTitle ? titleId : resolvedLabelledBy }
		: { "aria-label": resolvedAriaLabel });
	const contentClass = $derived(
		[FLOATING_SURFACE_CLASSES, className].filter(Boolean).join(" "),
	);

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onopenchange?.(nextOpen);
	}

	$effect(() => {
		// A modal boundary already closes older surfaces; registering itself would
		// make its own backgroundInert action close it as it mounts.
		if (open && !(sheet && modal)) return registerOpenSurface(() => handleOpenChange(false));
		return undefined;
	});
	$effect(() => {
		if (!sheet || (!open && sheetEdge === "bottom")) scrimFade = { progress: 0, settling: false };
	});
	$effect(() => {
		if (open && sheet) return dimThemeColor();
		return undefined;
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
		...accessibleName,
		class: contentClass,
	});
	const sheetContentProps: Omit<PopoverContentStaticProps, "child" | "children"> = $derived({
		...rest,
		id: rest.id ?? uid,
		// Bits' scroll lock also blocks body pointer events; nonmodal sheets leave the header usable.
		preventScroll: modal,
		preventOverflowTextSelection: false,
		role: "dialog",
		"aria-modal": modal ? true : undefined,
		...accessibleName,
		class: `${sheetEdge === "top" ? "relative pointer-events-auto" : "fixed inset-x-0 bottom-0"} z-[var(--z-sheet)] w-full outline-hidden`,
		onOpenAutoFocus: (event) => {
			rest.onOpenAutoFocus?.(event);
			if (!event.defaultPrevented && initialFocus === "content") {
				event.preventDefault();
				// Bits can run this twice per open; never pull focus back out of the sheet.
				if (!sheetEl?.contains(document.activeElement))
					sheetEl?.focus({ preventScroll: true });
			}
		},
		onCloseAutoFocus: (event) => {
			rest.onCloseAutoFocus?.(event);
			if (event.defaultPrevented || !modal) return;
			event.preventDefault();
			// Inerting the trigger can blur it before Bits records its focus memory.
			// Wait for the boundary to release, then return to the actual trigger.
			void tick().then(() => {
				if (!open) triggerEl?.focus({ preventScroll: true });
			});
		},
	});

	if (import.meta.env.DEV) {
		$effect(() => {
			if (!resolvedTitle && !resolvedAriaLabel && !resolvedLabelledBy) {
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

{#snippet scrim()}
	<button type="button" tabindex="-1" aria-label="Close details" data-testid={sheetScrim?.testId ?? "popover-sheet-scrim"} class="pointer-events-auto fixed inset-0 z-[var(--z-sheet)] border-0 bg-backdrop p-0" style:top={sheetEdge === "top" ? "var(--sheet-top, 0px)" : undefined} style:z-index={sheetScrim?.zIndex} style:opacity={scrimStyle.opacity} style:transition={scrimStyle.transition} onclick={() => handleOpenChange(false)} transition:fade|global={{ duration: sheetEdge === "top" ? settleMs() : 0 }} use:sheetPosition={sheetEdge} use:exemptFromBackgroundInert></button>
{/snippet}

<BitsPopover.Root bind:open onOpenChange={handleOpenChange}>
	<!-- Keep the trigger, conditional and portal adjacent so citations have no space before punctuation. -->
	<BitsPopover.Trigger bind:ref={triggerEl}>
		{#snippet child({ props })}
			{@render trigger({ props })}
		{/snippet}
	</BitsPopover.Trigger>{#if sheet && open && sheetEl && sheetScrim?.portalTo !== undefined}
		<!-- Register after the modal boundary so the scrim remains interactive. -->
		<BitsPopover.Portal to={sheetScrim.portalTo}>
			{@render scrim()}
		</BitsPopover.Portal>
	{/if}<BitsPopover.Portal {...portalProps}>
		{#if sheet}
			{#if open && (!modal || sheetEl) && sheetScrim?.portalTo === undefined}{@render scrim()}{/if}
			<div class={sheetEdge === "top" ? "pointer-events-none fixed inset-x-0 z-[var(--z-sheet)] overflow-hidden" : "contents"} style:top={sheetEdge === "top" ? "var(--sheet-top, 0px)" : undefined} use:sheetPosition={sheetEdge}>
			<BitsPopover.ContentStatic {...sheetContentProps} bind:ref={sheetEl}>
				{#snippet child({ props })}
					<div {...props} id={sheetContentProps.id} data-sheet-edge={sheetEdge} use:exemptFromBackgroundInert use:backgroundInert={modal && open} use:dragToDismiss={{ edge: sheetEdge, ondismiss: () => handleOpenChange(false), onprogress: (progress, settling) => { scrimFade = { progress, settling }; } }} transition:sheetGlide|global={{ edge: sheetEdge, onprogress: (progress, settling) => { scrimFade = { progress, settling }; } }}>
						<SheetChrome edge={sheetEdge} maxHeight={sheetEdge === "top" ? "max(0px, calc(100dvh - var(--sheet-top, 0px) - 64px))" : "90dvh"} {footer} bottomPadding={sheetBottomPadding} bodyClass={className ?? ""}>{@render content()}</SheetChrome>
					</div>
				{/snippet}
			</BitsPopover.ContentStatic>
			</div>
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
