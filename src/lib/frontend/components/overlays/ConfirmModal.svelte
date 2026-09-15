<!--
  ConfirmModal — Promise-based confirmation dialog.
  Driven by uiState.confirmDialog from the ui store.
  Shows when confirmDialog is non-null; resolves true (action) or false (cancel).
-->
<script lang="ts">
  import { uiState, resolveConfirm } from "../../stores/ui.svelte.js";
  import Modal from "./Modal.svelte";

  function handleCancel(): void {
    resolveConfirm(false);
  }

  function handleAction(): void {
    resolveConfirm(true);
  }
</script>

<Modal
  open={uiState.confirmDialog !== null}
  onclose={handleCancel}
  labelledBy="confirm-modal-text"
>
  <div
    id="confirm-modal"
    class="modal-dialog bg-bg-alt border border-border rounded-xl py-5 px-6 max-w-80 w-[90vw] shadow-modal"
  >
    <p id="confirm-modal-text" class="text-sm text-text leading-normal mb-4">
      {uiState.confirmDialog?.text}
    </p>
    <div class="flex gap-2 justify-end">
      <button
        data-testid="confirm-modal-cancel"
        class="bg-transparent border border-border text-text-muted rounded-lg py-1.5 px-4 text-base cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.05)]"
        onclick={handleCancel}
      >
        Cancel
      </button>
      <button
        data-testid="confirm-modal-action"
        class="bg-accent border-none text-bg rounded-lg py-1.5 px-4 text-base font-medium cursor-pointer hover:bg-accent-hover"
        onclick={handleAction}
      >
        {uiState.confirmDialog?.actionLabel}
      </button>
    </div>
  </div>
</Modal>
