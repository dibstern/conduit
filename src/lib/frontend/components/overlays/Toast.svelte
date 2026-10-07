<!--
  Toast — auto-dismissing notification cards (design 05, "Suggestion toast").
  Reads uiState.toasts. Auto-dismiss is handled by the store's showToast().

  Desktop: a stack of raised cards anchored bottom-right, clear of the session
  bar's controls. Phone: one full-width sheet along the bottom edge, its
  toasts divided by hairlines.

  Each card is a bold title, an optional body line with one emphasised term,
  and an action row: primary and secondary actions in order from the left,
  any dismiss action pushed to the right. Every action closes its toast.
  The variant is an accent (an icon beside the title) and decides the live
  region, never the fill.
-->
<script lang="ts">
	import type { Toast, ToastAction } from "../../types.js";
	import { dismissToast, uiState } from "../../stores/ui.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";

	const VARIANT_ICON = {
		default: undefined,
		warn: { name: "triangle-alert", class: "text-warning" },
		error: { name: "circle-x", class: "text-error" },
	} as const;

	function act(toast: Toast, action: ToastAction): void {
		try {
			action.run?.();
		} finally {
			dismissToast(toast.id);
		}
	}
</script>

{#if uiState.toasts.length > 0}
	<div
		class="pointer-events-none fixed z-[var(--z-toast)] flex flex-col max-md:pointer-events-auto max-md:inset-x-0 max-md:bottom-0 max-md:divide-y max-md:divide-border-subtle max-md:rounded-t-[18px] max-md:border-t max-md:border-border max-md:bg-bg-alt max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-modal md:right-[14px] md:bottom-[14px] md:w-[310px] md:gap-2"
	>
		{#each uiState.toasts as toast (toast.id)}
			{@const icon = VARIANT_ICON[toast.variant]}
			{@const at = toast.body && toast.emphasis ? toast.body.indexOf(toast.emphasis) : -1}
			{@const actions = [
				...toast.actions.filter((action) => action.kind !== "dismiss"),
				...toast.actions.filter((action) => action.kind === "dismiss"),
			]}
			<div
				class="toast-card pointer-events-auto px-[16px] py-[12px] text-sm text-text-secondary md:rounded-[12px] md:border md:border-border md:bg-bg-alt md:p-[12px] md:shadow-modal"
				data-variant={toast.variant}
				role={toast.variant === "error" ? "alert" : "status"}
				aria-live={toast.variant === "error" ? "assertive" : "polite"}
			>
				<div class="flex items-start gap-[6px] text-base leading-snug font-semibold text-text">
					{#if icon}
						<span aria-hidden="true" class="mt-[2px] shrink-0 {icon.class}">
							<Icon name={icon.name} size={14} />
						</span>
					{/if}
					<span class="min-w-0 break-words">{toast.title}</span>
				</div>
				{#if toast.body}
					<p class="mt-[4px] leading-snug break-words">
						{#if toast.emphasis && at >= 0}
							{toast.body.slice(0, at)}<b class="font-semibold text-brand-b">{toast.emphasis}</b>{toast.body.slice(at + toast.emphasis.length)}
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
