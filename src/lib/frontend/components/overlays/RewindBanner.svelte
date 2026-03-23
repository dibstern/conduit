<!--
  RewindBanner — Rewind mode banner + confirmation dialog.
  Shows a top banner when rewind mode is active, and a confirmation modal
  when a message UUID is selected. Supports three rewind modes: both,
  conversation only, files only.
-->
<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import {
		uiState,
		exitRewindMode,
		selectRewindMessage,
	} from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

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
		if (!uuid) return;

		wsSend({ type: "rewind", uuid, mode: selectedMode });
		onRewind?.(uuid, selectedMode);

		exitRewindMode();
		selectedMode = "both";
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) {
			handleCancel();
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			if (showModal) {
				handleCancel();
			} else if (showBanner) {
				handleExit();
			}
		}
	}
</script>

<svelte:window onkeydown={showBanner ? handleKeydown : undefined} />

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

{#if showModal}
	<!-- Rewind confirmation modal -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal-backdrop fixed inset-0 bg-[rgba(var(--overlay-rgb),0.5)] backdrop-blur-[2px] flex items-center justify-center z-[300] transition-opacity duration-200 ease-linear"
		onclick={handleBackdropClick}
	>
		<div
			class="modal-dialog bg-bg-alt border border-border rounded-xl py-5 px-6 max-w-80 w-[90%] shadow-[0_8px_32px_rgba(var(--shadow-rgb),0.4)]"
		>
			<h3 class="text-sm font-semibold text-text mb-4">
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
	</div>
{/if}
