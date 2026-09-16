<!-- ─── Modal ────────────────────────────────────────────────────────────────── -->
<!-- Native <dialog> promoted to the browser's top layer via showModal().        -->
<!--                                                                            -->
<!-- The top layer paints above every stacking context on the page, so modals    -->
<!-- never compete on z-index and can't end up behind the mobile drawer.         -->
<!-- showModal() also makes the rest of the page inert, which is what stops      -->
<!-- taps, swipes, tab focus, and screen readers from reaching an open sidebar   -->
<!-- underneath.                                                                 -->
<!--                                                                            -->
<!-- Callers render their own styled box as `children`; this component owns      -->
<!-- only the dismissal behaviour and the scrim.                                 -->

<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		open,
		onclose,
		labelledBy,
		backdrop = "default",
		children,
	}: {
		open: boolean;
		/** Fires for every dismissal path: Escape, backdrop click, or close button. */
		onclose: () => void;
		/** id of the element naming this dialog, for screen readers. */
		labelledBy?: string;
		/** Scrim weight. `dark` for media, `subtle` for large panels that
		 *  should still show their context. */
		backdrop?: "default" | "dark" | "subtle";
		children: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	// showModal()/close() are imperative, so mirror `open` onto the element.
	// Both directions need the guard: showModal() on an already-open dialog throws.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	// Escape closes the dialog at the browser level without touching caller
	// state. Route it back through onclose, or the two drift apart and the
	// modal can never reopen.
	function handleCancel(e: Event): void {
		e.preventDefault();
		onclose();
	}

	// ::backdrop is not a child element — clicks on it report the <dialog> as
	// their target. This test only holds because the dialog has no padding or
	// border of its own; give it either and clicks on that edge read as
	// backdrop clicks.
	function handleClick(e: MouseEvent): void {
		if (e.target === dialogEl) onclose();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialogEl}
	aria-labelledby={labelledBy}
	data-backdrop={backdrop}
	class="m-auto max-w-[100vw] overflow-visible border-none bg-transparent p-0 text-text"
	oncancel={handleCancel}
	onclick={handleClick}
>
	{#if open}
		{@render children()}
	{/if}
</dialog>

<style>
	/* The UA stylesheet caps dialog width and sets overflow:auto, which squeezes
	   narrow screens and clips the content box's shadow. Undone via utilities
	   above; kept here as the reason. */

	/* Scrim lives here rather than on the caller: ::backdrop does not reliably
	   inherit custom properties across browsers, so these must be literal rules
	   on the dialog itself. */
	dialog::backdrop {
		background: rgba(var(--overlay-rgb), 0.5);
		backdrop-filter: blur(2px);
	}

	dialog[data-backdrop="dark"]::backdrop {
		background: rgb(0 0 0 / 85%);
		backdrop-filter: none;
	}

	dialog[data-backdrop="subtle"]::backdrop {
		background: rgba(var(--overlay-rgb), 0.15);
		backdrop-filter: blur(var(--blur-sm));
	}
</style>
