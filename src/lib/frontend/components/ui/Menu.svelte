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
	import {
		FLOATING_MENU_CONTENT_CLASSES,
		FLOATING_POSITIONING_DEFAULTS,
	} from "./floating-styles.js";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";
	import { getDialogTarget } from "./dialog-context.js";

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
	let touchClickDeadline = 0;

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
			onpointerdown: (event: PointerEvent) => {
				if (event.pointerType !== "touch") touchClickDeadline = 0;
				onPointerDown?.(event);
			},
			onpointerup: (event: PointerEvent) => {
				if (event.pointerType === "touch") touchClickDeadline = event.timeStamp + 500;
				onPointerUp?.(event);
			},
			onkeydown: (event: KeyboardEvent) => {
				touchClickDeadline = 0;
				onKeyDown?.(event);
			},
			onclick: (event: MouseEvent) => {
				const followsTouch = event.timeStamp <= touchClickDeadline;
				touchClickDeadline = 0;
				if (followsTouch && event.detail === 0) {
					event.preventDefault();
					return;
				}
				onClick?.(event);
			},
		};
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
		...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
		class: contentClass,
	});
	const sheetContentProps: Omit<DropdownMenuContentStaticProps, "child" | "children"> = $derived({
		...rest,
		id: contentId,
		onOpenAutoFocus: focusContentOnce,
		preventScroll: false,
		loop: true,
		...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
		class: [
			"fixed inset-x-0 bottom-0 z-[var(--z-sheet)] max-h-[90vh] w-full overflow-y-auto rounded-t-[18px] border-t border-border bg-bg-alt pb-[calc(12px+env(safe-area-inset-bottom))] shadow-modal focus-visible:outline-hidden",
			className,
		].filter(Boolean).join(" "),
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
			{#if open}<div aria-hidden="true" data-testid="menu-sheet-scrim" class="fixed inset-0 z-[var(--z-sheet)] bg-backdrop" class:pointer-events-none={!scrimInteractive} use:exemptFromBackgroundInert></div>{/if}
			<DropdownMenu.ContentStatic {...sheetContentProps}>
				{#snippet child({ props })}
					<div {...props} id={contentId} bind:this={contentNode} use:exemptFromBackgroundInert>
						<div class="mx-auto mt-2 -mb-2 h-1 w-[38px] shrink-0 rounded-full bg-border" aria-hidden="true"></div>
						{@render children()}
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
					</div>
				</div>
			{/snippet}
		</DropdownMenu.Content>
		{/if}
	</DropdownMenu.Portal>
</DropdownMenu.Root>
