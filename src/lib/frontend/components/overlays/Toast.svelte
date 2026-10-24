<!--
  Toast — auto-dismissing notification cards (design 05, "Suggestion toast").
  Reads uiState.toasts. Auto-dismiss is handled by the store's showToast().

  Desktop: a stack of raised cards anchored bottom-right. Phone: one
  full-width sheet, its toasts divided by hairlines. Both sit on top of the
  composer, never over it: InputArea publishes --composer-clearance, which is
  0 wherever no composer is mounted. The phone sheet publishes --toast-clearance
  to lift the New session FAB. The store dedupes identical cards unless they
  carry primary or secondary actions, and keeps two at most; newest on top.

  Each card is a bold title, an optional body line with one emphasised term,
  and an action row: primary and secondary actions in order from the left,
  any dismiss action pushed to the right. Every action closes its toast, as
  do the close button and a downward swipe.
  The variant is an accent (an icon beside the title) and decides the live
  region, never the fill.
-->
<script lang="ts">
	import type { Attachment } from "svelte/attachments";
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
	} as const;

	const SWIPE_DISMISS_PX = 48;

	function publishToastClearance(sheet: HTMLElement) {
		const root = document.documentElement;
		const phone = window.matchMedia("(max-width: 767.98px)");
		const publish = () => {
			root.style.setProperty("--toast-clearance", `${phone.matches ? sheet.offsetHeight : 0}px`);
		};
		const observer = new ResizeObserver(publish);
		observer.observe(sheet);
		phone.addEventListener("change", publish);
		publish();
		return () => {
			observer.disconnect();
			phone.removeEventListener("change", publish);
			root.style.removeProperty("--toast-clearance");
		};
	}

	// `translate`, not `transform`: the entry animation fills `both`, and an
	// animated transform would override the inline one for the card's lifetime.
	function swipeDownToDismiss(id: string): Attachment<HTMLElement> {
		return (card) => {
			let startY: number | null = null;
			const settle = (dy: number) => {
				startY = null;
				card.style.transition = "translate 150ms ease-out, opacity 150ms ease-out";
				card.style.translate = "";
				card.style.opacity = "";
				if (dy >= SWIPE_DISMISS_PX) dismissToast(id);
			};
			const down = (event: PointerEvent) => {
				if (event.button !== 0 || (event.target as Element).closest("button")) return;
				startY = event.clientY;
				card.setPointerCapture(event.pointerId);
				card.style.transition = "none";
			};
			const move = (event: PointerEvent) => {
				if (startY === null) return;
				const dy = Math.max(0, event.clientY - startY);
				card.style.translate = `0 ${dy}px`;
				card.style.opacity = String(1 - Math.min(dy / (SWIPE_DISMISS_PX * 3), 0.6));
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

{#if uiState.toasts.length > 0 && uiState.sheetToastHost === null}
	<div
		{@attach publishToastClearance}
		class="pointer-events-none fixed z-[var(--z-toast)] flex flex-col max-md:pointer-events-auto max-md:inset-x-0 max-md:bottom-[var(--composer-clearance,0px)] max-md:divide-y max-md:divide-border-subtle max-md:rounded-t-[18px] max-md:border-t max-md:border-border max-md:bg-bg-alt max-md:pb-[max(0px,calc(env(safe-area-inset-bottom)_-_var(--composer-clearance,0px)))] max-md:shadow-modal md:right-[14px] md:bottom-[calc(var(--composer-clearance,0px)+14px)] md:w-[310px] md:gap-2"
	>
		{#each [...uiState.toasts].reverse() as toast (toast.id)}
			{@const icon = VARIANT_ICON[toast.variant]}
			{@const at = toast.body && toast.emphasis ? toast.body.indexOf(toast.emphasis) : -1}
			{@const actions = [
				...toast.actions.filter((action) => action.kind !== "dismiss"),
				...toast.actions.filter((action) => action.kind === "dismiss"),
			]}
			<div
				class="toast-card pointer-events-auto touch-none px-[16px] py-[12px] font-sans text-sm text-text-secondary md:rounded-[12px] md:border md:border-border md:bg-bg-alt md:p-[12px] md:shadow-modal"
				data-variant={toast.variant}
				role={toast.variant === "error" ? "alert" : "status"}
				aria-live={toast.variant === "error" ? "assertive" : "polite"}
				data-testid="toast"
				{@attach swipeDownToDismiss(toast.id)}
			>
				<div class="flex items-start gap-[6px] text-base leading-snug font-semibold text-text">
					{#if icon}
						<span aria-hidden="true" class="mt-[2px] shrink-0 {icon.class}">
							<Icon name={icon.name} size={14} />
						</span>
					{/if}
					<span class="min-w-0 break-words">{toast.title}</span>
					<Button
						variant="toolbar"
						size="content"
						touchTarget
						class="-mr-[4px] ml-auto h-[18px] w-[18px] shrink-0 rounded-full"
						iconOnly
						icon="x"
						iconSize={12}
						title="Dismiss"
						ariaLabel="Dismiss notification"
						data-testid="toast-close"
						onclick={() => dismissToast(toast.id)}
					/>
				</div>
				{#if toast.body}
					<p class="mt-[4px] leading-snug break-words">
						{#if toast.emphasis && at >= 0}
							{toast.body.slice(0, at)}<b class="font-semibold text-success">{toast.emphasis}</b>{toast.body.slice(at + toast.emphasis.length)}
						{:else}
							{toast.body}
						{/if}
					</p>
				{/if}
				{#if actions.length > 0}
					<div class="mt-[10px] flex flex-wrap items-center gap-[6px]">
						{#each actions as action (action)}
							<Button
								{...action.kind === "primary"
									? { variant: "inverse" }
									: { variant: "secondary", tone: "secondary" }}
								size="content"
								class="h-[24px] shrink-0 rounded-[8px] px-[10px] text-sm max-md:h-[32px] max-md:px-[12px] {action.kind === 'primary'
									? 'font-semibold'
									: 'font-medium'} {action.kind === 'dismiss' ? 'ml-auto' : ''}"
								data-testid="toast-action"
								data-kind={action.kind}
								onclick={() => act(toast, action)}
							>{action.label}</Button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-card {
		animation: toastIn 200ms ease-out both;
	}

	/* Cards slide in from the edge they are anchored to: the right on
	   desktop, the bottom for the phone sheet. */
	@keyframes toastIn {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@media (max-width: 767.98px) {
		.toast-card {
			animation-name: toastUp;
		}
	}

	@keyframes toastUp {
		from {
			opacity: 0;
			transform: translateY(16px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
