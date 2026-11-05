<!--
  Rewind selection and confirmation. A rewind lands at once and the Head Log undoes it (82tn.51).
-->
<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import {
		uiState,
		exitRewindMode,
		selectRewindMessage,
		showToast,
	} from "../../stores/ui.svelte.js";
	import { chatState } from "../../stores/chat.svelte.js";
	import { getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { rewindTo } from "../../stores/head-moves.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import Surface from "../ui/Surface.svelte";

	const restoresFiles = $derived(
		sessionState.currentId !== null
			? getDriverTraits(getAvailableInstances().find((instance) => instance.id === findSession(sessionState.currentId ?? "")?.accountId)?.driver)?.supportsFileRewind ?? true
			: true,
	);
	const showBanner = $derived(uiState.rewindActive);
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
		const sessionId = sessionState.currentId;
		const messageId = selectedMessageId;
		if (!uiState.rewindSelectedUuid || !sessionId) return;
		exitRewindMode();
		if (!messageId) {
			showToast(
				"This message cannot be rewound to yet. Its provider ID is not available.",
				{ variant: "warn" },
			);
			return;
		}
		// A head move like the transcript's (82tn.51): it lands at once and the Head Log undoes it.
		void rewindTo(sessionId, messageId);
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
			This message and everything after it will be removed. Every move can be undone from the Head Log.
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
