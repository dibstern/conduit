<script lang="ts">
	import {
		DropdownMenu,
		type DropdownMenuContentProps,
		type DropdownMenuContentStaticProps,
		type DropdownMenuPortalProps,
	} from "bits-ui";
	import { setContext, type Snippet } from "svelte";
	import {
		exemptFromBackgroundInert,
		registerOpenSurface,
	} from "./actions/use-background-inert.svelte.js";
	import { dragToDismiss } from "../../actions/drag-to-dismiss.js";
	import {
		FLOATING_MENU_CONTENT_CLASSES,
		FLOATING_POSITIONING_DEFAULTS,
	} from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";
	import { getDialogTarget } from "./dialog-context.js";
	import SheetChrome from "./SheetChrome.svelte";

	const SCRIM_ACTIVATION_DELAY_MS = 50;

	type MenuSide = "top" | "right" | "bottom" | "left";
	type MenuAlign = "start" | "center" | "end";
	type TriggerSnippet = Snippet<[{ props: Record<string, unknown> }]>;

	type MenuOwnProps = {
		open?: boolean | undefined;
		onopenchange?: ((open: boolean) => void) | undefined;
		ariaLabel?: string | undefined;
		/** MenuItem rows need DropdownMenu's dismissal model; a Modal sheet would require raw rows and a second model. */
		presentation?: "popover" | "sheet" | undefined;
		side?: MenuSide | undefined;
		align?: MenuAlign | undefined;
		sideOffset?: number | undefined;
		alignOffset?: number | undefined;
		portalTo?: HTMLElement | string | undefined;
		customAnchor?: HTMLElement | null | undefined;
		class?: string | undefined;
		trigger: TriggerSnippet;
		children: Snippet;
		footer?: Snippet | undefined;
		sheetBottomPadding?: number;
	} & Omit<
		DropdownMenuContentProps,
		| "align"
		| "alignOffset"
		| "aria-label"
		| "child"
		| "children"
		| "class"
		| "collisionPadding"
		| "customAnchor"
		| "id"
		| "loop"
		| "onOpenAutoFocus"
		| "preventScroll"
		| "side"
		| "sideOffset"
		| "strategy"
	>;

	let {
		open = $bindable(false),
		onopenchange,
		ariaLabel,
		presentation = "popover",
		side,
		align = FLOATING_POSITIONING_DEFAULTS.align,
		sideOffset = FLOATING_POSITIONING_DEFAULTS.sideOffset,
		alignOffset,
		portalTo,
		customAnchor,
		class: className,
		trigger,
		children,
		footer,
		sheetBottomPadding = 12,
		...rest
	}: MenuOwnProps = $props();
	setContext<MenuDensityContext>(menuDensityContextKey, () =>
		presentation === "sheet" ? "sheet" : "default",
	);
	const dialogTarget = getDialogTarget();

	const contentClass = $derived(
		[FLOATING_MENU_CONTENT_CLASSES, className].filter(Boolean).join(" "),
	);

	/**
	 * bits-ui 2.18.1 destructures `id` out in its popper layer and never applies
	 * it to the content element, so the rendered menu carries no id at all. Its
	 * keydown handler gates typeahead and Home/End on
	 * `target.closest("[data-dropdown-menu-content]")?.id === contentId`, which
	 * can never match an empty id — typing a letter in an open menu does nothing
	 *. We own the element, so we own the id.
	 */
	const contentId = $props.id();
	let contentNode = $state<HTMLElement | null>(null);
	let scrimInteractive = $state(false);
	let scrimFade = $state({ progress: 0, settling: false });
	let openingClickDeadline = 0;

	// bits-ui 2.18.1 DropdownMenuTrigger opens on touch pointerup, then its
	// onclick toggles again when the synthetic click arrives with detail=0.
	function triggerProps(props: Record<string, unknown>): Record<string, unknown> {
		if (presentation !== "sheet") return props;
		const onPointerDown = props["onpointerdown"] as ((event: PointerEvent) => void) | undefined;
		const onPointerUp = props["onpointerup"] as ((event: PointerEvent) => void) | undefined;
		const onKeyDown = props["onkeydown"] as ((event: KeyboardEvent) => void) | undefined;
		const onClick = props["onclick"] as ((event: MouseEvent) => void) | undefined;
		return {
			...props,
			// A mouse press opens the sheet at once; its release must not pick the
			// row that has just slid under the pointer.
			onpointerdown: (event: PointerEvent) => {
				openingClickDeadline = event.pointerType === "touch" ? 0 : event.timeStamp + 500;
				onPointerDown?.(event);
			},
			onpointerup: (event: PointerEvent) => {
				if (event.pointerType === "touch") openingClickDeadline = event.timeStamp + 500;
				onPointerUp?.(event);
			},
			onkeydown: (event: KeyboardEvent) => {
				openingClickDeadline = 0;
				onKeyDown?.(event);
			},
			onclick: (event: MouseEvent) => {
				const followsTouch = event.timeStamp <= openingClickDeadline;
				openingClickDeadline = 0;
				if (followsTouch && event.detail === 0) {
					event.preventDefault();
					return;
				}
				onClick?.(event);
			},
		};
	}

	// The tap that opens a sheet ends in a click at the same spot. When the
	// trigger sits low, a sheet row is there by then and would be chosen.
	// A press inside the sheet starts a new gesture, so it clears the deadline.
	function swallowOpeningClick(event: MouseEvent) {
		if (event.timeStamp > openingClickDeadline) return;
		openingClickDeadline = 0;
		event.preventDefault();
		event.stopPropagation();
	}

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onopenchange?.(nextOpen);
	}

	$effect(() => {
		if (open) return registerOpenSurface(() => handleOpenChange(false));
		return undefined;
	});
	$effect(() => {
		if (!open || presentation !== "sheet") {
			scrimInteractive = false;
			scrimFade = { progress: 0, settling: false };
			return;
		}
		// Bits opens on pointerdown and installs outside dismissal after mount.
		const timer = setTimeout(
			() => { scrimInteractive = true; },
			SCRIM_ACTIVATION_DELAY_MS,
		);
		return () => clearTimeout(timer);
	});


	/**
	 * bits-ui mounts the content's focus scope twice per open, so its
	 * open-auto-focus runs twice, each time deferred to a rAF. The second one
	 * lands after the user has already arrowed down the menu, refocuses the
	 * content, and bits' own focus handler then resets roving focus to the first
	 * item. Taking the initial focus ourselves makes it
	 * idempotent: focus the menu only while it is open and focus is still
	 * outside it.
	 */
	function focusContentOnce(event: Event) {
		event.preventDefault();
		requestAnimationFrame(() => {
			const node = contentNode;
			if (!open || !node) return;
			if (node.contains(node.ownerDocument.activeElement)) return;
			node.focus();
		});
	}

	const portalProps: DropdownMenuPortalProps = $derived.by(() => {
		const target = dialogTarget?.() ?? portalTo;
		return target === undefined ? {} : { to: target };
	});
	const contentProps: Omit<
		DropdownMenuContentProps,
		"child" | "children"
	> = $derived({
		...rest,
		id: contentId,
		onOpenAutoFocus: focusContentOnce,
		...(side === undefined ? {} : { side }),
		align,
		sideOffset,
		...(alignOffset === undefined ? {} : { alignOffset }),
		...(customAnchor === undefined ? {} : { customAnchor }),
		preventScroll: FLOATING_POSITIONING_DEFAULTS.preventScroll,
		strategy: FLOATING_POSITIONING_DEFAULTS.strategy,
		collisionPadding: FLOATING_POSITIONING_DEFAULTS.collisionPadding,
		loop: true,
		// bits-ui 2.18.1 makes <body> unselectable while a finger is down in the
		// menu. A press that turns into a scroll never undoes it, and the next
		// press saves the locked state as the one to restore, so the whole page,
		// chat included, stays unselectable until reload (conduit-test-l1sh).
		preventOverflowTextSelection: false,
		...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
		class: contentClass,
	});
	const sheetContentProps: Omit<DropdownMenuContentStaticProps, "child" | "children"> = $derived({
		...rest,
		id: contentId,
		onOpenAutoFocus: focusContentOnce,
		preventScroll: false,
		loop: true,
		preventOverflowTextSelection: false,
		...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
		class: "fixed inset-x-0 bottom-0 z-[var(--z-sheet)] w-full focus-visible:outline-hidden",
	});
