<!--
  Toast — auto-dismissing notification cards (design 05, "Suggestion toast").
  Reads uiState.toasts. Auto-dismiss is handled by the store's showToast().

  One floating layer anchored to the top on every viewport, above sheets,
  scrims and the composer, so nothing else has to make room for it. Phone:
  an inset card below the session bar's first row. Desktop: a 400px card
  centred under the top bar. The store dedupes identical cards unless they
  carry primary or secondary actions, and keeps two at most; newest on top.

  A card with no body and at most one action is a single row: icon, title,
  inline action, close. Anything else stacks a title row, the body with one
  emphasised term, and an action row: primary and secondary actions in
  order from the left, any dismiss action pushed to the right. Every action
  closes its toast, as do the close button and an upward swipe.
  The variant is an accent (an icon beside the title) and decides the live
  region, never the fill.
-->
<script lang="ts">
	import type { Attachment } from "svelte/attachments";
	import { flip } from "svelte/animate";
	import { quintOut } from "svelte/easing";
	import { prefersReducedMotion } from "svelte/motion";
	import type { Toast, ToastAction } from "../../types.js";
	import { dismissToast, uiState } from "../../stores/ui.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";

	const VARIANT_ICON = {
		default: undefined,
		success: { name: "check", class: "text-success" },
		warn: { name: "triangle-alert", class: "text-warning" },
		error: { name: "circle-x", class: "text-error" },
		pinned: { name: "pin", class: "text-status-pinned" },
		attention: undefined,
	} as const;

	const SWIPE_DISMISS_PX = 48;

	function drop(_node: Element, { y, scale, duration }: { y: number; scale: number; duration: number }) {
		const still = prefersReducedMotion.current;
		return {
			duration,
			easing: quintOut,
			css: (t: number) =>
				still
					? `opacity: ${t}`
					: `opacity: ${t}; transform: translateY(${(1 - t) * y}px) scale(${scale + (1 - scale) * t})`,
		};
	}

	// `translate`, not `transform`: the enter, exit and reflow animations drive
	// transform, and would override an inline one while they run.
	function swipeUpToDismiss(id: string): Attachment<HTMLElement> {
		return (card) => {
			let startY: number | null = null;
			const settle = (dy: number) => {
				startY = null;
				card.style.transition = "translate 150ms ease-out, opacity 150ms ease-out";
				card.style.translate = "";
				card.style.opacity = "";
				if (dy <= -SWIPE_DISMISS_PX) dismissToast(id);
			};
			const down = (event: PointerEvent) => {
				if (event.button !== 0 || (event.target as Element).closest("button")) return;
				startY = event.clientY;
				card.setPointerCapture(event.pointerId);
				card.style.transition = "none";
			};
			const move = (event: PointerEvent) => {
				if (startY === null) return;
				const dy = Math.min(0, event.clientY - startY);
				card.style.translate = `0 ${dy}px`;
				card.style.opacity = String(1 - Math.min(-dy / (SWIPE_DISMISS_PX * 3), 0.6));
			};
			const up = (event: PointerEvent) => {
				if (startY !== null) settle(event.clientY - startY);
			};
			const cancel = () => settle(0);
			card.addEventListener("pointerdown", down);
			card.addEventListener("pointermove", move);
			card.addEventListener("pointerup", up);
			card.addEventListener("pointercancel", cancel);
			return () => {
				card.removeEventListener("pointerdown", down);
				card.removeEventListener("pointermove", move);
				card.removeEventListener("pointerup", up);
				card.removeEventListener("pointercancel", cancel);
			};
		};
	}

	function act(toast: Toast, action: ToastAction): void {
		try {
			action.run?.();
		} finally {
			dismissToast(toast.id);
		}
	}
</script>

<!-- Always mounted, so a closing card has a parent to play its exit in. The
     top offsets are fixed constants, never measured: below the phone session
     bar's 42px first row (or its 52px collapsed island), and 8px below the
     52px desktop top bar. -->
