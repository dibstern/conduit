<!-- ─── Dialog ───────────────────────────────────────────────────────────────── -->
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
	// Track the opener before a conditional dialog mounts: its own listeners are
	// too late to see the pointerdown that created it.
	let openedByPointer = false;
	if (typeof document !== "undefined") {
		document.addEventListener("pointerdown", () => { openedByPointer = true; }, true);
		document.addEventListener("keydown", () => { openedByPointer = false; }, true);
	}
</script>

<script lang="ts">
	import { onDestroy, type Snippet } from "svelte";
	import { provideDialogTarget } from "./dialog-context.js";

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
		children,
	}: {
		open: boolean;
		/** Fires for every dismissal path: Escape, backdrop click, or close button. */
		onclose: () => void;
		/** id of the element naming this dialog, for screen readers. */
		labelledBy?: string | undefined;
		ariaLabel?: string | undefined;
		describedBy?: string | undefined;
		placement?: "center" | "sheet" | undefined;
		dismissible?: boolean | undefined;
		returnFocus?: (() => HTMLElement | null) | undefined;
		initialFocus?: "dialog" | "first" | undefined;
		/** Scrim weight. `dark` for media, `subtle` for large panels that
		 *  should still show their context. */
		backdrop?: "default" | "dark" | "subtle";
		children: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	provideDialogTarget(() => dialogEl);
	const tabbableSelector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

	// Whether the most recent input inside the dialog was a tap or click.
	// close() hands focus back to the control that opened the dialog, and
	// WebKit treats that hand-back as keyboard focus, so the opener lights up
	// with a focus ring after a purely touch-driven open and close (iOS 26,
	// the "..." session-bar button). Dropping the restored focus is only right
	// after pointer input; a keyboard user dismissing with Escape keeps it.
	let closedByPointer = false;
	onDestroy(() => {
		// Conditional dialog hosts can unmount before `open` becomes false.
		if (!dialogEl?.open) return;
		const target = returnFocus?.();
		if (target?.isConnected) {
			const options: FocusOptions & { focusVisible: boolean } = {
				preventScroll: true,
				focusVisible: !closedByPointer,
			};
			target.focus(options);
		}
	});

	// showModal()/close() are imperative, so mirror `open` onto the element.
	// Both directions need the guard: showModal() on an already-open dialog throws.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
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
			else if (openedByPointer) {
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
			if (target?.isConnected) target.focus({ preventScroll: true });
			else if (closedByPointer && document.activeElement instanceof HTMLElement) {
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
	function handleClick(e: MouseEvent): void {
		if (dismissible && e.target === dialogEl) onclose();
	}

	// Native dialogs can send Tab to <body> when there are no tabbable
	// descendants. Keep focus on the dialog until it is dismissed.
	function handleKeydown(event: KeyboardEvent): void {
		closedByPointer = false;
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
	data-testid={placement === "sheet" ? "modal-sheet-scrim" : undefined}
	tabindex="-1"
	class="max-w-[100vw] overflow-visible border-none bg-transparent p-0 text-text focus:outline-none {placement === 'sheet' ? 'fixed inset-x-0 bottom-0 top-auto m-0 w-full' : 'm-auto'}"
	oncancel={handleCancel}
	onclick={handleClick}
	onpointerdown={() => (closedByPointer = true)}
	onkeydown={handleKeydown}
>
	{#if open}
		{@render children()}
	{/if}
</dialog>

<style>
	/* The UA stylesheet caps dialog width and sets overflow:auto, which squeezes
	   narrow screens and clips the content box's shadow. Undone via utilities
	   above; kept here as the reason. */

	/* ::backdrop inherits the dialog's theme tokens; the scrim stays dark in
	   both themes, unlike --overlay-rgb's contrast wash. */
	dialog::backdrop {
		background: var(--color-backdrop);
		backdrop-filter: blur(2px);
	}

	dialog[data-backdrop="dark"]::backdrop {
		background: var(--color-backdrop-dark);
		backdrop-filter: none;
	}

	dialog[data-backdrop="subtle"]::backdrop {
		background: var(--color-backdrop-subtle);
		backdrop-filter: blur(var(--blur-sm));
	}
</style>
