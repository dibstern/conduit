<!--
  Rewind selection and confirmation, or the pending rewind notice at the composer.
-->
<script lang="ts">
	import { selection } from "../../stores/selection.svelte.js";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import {
		uiState,
		exitRewindMode,
		selectRewindMessage,
		showToast,
	} from "../../stores/ui.svelte.js";
	import { chatState, currentChat } from "../../stores/chat.svelte.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import Surface from "../ui/Surface.svelte";

	let {
		pendingOnly = false,
		onRewind,
	}: {
		pendingOnly?: boolean;
		onRewind?: (uuid: string, mode: string) => void;
	} = $props();

	let undoing = $state(false);

	const pendingMessageId = $derived(
		currentChat().transcript?.pendingRewindMessageId ?? null,
	);
	const restoresFiles = $derived(
		!pendingOnly && sessionState.currentId !== null
			? getDriverTraits(getAvailableInstances().find((instance) => instance.id === findSession(sessionState.currentId ?? "")?.accountId)?.driver)?.supportsFileRewind ?? true
			: true,
	);
	const showBanner = $derived(!pendingOnly && uiState.rewindActive);
	const showModal = $derived(
		showBanner && uiState.rewindSelectedUuid !== null,
	);

	const selectedMessageId = $derived.by(() => {
		const message = chatState.messages.find((message) => message.uuid === uiState.rewindSelectedUuid);
		return message && "messageId" in message ? message.messageId : undefined;
	});
	// Rewind moves only the conversation, so a pruned point stays a valid target.
	let filesPruned = $state(false);
	$effect(() => {
		const sessionId = sessionState.currentId;
		const messageId = selectedMessageId;
		filesPruned = false;
		if (!showModal || !sessionId || !messageId) return;
		let current = true;
		rpc("GetHeadMoveFiles", { sessionId, messageId })
			.then(({ files }) => {
				if (current) filesPruned = files === "pruned";
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	});

	function handleExit(): void {
		exitRewindMode();
	}

	function handleCancel(): void {
		selectRewindMessage(null);
	}

	function handleConfirm(): void {
		const uuid = uiState.rewindSelectedUuid;
		const sessionId = sessionState.currentId;
		const projectSlug = selection.scope?.project;
		if (!uuid || !sessionId || !projectSlug) return;
		const mode = restoresFiles ? "both" : "conversation";
		const message = chatState.messages.find((message) => message.uuid === uuid);
		if (!message || !("messageId" in message) || !message.messageId) {
			exitRewindMode();
			showToast(
				"This message cannot be rewound to yet. Its provider ID is not available.",
				{ variant: "warn" },
			);
			return;
		}

		void rpc("RewindSession", {
			sessionId,
			messageId: message.messageId,
		})
			.then((result) => {
				if (
					!result.ok ||
					sessionState.currentId !== result.sessionId ||
					selection.scope?.project !== projectSlug
				) {
					return;
				}
				onRewind?.(uuid, mode);
			})
			.catch((error) => {
				if (sessionState.currentId === sessionId && selection.scope?.project === projectSlug)
					toastFailure("Could not rewind the conversation.", "warn")(error);
			});

		exitRewindMode();
	}

	async function handleUndo(): Promise<void> {
		const sessionId = sessionState.currentId;
		const projectSlug = selection.scope?.project;
		if (!pendingMessageId || !sessionId || !projectSlug || undoing) return;
		undoing = true;
		try {
			await rpc("UndoRewind", { sessionId });
		} catch (error) {
			if (sessionState.currentId === sessionId && selection.scope?.project === projectSlug)
				toastFailure("Could not undo the rewind.", "warn")(error);
		} finally {
			undoing = false;
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			handleExit();
		}
	}
</script>

<svelte:window onkeydown={showBanner && !showModal ? handleKeydown : undefined} />

{#if showBanner}
	<!-- Rewind mode banner -->
	<div
		class="rewind-banner flex items-center justify-between gap-3 px-4 py-2.5 bg-accent-bg border-b border-[rgba(var(--overlay-rgb),0.15)] text-accent text-sm font-medium"
	>
		<span class="rewind-banner-text">Select a message to rewind to</span>
		<Button
			iconOnly
			icon="x"
			ariaLabel="Exit rewind mode"
			variant="ghost-accent"
			size="content"
			class="rewind-banner-exit w-6 h-6 rounded"
			title="Exit rewind mode"
			onclick={handleExit}
		/>
	</div>
{/if}

{#if pendingOnly && pendingMessageId}
	<div
		class="rewind-pending flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-accent-bg px-4 py-2.5 text-sm text-accent"
		data-testid="rewind-pending"
	>
		<span role="status">Rewound. Sending your next message makes it permanent.</span>
		<Button
			variant="ghost-accent"
			size="sm"
			loading={undoing}
			onclick={handleUndo}
			data-testid="undo-rewind"
		>
			Undo
		</Button>
	</div>
{/if}

{#if !pendingOnly}
	<Dialog open={showModal} onclose={handleCancel} labelledBy="rewind-modal-title">
		<Surface
			variant="raised"
			radius="lg"
			elevation="modal"
			id="rewind-modal"
			class="modal-dialog py-5 px-6 max-w-80 w-[90vw]"
		>
			<h3 id="rewind-modal-title" class="text-sm font-semibold text-text mb-4">
				Rewind to this point?
			</h3>

			<p class="mb-3 text-sm text-text-secondary">
				This message and everything after it will be removed. You can undo until you send your next message.
			</p>
			<p class="mb-5 text-sm text-text-secondary">
				{filesPruned
					? "Files from this point were pruned."
					: restoresFiles
						? "Files are restored to this point."
						: "Files are not restored."}
			</p>

			<!-- Action buttons -->
			<div class="flex gap-2 justify-end">
				<Button
					variant="secondary"
					tone="muted"
					size="content"
					class="rounded-lg py-1.5 px-4 text-base"
					onclick={handleCancel}
				>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="content"
					class="rounded-lg py-1.5 px-4 text-base font-medium"
					onclick={handleConfirm}
				>
					Rewind
				</Button>
			</div>
		</Surface>
	</Dialog>
{/if}
