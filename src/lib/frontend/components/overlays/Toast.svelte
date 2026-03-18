<!--
  Toast — Auto-dismissing notification toasts, always mounted.
  Reads uiState.toasts from the ui store and renders each toast at the bottom center.
  Auto-dismiss is handled by the store's showToast() function via setTimeout,
  so this component only needs to render and animate.
-->
<script lang="ts">
  import { uiState } from "../../stores/ui.svelte.js";
</script>

{#each uiState.toasts as toast (toast.id)}
  <div
    class="fixed bottom-20 left-1/2 -translate-x-1/2 z-[400] px-4 py-2 rounded-lg text-sm font-medium shadow-lg pointer-events-auto animate-[slideUpFadeIn_200ms_ease-out_both] {toast.variant === 'warn'
      ? 'bg-warning-bg border border-warning text-warning'
      : 'bg-bg-alt border border-border text-text'}"
    role="status"
    aria-live="polite"
  >
    {toast.message}
  </div>
{/each}

<style>
  @keyframes slideUpFadeIn {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
</style>
