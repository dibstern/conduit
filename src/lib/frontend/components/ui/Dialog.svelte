<!-- Native <dialog> promoted to the browser's top layer via showModal().        -->
<!--                                                                            -->
<!-- The top layer paints above every stacking context on the page, so modals    -->
<!-- never compete on z-index and can't end up behind an application pane.      -->
<!-- showModal() also makes the rest of the page inert, which is what stops      -->
<!-- taps, swipes, tab focus, and screen readers from reaching an open sidebar   -->
<!-- underneath.                                                                 -->
<!--                                                                            -->
<!-- Callers render their own styled box as `children`; this component owns      -->
<!-- only the dismissal behaviour and the scrim.                                 -->

<script module lang="ts">
	// Whether the latest input was a tap or click rather than a key, tracked
	// page-wide: a conditional dialog mounts too late to see the pointerdown that
	// opened it, and a sheet pulled up from its dock is closed by a gesture that
	// began outside it.
	let lastInputWasPointer = false;
	if (typeof document !== "undefined") {
		document.addEventListener("pointerdown", () => { lastInputWasPointer = true; }, true);
		document.addEventListener("keydown", () => { lastInputWasPointer = false; }, true);
	}
</script>

<script lang="ts">
	import { onDestroy, type Snippet } from "svelte";
	import { provideDialogTarget } from "./dialog-context.js";
	import { dimThemeColor } from "../../stores/theme.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { dragToDismiss } from "../../actions/drag-to-dismiss.js";

	let {
		open,
		onclose,
		labelledBy,
		ariaLabel,
		describedBy,
		placement = "center",
		dismissible = true,
		returnFocus,
		initialFocus = "dialog",
		backdrop = "default",
		sheetElement = $bindable<HTMLElement | undefined>(),
		sheetDismissOffset,
		children,
	}: {
		open: boolean;
		/** Fires for every dismissal path: Escape, backdrop click, or close button. */
		onclose: () => void;
		/** id of the element naming this dialog, for screen readers. */
		labelledBy?: string | undefined;
		ariaLabel?: string | undefined;
		describedBy?: string | undefined;
		/** `top` pins the dialog's top edge, so content that grows while the
		 *  user types (a match list) extends downward instead of re-centring. */
		placement?: "center" | "top" | "sheet" | "fullscreen" | undefined;
		dismissible?: boolean | undefined;
		returnFocus?: (() => HTMLElement | null) | undefined;
		initialFocus?: "dialog" | "first" | undefined;
		/** Scrim weight. `dark` for media, `subtle` for large panels that
		 *  should still show their context. */
		backdrop?: "default" | "dark" | "subtle";
		/** The usage dock places this same shell while pulling it open. */
		sheetElement?: HTMLElement | undefined;
		sheetDismissOffset?: (() => number) | undefined;
		children: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	$effect(() => {
		if (open && dialogEl && (placement === "sheet" || sessionViewState.compact && placement !== "fullscreen")) return dimThemeColor();
		return undefined;
	});
	provideDialogTarget(() => dialogEl);
	const tabbableSelector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

	// Closing hands focus back to the control that opened the dialog. WebKit
	// never focused that control on the tap, so it treats the hand-back as
	// keyboard focus and lights the opener with a focus ring after a purely
	// touch-driven open and close (iOS 26: the "..." session-bar button, the
	// phone usage dock). The ring is only right after keyboard input; a keyboard
	// user dismissing with Escape keeps it.
	// An opener still focused from the last hand-back gets it back from close()
	// itself, ring included, and focusing an already focused element is a no-op,
	// so let go of it first.
	function focusOpener(target: HTMLElement): void {
		const options: FocusOptions & { focusVisible: boolean } = {
			preventScroll: true,
			focusVisible: !lastInputWasPointer,
		};
		if (document.activeElement === target) target.blur();
		target.focus(options);
	}

	onDestroy(() => {
		// Conditional dialog hosts can unmount before `open` becomes false.
		if (!dialogEl?.open) return;
		const target = returnFocus?.();
		if (target?.isConnected) focusOpener(target);
	});

	// showModal()/close() are imperative, so mirror `open` onto the element.
	// Both directions need the guard: showModal() on an already-open dialog throws.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			// An inert dialog gives showModal() nothing to focus. Refocusing the dialog
			// afterwards is too late: the first control has already had a focus event,
			// and focus-driven widgets act on it (a bits-ui radio selects its item).
			// Chromium ignores `autofocus` on the dialog itself, so it cannot do this.
			el.inert = initialFocus === "dialog";
			el.showModal();
			el.inert = false;
			// showModal() otherwise focuses the first focusable descendant, which
			// lands a focus ring on whichever control happens to be first — the
			// close X in SettingsPanel, the copy-URL button in QrModal — making
			// them look pre-selected the instant the modal appears. Focusing the
			// dialog itself also puts a screen reader at the start of the dialog,
			// so `aria-labelledby` is announced before any content.
			// `preventScroll` so opening a tall dialog cannot scroll the page
			// underneath it; the dialog is its own scroller.
			// A pointer-opened dialog focuses its first control without presenting
			// it as a keyboard selection. Move off the UA's auto-focused control
			// first so focusVisible:false also applies when it picked that same one.
			if (initialFocus === "dialog") el.focus({ preventScroll: true });
			else if (lastInputWasPointer) {
				el.focus({ preventScroll: true });
				const first = el.querySelector<HTMLElement>(tabbableSelector);
				const options: FocusOptions & { focusVisible: boolean } = {
					preventScroll: true,
					focusVisible: false,
				};
				first?.focus(options);
			}
		} else if (!open && el.open) {
			el.close();
			const target = returnFocus?.();
			if (target?.isConnected) focusOpener(target);
			else if (lastInputWasPointer && document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		}
	});

	// Escape closes the dialog at the browser level without touching caller
	// state. Route it back through onclose, or the two drift apart and the
	// modal can never reopen.
	function handleCancel(e: Event): void {
		e.preventDefault();
		if (dismissible) onclose();
	}

	// ::backdrop is not a child element — clicks on it report the <dialog> as
	// their target. This test only holds because the dialog has no padding or
	// border of its own; give it either and clicks on that edge read as
	// backdrop clicks.
	// A press that starts inside and is released outside also targets the
	// dialog, as their common ancestor. That happens without any drag when the
	// press itself resizes the panel: Settings tabs activate on focus, the
	// panel re-centres, and the release lands on the backdrop.
	let pressStartedInside = false;
	function handleClick(e: MouseEvent): void {
		const startedInside = pressStartedInside;
		pressStartedInside = false;
		if (dismissible && !startedInside && e.target === dialogEl) onclose();
	}

	// Native dialogs can send Tab to <body> when there are no tabbable
	// descendants. Keep focus on the dialog until it is dismissed.
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== "Tab" || dialogEl?.querySelector(tabbableSelector)) return;
		event.preventDefault();
		dialogEl?.focus({ preventScroll: true });
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialogEl}
	aria-labelledby={labelledBy}
	aria-label={ariaLabel}
	aria-describedby={describedBy}
	data-backdrop={backdrop}
	data-placement={placement}
	data-testid={placement === "sheet" || placement === "fullscreen" ? "modal-sheet-scrim" : undefined}
	tabindex="-1"
	class="max-w-[100vw] overflow-visible border-none bg-transparent p-0 text-text focus:outline-none {placement === 'fullscreen' ? 'fixed inset-0 m-0 h-dvh w-full max-h-none' : placement === 'sheet' ? 'fixed inset-x-0 bottom-0 top-auto m-0 w-full max-h-none' : placement === 'top' ? 'mx-auto mt-[10dvh] mb-auto' : 'm-auto'}"
	oncancel={handleCancel}
	onclick={handleClick}
	onpointerdown={(e) => { pressStartedInside = e.target !== dialogEl; }}
	onkeydown={handleKeydown}
