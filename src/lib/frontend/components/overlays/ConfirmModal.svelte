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
	import Radio from "../ui/Radio.svelte";
	let returnFocus = $state<(() => HTMLElement | null) | undefined>();
	const worktreeChoice = $derived(uiState.confirmDialog?.worktreeChoice);
	$effect(() => {
		if (uiState.confirmDialog) returnFocus = uiState.confirmDialog.returnFocus;
	});

  function handleCancel(): void {
    resolveConfirm(false);
  }

  function handleAction(): void {
    resolveConfirm(true);
  }

	function chooseWorktrees(removeWorktrees: boolean): void {
		if (!worktreeChoice) return;
		worktreeChoice.removeWorktrees = removeWorktrees;
		worktreeChoice.onchange?.(removeWorktrees);
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
    class="modal-dialog py-5 px-6 w-[90vw] {worktreeChoice ? 'max-w-lg max-h-[85dvh] overflow-y-auto' : 'max-w-80'}"
  >
    <p id="confirm-modal-text" class="text-sm text-text leading-normal mb-4">
      {uiState.confirmDialog?.text}
    </p>
		{#if worktreeChoice}
			<ul aria-label="Session worktrees" class="space-y-3 mb-4 text-sm">
				{#each worktreeChoice.worktrees as worktree}
					<li>
						<p class="text-text font-medium break-all">{worktree.folder}</p>
						<p class="text-text-muted text-xs break-all">{worktree.path}</p>
						{#if worktree.inUse}
							<p class="text-text-muted mt-1">Kept because another session uses this worktree.</p>
						{/if}
						{#each worktree.reasons as reason}
							<p class="text-text-muted mt-1">{reason}</p>
						{/each}
						{#if !worktree.inUse && worktree.reasons.length === 0}
							<p class="text-text-muted mt-1">No unfinished work found.</p>
						{/if}
					</li>
				{/each}
			</ul>
			<fieldset class="mb-4 text-sm text-text">
				<legend class="font-medium mb-2">Worktrees</legend>
				<div class="flex flex-wrap gap-4">
					<label class="flex items-center gap-2">
						<Radio name="session-delete-worktrees" checked={!worktreeChoice.removeWorktrees} onchange={() => chooseWorktrees(false)} />
						Keep worktrees
					</label>
					<label class="flex items-center gap-2">
						<Radio name="session-delete-worktrees" checked={worktreeChoice.removeWorktrees} disabled={worktreeChoice.worktrees.every((worktree) => worktree.inUse)} onchange={() => chooseWorktrees(true)} />
						Remove worktrees
					</label>
				</div>
				<p class="text-xs text-text-muted mt-2">Worktrees still in use or with uncommitted changes will be kept.</p>
			</fieldset>
		{/if}
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
