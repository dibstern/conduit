<!--
  ConfirmModal — Promise-based confirmation dialog.
  Driven by uiState.confirmDialog from the ui store.
  Shows when confirmDialog is non-null; resolves true (action) or false (cancel).
-->
<script lang="ts">
  import { uiState, resolveConfirm } from "../../stores/ui.svelte.js";

  function handleCancel(): void {
    resolveConfirm(false);
  }

  function handleAction(): void {
    resolveConfirm(true);
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      resolveConfirm(false);
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      resolveConfirm(false);
    }
  }
</script>

<svelte:window onkeydown={uiState.confirmDialog ? handleKeydown : undefined} />

{#if uiState.confirmDialog}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    id="confirm-modal"
    class="modal-backdrop fixed inset-0 bg-[rgba(var(--overlay-rgb),0.5)] backdrop-blur-[2px] flex items-center justify-center z-[300] transition-opacity duration-200 ease-linear"
    onclick={handleBackdropClick}
  >
    <div
      class="modal-dialog bg-bg-alt border border-border rounded-xl py-5 px-6 max-w-80 w-[90%] shadow-[0_8px_32px_rgba(var(--shadow-rgb),0.4)]"
    >
      <p class="text-sm text-text leading-normal mb-4">
        {uiState.confirmDialog.text}
      </p>
      <div class="flex gap-2 justify-end">
        <button
          class="bg-transparent border border-border text-text-muted rounded-lg py-1.5 px-4 text-base cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.05)]"
          onclick={handleCancel}
        >
          Cancel
        </button>
        <button
          class="bg-accent border-none text-bg rounded-lg py-1.5 px-4 text-base font-medium cursor-pointer hover:bg-accent-hover"
          onclick={handleAction}
        >
          {uiState.confirmDialog.actionLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
