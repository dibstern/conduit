<!--
  Rewind selection and confirmation. A rewind lands at once and the Head Log undoes it (82tn.51);
  it takes the files back too, or says why it cannot (82tn.53).
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
	import { sessionState } from "../../stores/session.svelte.js";
	import {
		branchIntoWorktree,
		planRewindFiles,
		rewindTo,
	} from "../../stores/head-moves.svelte.js";
	import Surface from "../ui/Surface.svelte";

	const showBanner = $derived(uiState.rewindActive);
	const showModal = $derived(
		showBanner && uiState.rewindSelectedUuid !== null,
	);

	const selectedMessageId = $derived.by(() => {
		const message = chatState.messages.find((message) => message.uuid === uiState.rewindSelectedUuid);
		return message && "messageId" in message ? message.messageId : undefined;
	});
	// 82tn.54: a branch keeps the conversation up to the last message before the one the rewind
	// goes back before (the first message of the picked message's Run), so it starts where the
	// rewind would land.
	const branchFromId = $derived.by(() => {
		const before = files && "before" in files ? files.before : undefined;
		const index = chatState.messages.findIndex(
			(message) => "messageId" in message && message.messageId === before,
		);
		return chatState.messages
			.slice(0, Math.max(index, 0))
			.flatMap((message) => ("messageId" in message && message.messageId ? [message.messageId] : []))
			.at(-1);
	});
	// 82tn.53: the rewind with files, previewed on open: its Restore Plan (the paths that change),
	// or why the files cannot go back. The conversation-only rewind stays open either way.
	let files = $state<
		| { paths: string[] }
		| { refused: string; branchable: boolean; before?: string }
		| undefined
	>();
	$effect(() => {
		const sessionId = sessionState.currentId;
		const messageId = selectedMessageId;
		files = undefined;
		if (!showModal || !sessionId || !messageId) return;
		let current = true;
		void planRewindFiles(sessionId, messageId).then((plan) => {
			if (current) files = plan;
		});
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

	function handleConfirm(withFiles: boolean): void {
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
		void rewindTo(sessionId, messageId, withFiles);
	}

	function handleBranch(): void {
		const sessionId = sessionState.currentId;
		const messageId = branchFromId;
		exitRewindMode();
		if (sessionId && messageId) branchIntoWorktree(sessionId, messageId);
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
		<div class="mb-5">
			<p id="rewind-files-status" role="status" class="mb-2 text-sm text-text-secondary">
				{files === undefined
					? "Checking the files…"
					: "refused" in files
						? files.refused
						: files.paths.length > 0
							? "With files, these change:"
							: "No files change."}
			</p>
			{#if files && "paths" in files && files.paths.length > 0}
				<ul
					aria-label="Files that change"
					class="max-h-40 overflow-y-auto font-mono text-xs text-text-secondary break-all"
				>
					{#each files.paths as path (path)}
						<li>{path}</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- Action buttons; they wrap on a phone. -->
		<div class="flex flex-wrap gap-2 justify-end">
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
				variant="secondary"
				size="content"
				class="rounded-lg py-1.5 px-4 text-base"
				onclick={() => handleConfirm(false)}
			>
				Conversation only
			</Button>
			{#if files && "refused" in files && files.branchable && branchFromId}
				<!-- 82tn.54: the files go back in a new worktree instead, leaving this folder alone. -->
				<Button
					variant="secondary"
					size="content"
					class="rounded-lg py-1.5 px-4 text-base"
					onclick={handleBranch}
				>
					Branch into a worktree
				</Button>
			{/if}
			<Button
				variant="primary"
				size="content"
				class="rounded-lg py-1.5 px-4 text-base font-medium"
				disabled={files === undefined || "refused" in files}
				aria-describedby={files && "refused" in files ? "rewind-files-status" : undefined}
				onclick={() => handleConfirm(true)}
			>
				Rewind conversation and files
			</Button>
		</div>
	</Surface>
</Dialog>