>
	{#if open}
		{#if placement === "sheet"}
			<div bind:this={sheetElement} use:dragToDismiss={{ ondismiss: onclose, enabled: dismissible, dismissOffset: sheetDismissOffset }}>
				{@render children()}
			</div>
		{:else}
			{@render children()}
		{/if}
	{/if}
</dialog>

<style>
	/* The UA stylesheet caps dialog width and sets overflow:auto, which squeezes
	   narrow screens and clips the content box's shadow. Undone via utilities
	   above; kept here as the reason. */

	/* A bits-ui sheet underneath locks <body> with pointer-events:none, which
	   the dialog would inherit. The top layer already makes the page inert. */
	dialog {
		pointer-events: auto;
	}

	/* ::backdrop inherits the dialog's theme tokens; the scrim stays dark in
	   both themes, unlike --overlay-rgb's contrast wash. */
	/* A sheet being dragged sets --sheet-raised on its dialog, so the scrim
	   fades with the sheet rather than vanishing when it closes. */
	dialog::backdrop {
		background: var(--color-backdrop);
		backdrop-filter: blur(2px);
		opacity: var(--sheet-raised, 1);
		transition: opacity var(--sheet-transition, 0s);
	}

	dialog[data-backdrop="dark"]::backdrop {
		background: var(--color-backdrop-dark);
		backdrop-filter: none;
	}

	dialog[data-backdrop="subtle"]::backdrop {
		background: var(--color-backdrop-subtle);
		backdrop-filter: blur(var(--blur-sm));
	}

	/* Auto margins centre an odd-height dialog on a half pixel. Its borders
	   then render soft, and Chromium rasterises them a pixel apart between
	   identical frames. Snap the offset to whole pixels; m-auto remains the
	   fallback where round() is unsupported. Content height is capped by the
	   UA's max-height, so the dialog never overflows the top edge. */
	@supports (top: round(50%, 1px)) {
		dialog[data-placement="center"] {
			inset-block: round(50%, 1px) auto;
			margin-block: 0;
			translate: 0 round(-50%, 1px);
		}
	}
</style>
