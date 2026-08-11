<!--
  Toast — Auto-dismissing notification toasts.
  Reads uiState.toasts and renders each toast as a card inside NotificationStack.
  Auto-dismiss is handled by the store's showToast() via setTimeout.
-->
<script lang="ts">
	import { uiState } from "../../stores/ui.svelte.js";
	import Icon from "../ui/Icon.svelte";
</script>

{#each uiState.toasts as toast (toast.id)}
	<div
		class="pointer-events-auto w-full px-4 py-2 rounded-lg text-sm font-medium shadow-lg notification-slide-in {toast.variant === 'warn'
			? 'bg-warning-bg border border-warning text-warning'
			: toast.variant === 'error'
				? 'flex items-center gap-2 bg-error-bg border border-error text-error'
				: 'bg-bg-alt border border-border text-text'}"
		role={toast.variant === "error" ? "alert" : "status"}
		aria-live={toast.variant === "error" ? "assertive" : "polite"}
	>
		{#if toast.variant === "error"}
			<span aria-hidden="true" class="shrink-0">
				<Icon name="circle-x" size={16} />
			</span>
			<span>{toast.message}</span>
		{:else}
			{toast.message}
		{/if}
	</div>
{/each}

<style>
	.notification-slide-in {
		animation: slideInRight 200ms ease-out both;
	}

	@keyframes slideInRight {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