<div
	data-toast-layer
	class="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+56px)] z-[var(--z-toast)] mx-auto flex max-w-[416px] flex-col gap-[6px] px-[8px] md:top-[60px]"
>
	{#each [...uiState.toasts].reverse() as toast (toast.id)}
		{@const icon = VARIANT_ICON[toast.variant]}
		{@const at = toast.body && toast.emphasis ? toast.body.indexOf(toast.emphasis) : -1}
		{@const actions = [
			...toast.actions.filter((action) => action.kind !== "dismiss"),
			...toast.actions.filter((action) => action.kind === "dismiss"),
		]}
		{@const compact = !toast.body && actions.length <= 1}
		<div
			class="pointer-events-auto touch-none rounded-[14px] bg-popover-bg font-sans text-sm text-text-secondary shadow-toast {compact
				? 'flex items-center gap-[8px] py-[8px] pr-[8px] pl-[14px]'
				: 'pt-[11px] pr-[12px] pb-[12px] pl-[14px]'}"
			data-variant={toast.variant}
			role={toast.variant === "error" ? "alert" : "status"}
			aria-live={toast.variant === "error" ? "assertive" : "polite"}
			data-testid="toast"
			{@attach swipeUpToDismiss(toast.id)}
			animate:flip={{ duration: prefersReducedMotion.current ? 0 : 260, easing: quintOut }}
			in:drop={{ y: -14, scale: 0.98, duration: 240 }}
			out:drop={{ y: -8, scale: 0.97, duration: 160 }}
		>
			{#snippet close()}
				<Button
					variant="toolbar"
					size="content"
					touchTarget
					class="ml-auto h-[22px] w-[22px] shrink-0 rounded-full"
					iconOnly
					icon="x"
					iconSize={13}
					title="Dismiss"
					ariaLabel="Dismiss notification"
					data-testid="toast-close"
					onclick={() => dismissToast(toast.id)}
				/>
			{/snippet}
			{#snippet actionButton(action: ToastAction)}
				<Button
					{...action.kind === "primary"
						? { variant: "inverse" }
						: { variant: "secondary", tone: "secondary" }}
					size="content"
					class="h-[28px] shrink-0 rounded-[8px] px-[12px] text-base {action.kind === 'primary'
						? 'font-semibold'
						: 'font-medium'} {action.kind === 'dismiss' && !compact ? 'ml-auto' : ''}"
					data-testid="toast-action"
					data-kind={action.kind}
					onclick={() => act(toast, action)}
				>{action.label}</Button>
			{/snippet}
			<div class="flex min-w-0 items-center gap-[9px] text-base leading-snug font-semibold text-text {compact ? 'flex-1' : ''}">
				{#if toast.variant === "attention"}
					<span aria-hidden="true" class="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
						<span class="h-[7px] w-[7px] rounded-full bg-fill-ask"></span>
					</span>
				{:else if icon}
					<span aria-hidden="true" class="shrink-0 {icon.class}">
						<Icon name={icon.name} size={14} />
					</span>
				{/if}
				<span class="min-w-0 {compact ? 'truncate' : 'break-words'}">{toast.title}</span>
				{#if !compact}{@render close()}{/if}
			</div>
			{#if compact}
				{#each actions as action (action)}{@render actionButton(action)}{/each}
				{@render close()}
			{:else}
				{#if toast.body}
					<p class="mt-[3px] leading-snug break-words {icon || toast.variant === 'attention' ? 'pl-[23px]' : ''}">
						{#if toast.emphasis && at >= 0}
							{toast.body.slice(0, at)}<b class="font-semibold text-success">{toast.emphasis}</b>{toast.body.slice(at + toast.emphasis.length)}
						{:else}
							{toast.body}
						{/if}
					</p>
				{/if}
				{#if actions.length > 0}
					<div class="mt-[10px] flex flex-wrap items-center gap-[6px] {icon || toast.variant === 'attention' ? 'pl-[23px]' : ''}">
						{#each actions as action (action)}{@render actionButton(action)}{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/each}
</div>