</script>

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{@render trigger({ props: triggerProps(props) })}
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Portal {...portalProps}>
		{#if presentation === "sheet"}
			{#if open}<div aria-hidden="true" data-testid="menu-sheet-scrim" class="fixed inset-0 z-[var(--z-sheet)] bg-backdrop" class:pointer-events-none={!scrimInteractive} style:opacity={1 - scrimFade.progress} style:transition={scrimFade.settling ? "opacity 220ms linear" : undefined} use:exemptFromBackgroundInert></div>{/if}
			<DropdownMenu.ContentStatic {...sheetContentProps}>
				{#snippet child({ props })}
					<!-- Keep the bits-ui focus target on the menu shell. SheetChrome gives the
					     scrolling body a keyboard target too; Bits intercepts Tab inside the menu.
					     Svelte cannot see role="menu" through the spread. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div {...props} id={contentId} tabindex={0} bind:this={contentNode} onclickcapture={swallowOpeningClick} onpointerdowncapture={(event: PointerEvent) => { openingClickDeadline = 0; (props["onpointerdowncapture"] as ((event: PointerEvent) => void) | undefined)?.(event); }} use:exemptFromBackgroundInert use:dragToDismiss={{ ondismiss: () => handleOpenChange(false), onprogress: (progress, settling) => { scrimFade = { progress, settling }; } }}>
						<SheetChrome {footer} bottomPadding={sheetBottomPadding} class={className} menuBody>
							{@render children()}
						</SheetChrome>
					</div>
				{/snippet}
			</DropdownMenu.ContentStatic>
		{:else}
		<DropdownMenu.Content {...contentProps}>
			{#snippet child({ props, wrapperProps })}
				<div {...wrapperProps}>
					<div
						{...props}
						id={contentId}
						bind:this={contentNode}
						use:exemptFromBackgroundInert
					>
						{@render children()}
						{#if footer}<div class="mt-[12px] border-t border-border-subtle">{@render footer()}</div>{/if}
					</div>
				</div>
			{/snippet}
		</DropdownMenu.Content>
		{/if}
	</DropdownMenu.Portal>
</DropdownMenu.Root>
