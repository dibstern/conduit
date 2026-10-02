<!--
  ConfirmModal — Promise-based confirmation dialog.
  Driven by uiState.confirmDialog from the ui store.
  Shows when confirmDialog is non-null; resolves true (action) or false (cancel).
-->
<script lang="ts">
  import { uiState, resolveConfirm } from "../../stores/ui.svelte.js";
  import Button from "../ui/Button.svelte";
  import Surface from "../ui/Surface.svelte";
  import Dialog from "../ui/Dialog.svelte";
	let returnFocus = $state<(() => HTMLElement | null) | undefined>();
	$effect(() => {
		if (uiState.confirmDialog) returnFocus = uiState.confirmDialog.returnFocus;
	});

  function handleCancel(): void {
    resolveConfirm(false);
  }

  function handleAction(): void {
    resolveConfirm(true);
  }

  // Enter confirms while focus rests on the dialog itself (where Dialog puts
  // it). A focused button keeps its own Enter, and the keystroke that opened
  // the dialog never counts: its target is the opener, not the dialog.
  function handleKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (event.key !== "Enter" || event.isComposing) return;
    if (!(target instanceof HTMLDialogElement) || !target.querySelector("#confirm-modal")) return;
    event.preventDefault();
    handleAction();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog
  open={uiState.confirmDialog !== null}
  onclose={handleCancel}
  {returnFocus}
  labelledBy="confirm-modal-text"
>
  <Surface
    variant="raised"
    radius="lg"
    elevation="modal"
    id="confirm-modal"
    class="modal-dialog py-5 px-6 max-w-80 w-[90vw]"
  >
    <p id="confirm-modal-text" class="text-sm text-text leading-normal mb-4">
      {uiState.confirmDialog?.text}
    </p>
    <div class="flex gap-2 justify-end">
      <Button
        variant="secondary"
        tone="muted"
        size="content"
        data-testid="confirm-modal-cancel"
        class="rounded-lg py-1.5 px-4 text-base"
        onclick={handleCancel}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        size="content"
        data-testid="confirm-modal-action"
        class="rounded-lg py-1.5 px-4 text-base font-medium"
        onclick={handleAction}
      >
        {uiState.confirmDialog?.actionLabel}
      </Button>
    </div>
  </Surface>
</Dialog>
