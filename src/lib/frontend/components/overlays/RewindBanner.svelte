<!--
  RewindBanner — Rewind mode banner + confirmation dialog.
  Shows a top banner when rewind mode is active, and a confirmation modal
  when a message UUID is selected. Supports three rewind modes: both,
  conversation only, files only.
-->
<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import Modal from "./Modal.svelte";
	import {
		uiState,
		exitRewindMode,
		selectRewindMessage,
		showToast,
	} from "../../stores/ui.svelte.js";
	import {
		chatState,
		clearMessages,
		getOrCreateSessionSlot,
		setMessages,
		seedRegistryFromMessages,
	} from "../../stores/chat.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { rewindSessionRpc } from "../../transport/ws-rpc-client.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		onRewind,
	}: {
		onRewind?: (uuid: string, mode: string) => void;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let selectedMode: string = $state("both");

	// ─── Derived ────────────────────────────────────────────────────────────────

	const showBanner = $derived(uiState.rewindActive);
	const showModal = $derived(
		uiState.rewindActive && uiState.rewindSelectedUuid !== null,
	);

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleExit(): void {
		exitRewindMode();
	}

	function handleCancel(): void {
		selectRewindMessage(null);
		selectedMode = "both";
	}

	function handleConfirm(): void {
		const uuid = uiState.rewindSelectedUuid;
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!uuid || !sessionId || !projectSlug) return;
		const mode = selectedMode;
		const message = chatState.messages.find((message) => message.uuid === uuid);
		if (!message || !("messageId" in message) || !message.messageId) {
			exitRewindMode();
			selectedMode = "both";
			showToast("This message cannot be rewound to yet. Its provider ID is not available.", { variant: "warn" });
			return;
		}

		void rewindSessionRpc({
			projectSlug,
			sessionId,
			messageId: message.messageId,
		})
			.then((result) => {
				if (
					!result.ok ||
					sessionState.currentId !== result.sessionId ||
					getCurrentSlug() !== projectSlug
				) {
					return;
				}
				const targetIndex = chatState.messages.findIndex(
					(message) => message.uuid === uuid,
				);
				if (targetIndex < 0) {
					showToast("The transcript changed while rewinding. It has been kept; reload the session to sync with the provider.", { variant: "warn" });
					return;
				}
				const retained = chatState.messages.slice(0, targetIndex);
				clearMessages();
				const { activity, messages } = getOrCreateSessionSlot(result.sessionId);
				setMessages(messages, retained);
				seedRegistryFromMessages(activity, messages, retained);
				showToast(`Rewound ${mode === "both" ? "conversation & files" : mode}`);
				onRewind?.(uuid, mode);
			})
			.catch(() => {
				showToast("Could not rewind the conversation. The transcript has been kept.", { variant: "warn" });
			});

		exitRewindMode();
		selectedMode = "both";
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
		<button
			class="rewind-banner-exit flex items-center justify-center w-6 h-6 rounded bg-transparent border-none text-accent cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.06)]"
			title="Exit rewind mode"
			onclick={handleExit}
		>
			<Icon name="x" size={16} />
		</button>
	</div>
{/if}

<Modal open={showModal} onclose={handleCancel} labelledBy="rewind-modal-title">
		<div
			id="rewind-modal"
			class="modal-dialog bg-bg-alt border border-border rounded-xl py-5 px-6 max-w-80 w-[90vw] shadow-modal"
		>
			<h3 id="rewind-modal-title" class="text-sm font-semibold text-text mb-4">
				Rewind to this point?
			</h3>

			<!-- Radio options -->
			<div class="flex flex-col gap-2.5 mb-5">
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<input
						type="radio"
						name="rewind-mode"
						value="both"
						bind:group={selectedMode}
						class="rewind-radio accent-[var(--accent)]"
					/>
					<span>Both</span>
					<span class="text-xs text-text-muted"
						>(conversation + files)</span
					>
				</label>
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<input
						type="radio"
						name="rewind-mode"
						value="conversation"
						bind:group={selectedMode}
						class="rewind-radio accent-[var(--accent)]"
					/>
					<span>Conversation only</span>
				</label>
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<input
						type="radio"
						name="rewind-mode"
						value="files"
						bind:group={selectedMode}
						class="rewind-radio accent-[var(--accent)]"
					/>
					<span>Files only</span>
				</label>
			</div>

			<!-- Action buttons -->
			<div class="flex gap-2 justify-end">
				<button
					class="bg-transparent border border-border text-text-muted rounded-lg py-1.5 px-4 text-base cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.05)]"
					onclick={handleCancel}
				>
					Cancel
				</button>
				<button
					class="bg-accent border-none text-bg rounded-lg py-1.5 px-4 text-base font-medium cursor-pointer hover:bg-accent-hover"
					onclick={handleConfirm}
				>
					Rewind
				</button>
			</div>
		</div>
</Modal>
