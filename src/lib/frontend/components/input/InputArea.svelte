<!-- ─── Input Area ──────────────────────────────────────────────────────────── -->
<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script lang="ts">
	import { untrack } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import AgentSelector from "../model/AgentSelector.svelte";
	import AttachMenu from "./AttachMenu.svelte";
	// biome-ignore lint/style/useImportType: CommandMenu is used as a value for bind:this
	import CommandMenu from "./CommandMenu.svelte";
	import ContextBar from "./ContextBar.svelte";
	// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
	import FileMenu from "./FileMenu.svelte";
	import ModelSelector from "../model/ModelSelector.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import { addUserMessage, inputSyncState, isProcessing } from "../../stores/chat.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { extractAtQuery, fileTreeState, filterFiles } from "../../stores/file-tree.svelte.js";
	import { fetchFileContent, fetchDirectoryListing, resizeImageIfNeeded } from "./input-utils.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import type { PendingImage } from "../../types.js";

	// ─── State ─────────────────────────────────────────────────────────────────

	let inputText = $state("");
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let attachMenuOpen = $state(false);
	let pendingImages = $state<PendingImage[]>([]);
	let commandMenuRef: CommandMenu | undefined = $state();
	let fileMenuRef: FileMenu | undefined = $state();
	let subagentBackBarRef: SubagentBackBar | undefined = $state();
	let cursorPos = $state(0);

	// ─── Per-session input drafts ─────────────────────────────────────────────
	// Each session keeps its own unsent input text. Switching sessions saves the
	// current draft and restores the target session's draft (or empty string).

	const inputDrafts = new Map<string, string>();
	let previousSessionId: string | null = null;

	$effect(() => {
		const currentId = sessionState.currentId;
		untrack(() => {
			if (currentId !== previousSessionId) {
				// Save draft for the session we're leaving
				if (previousSessionId) {
					inputDrafts.set(previousSessionId, inputText);
				}
				// Restore draft for the session we're entering
				inputText = inputDrafts.get(currentId ?? "") ?? "";
				previousSessionId = currentId;
				// Cancel any pending outgoing sync from the previous session
				if (inputSyncTimer) {
					clearTimeout(inputSyncTimer);
					inputSyncTimer = null;
				}
				// Resize textarea to fit restored content
				requestAnimationFrame(() => autoResize());
			}
		});
	});

	// ─── Input sync (cross-tab) ───────────────────────────────────────────────

	/** Track which sync we last applied to avoid re-applying our own. */
	let lastSyncApplied = 0;

	/** Receive input sync from another tab viewing the same session. */
	$effect(() => {
		if (inputSyncState.lastUpdated > lastSyncApplied) {
			lastSyncApplied = inputSyncState.lastUpdated;
			inputText = inputSyncState.text;
		}
	});

	/** Timer for debounced outgoing input sync. */
	let inputSyncTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Command menu state ────────────────────────────────────────────────────

	const commandMenuVisible = $derived(
		inputText.startsWith("/") && !inputText.includes(" ") && !isProcessing(),
	);
	const commandQuery = $derived(
		commandMenuVisible ? inputText.slice(1) : "",
	);

	// ─── File menu state ──────────────────────────────────────────────────────

	const atQuery = $derived(extractAtQuery(inputText, cursorPos));
	const fileMenuVisible = $derived(
		!commandMenuVisible && atQuery !== null && !isProcessing(),
	);
	const fileQuery = $derived(atQuery?.query ?? "");
	const filteredFiles = $derived(
		fileMenuVisible ? filterFiles(fileTreeState.entries, fileQuery) : [],
	);

	// ─── Derived ───────────────────────────────────────────────────────────────

	const canSend = $derived(inputText.trim().length > 0 || pendingImages.length > 0);
	const showContextMini = $derived(uiState.contextPercent > 0);

	// ─── Auto-resize textarea ──────────────────────────────────────────────────

	function autoResize() {
		if (!textareaEl) return;
		textareaEl.style.height = "auto";
		textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 120)}px`;
	}

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleInput() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
		autoResize();

		// Debounced outgoing input sync to other tabs
		if (inputSyncTimer) clearTimeout(inputSyncTimer);
		inputSyncTimer = setTimeout(() => {
			inputSyncTimer = null;
			wsSend({ type: "input_sync", text: inputText });
		}, 300);
	}

	function handleKeyup() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}

	function handleClick() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Forward keyboard events to CommandMenu when visible
		if (commandMenuVisible && commandMenuRef) {
			const handled = commandMenuRef.handleKeydown(e);
			if (handled) return;
		}
		// Forward keyboard events to FileMenu when visible
		if (fileMenuVisible && fileMenuRef) {
			const handled = fileMenuRef.handleKeydown(e);
			if (handled) return;
		}
		if (commandMenuVisible && e.key === "Escape") {
			e.preventDefault();
			inputText = "";
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	async function sendMessage() {
		const text = inputText.trim();
		if (!text) return;

		// Parse @references and fetch file contents
		const refs = parseAtReferences(text);
		let messageText = text;

		if (refs.length > 0) {
			const attachments: FileAttachment[] = [];

			for (const ref of refs) {
				try {
					if (ref.endsWith("/")) {
						// Directory: fetch listing
						const content = await fetchDirectoryListing(ref);
						attachments.push({ path: ref, type: "directory", content });
					} else {
						// File: fetch content
						const result = await fetchFileContent(ref);
						if (result.binary) {
							attachments.push({ path: ref, type: "binary" });
						} else {
							attachments.push({
								path: ref,
								type: "file",
								content: result.content,
							});
						}
					}
				} catch {
					// Skip files that fail to load
				}
			}

			messageText = buildAttachedMessage(text, attachments);
		}

		// Collect image data URLs from pending images
		const imageUrls = pendingImages.length > 0
			? pendingImages.map((img) => img.dataUrl)
			: undefined;

		// Always send immediately — OpenCode queues server-side when busy.
		// When the LLM is processing, `sentDuringEpoch` is recorded so the
		// UI can derive the "Queued" shimmer reactively.
		addUserMessage(messageText, imageUrls, isProcessing());
		wsSend({ type: "message", text: messageText, ...(imageUrls && { images: imageUrls }) });

		// Clear pending images
		pendingImages = [];

		inputText = "";
		cursorPos = 0;
		if (sessionState.currentId) {
			inputDrafts.delete(sessionState.currentId);
		}
		// Cancel any pending debounced input_sync (it would re-sync the old
		// draft text to the server after we just cleared it) and send an
		// immediate empty sync so the server-side draft store is cleared too.
		if (inputSyncTimer) {
			clearTimeout(inputSyncTimer);
			inputSyncTimer = null;
		}
		wsSend({ type: "input_sync", text: "" });
		if (textareaEl) {
			textareaEl.style.height = "auto";
		}
	}

	function handleStop() {
		wsSend({ type: "cancel" });
	}

	function handleSendClick() {
		sendMessage();
	}

	function toggleAttachMenu() {
		attachMenuOpen = !attachMenuOpen;
	}

	function handleAttachCamera() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.capture = "environment";
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	function handleAttachPhotos() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.multiple = true;
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	// ─── Image attach helpers ──────────────────────────────────────────────────

	/** Read selected files from a file input, auto-resizing if they exceed the API limit. */
	function processSelectedFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		for (const file of files) {
			const reader = new FileReader();
			reader.onload = async () => {
				if (typeof reader.result !== "string") return;
				try {
					const { dataUrl, resized } = await resizeImageIfNeeded(reader.result);
					pendingImages = [...pendingImages, {
						id: crypto.randomUUID(),
						dataUrl,
						name: file.name,
						size: file.size,
					}];
					if (resized) {
						showToast(`"${file.name}" was resized to fit the 5 MB encoded size limit`, { variant: "warn" });
					}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Image too large";
				showToast(msg, { variant: "error" });
			}
			};
			reader.readAsDataURL(file);
		}
	}

	function removePendingImage(id: string) {
		pendingImages = pendingImages.filter((img) => img.id !== id);
	}

	// ─── Command menu handlers ─────────────────────────────────────────────────

	function handleCommandSelect(command: string) {
		// Fill the input with the command text (e.g. "/skill ") instead of sending.
		// User can then type arguments and press Enter to send.
		inputText = command;
		// Move cursor to end and focus the textarea
		if (textareaEl) {
			textareaEl.focus();
			// Use tick-like scheduling to set selection after Svelte updates the DOM
			requestAnimationFrame(() => {
				if (textareaEl) {
					textareaEl.selectionStart = textareaEl.value.length;
					textareaEl.selectionEnd = textareaEl.value.length;
				}
			});
		}
	}

	function handleCommandClose() {
		inputText = "";
	}

	// ─── File menu handlers ───────────────────────────────────────────────────

	function handleFileSelect(path: string) {
		if (!atQuery || !textareaEl) return;

		// Replace @query with @path (with trailing space)
		const before = inputText.slice(0, atQuery.start);
		const after = inputText.slice(atQuery.end);
		const insertion = `@${path} `;
		inputText = before + insertion + after;

		// Move cursor to after the inserted path
		const newCursorPos = atQuery.start + insertion.length;
		requestAnimationFrame(() => {
			if (textareaEl) {
				textareaEl.focus();
				textareaEl.selectionStart = newCursorPos;
				textareaEl.selectionEnd = newCursorPos;
				cursorPos = newCursorPos;
			}
		});
	}

	function handleFileMenuClose() {
		// Remove the @ trigger character
		if (atQuery) {
			const before = inputText.slice(0, atQuery.start);
			const after = inputText.slice(atQuery.end);
			inputText = before + after;
		}
	}

	// Close attach menu on outside click
	function handleDocumentClick(e: MouseEvent) {
		if (attachMenuOpen) {
			const target = e.target as HTMLElement;
			if (!target.closest("#attach-wrap")) {
				attachMenuOpen = false;
			}
		}
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("click", handleDocumentClick);
		return () => document.removeEventListener("click", handleDocumentClick);
	});

	// Navigate to parent session on ESC — works regardless of focus
	$effect(() => {
		function handleGlobalEsc(e: KeyboardEvent) {
			if (
				e.key === "Escape" &&
				!inputText.trim() &&
				!commandMenuVisible &&
				!fileMenuVisible &&
				subagentBackBarRef
			) {
				const handled = subagentBackBarRef.triggerNavigateBack();
				if (handled) {
					e.preventDefault();
				}
			}
		}
		document.addEventListener("keydown", handleGlobalEsc);
		return () => document.removeEventListener("keydown", handleGlobalEsc);
	});
</script>

<!-- File Menu (above input when "@" is typed) -->
{#if fileMenuVisible}
	<div id="file-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<FileMenu
			bind:this={fileMenuRef}
			query={fileQuery}
			visible={fileMenuVisible}
			entries={filteredFiles}
			onSelect={handleFileSelect}
			onClose={handleFileMenuClose}
			loading={fileTreeState.loading}
		/>
	</div>
{/if}

<!-- Command Menu (above input when "/" is typed) -->
{#if commandMenuVisible}
	<div id="command-menu" class="relative w-full max-w-[760px] mx-auto px-4">
		<CommandMenu
			bind:this={commandMenuRef}
			query={commandQuery}
			visible={commandMenuVisible}
			commands={discoveryState.commands}
			onSelect={handleCommandSelect}
			onClose={handleCommandClose}
		/>
	</div>
{/if}

<div
	id="input-area"
	class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] max-md:px-3 max-md:py-1.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"
>
	<div id="input-wrapper" class="max-w-[760px] mx-auto relative">
		<!-- Subagent context bar (above input area) -->
		<SubagentBackBar bind:this={subagentBackBarRef} />

		<!-- Context usage bar (above input) -->
		{#if showContextMini}
			<ContextBar percent={uiState.contextPercent} />
		{/if}

		<!-- Processing indicator: animated bounce bar aligned with context mini bar -->
		{#if isProcessing()}
			<div class="flex items-center gap-2 pb-1.5 px-2">
				<div class="min-w-6"></div>
				<div
					class="flex-1 h-[3px] rounded-full overflow-hidden bg-bg-alt"
					style="--bounce-width: 0.3;"
				>
					<div
						class="h-full rounded-full bg-accent animate-bounce-bar"
						style="width: calc(var(--bounce-width) * 100%);"
					></div>
				</div>
			</div>
		{/if}

		<div
			id="input-row"
			class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200 max-md:rounded-[20px] focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>

			<!-- Textarea row -->
			<div class="flex items-start">
				<textarea
					id="input"
					rows="1"
					placeholder="Message OpenCode&hellip;"
					autocomplete="off"
					enterkeyhint="send"
					class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"
					bind:value={inputText}
					bind:this={textareaEl}
					oninput={handleInput}
					onkeydown={handleKeydown}
					onkeyup={handleKeyup}
					onclick={handleClick}
				></textarea>
			</div>

						<!-- Pending image previews -->
			{#if pendingImages.length > 0}
				<PastePreview images={pendingImages} onRemove={removePendingImage} />
			{/if}

			<!-- Bottom row: attach + agent + model + send -->
			<div id="input-bottom" class="flex items-center justify-between gap-1">
				<div
					id="input-bottom-left"
					class="flex items-center gap-1 min-w-0"
				>
					<!-- Attach button + menu -->
					<AttachMenu open={attachMenuOpen} onToggle={toggleAttachMenu} onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} />

					<!-- Agent selector -->
					<div id="agent-selector-wrap">
						<AgentSelector />
					</div>

				<!-- Model selector -->
				<ModelSelector />

			</div>

				<div
					id="input-bottom-right"
					class="flex items-center gap-1 shrink-0"
				>
					<!-- Send / Stop buttons -->
					<button
						id="send"
						type="button"
						class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default active:not-disabled:opacity-70"
						disabled={!canSend}
						title={isProcessing() ? "Queue message" : "Send message"}
						onclick={handleSendClick}
					>
						<Icon name="arrow-up" size={18} />
					</button>
					{#if isProcessing()}
						<button
							id="stop"
							type="button"
							class="shrink-0 w-8 h-8 rounded-[10px] bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-bg-alt hover:text-text active:opacity-70"
							title="Stop generating"
							onclick={handleStop}
						>
							<Icon name="square" size={18} />
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
