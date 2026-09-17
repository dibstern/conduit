<!--
  RewindBanner — Rewind mode banner + confirmation dialog.
  Shows a top banner when rewind mode is active, and a confirmation modal
  when a message UUID is selected. Supports three rewind modes: both,
  conversation only, files only.
-->
<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Radio from "../ui/Radio.svelte";
	import Modal from "./Modal.svelte";
	import {
		uiState,
		exitRewindMode,
		selectRewindMessage,
	} from "../../stores/ui.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { rewindSessionRpc } from "../../transport/ws-rpc-client.js";
	import Surface from "../ui/Surface.svelte";

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

		void rewindSessionRpc({
			projectSlug,
			sessionId,
			messageId: uuid,
		}).catch(() => undefined);
		onRewind?.(uuid, selectedMode);

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

<Modal open={showModal} onclose={handleCancel} labelledBy="rewind-modal-title">
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

			<!-- Radio options -->
			<div class="flex flex-col gap-2.5 mb-5">
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<Radio
						name="rewind-mode"
						value="both"
						checked={selectedMode === "both"}
						onchange={() => (selectedMode = "both")}
					/>
					<span>Both</span>
					<span class="text-xs text-text-muted"
						>(conversation + files)</span
					>
				</label>
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<Radio
						name="rewind-mode"
						value="conversation"
						checked={selectedMode === "conversation"}
						onchange={() => (selectedMode = "conversation")}
					/>
					<span>Conversation only</span>
				</label>
				<label
					class="flex items-center gap-2.5 text-sm text-text cursor-pointer"
				>
					<Radio
						name="rewind-mode"
						value="files"
						checked={selectedMode === "files"}
						onchange={() => (selectedMode = "files")}
					/>
					<span>Files only</span>
				</label>
			</div>

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
</Modal>

