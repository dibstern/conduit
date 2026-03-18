<!-- ─── Input Area ──────────────────────────────────────────────────────────── -->
<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script lang="ts">
	import { untrack } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import AgentSelector from "../features/AgentSelector.svelte";
	// biome-ignore lint/style/useImportType: CommandMenu is used as a value for bind:this
	import CommandMenu from "../features/CommandMenu.svelte";
	// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
	import FileMenu from "../features/FileMenu.svelte";
	import ModelSelector from "../features/ModelSelector.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import { chatState, addUserMessage, inputSyncState } from "../../stores/chat.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { extractAtQuery, fileTreeState, filterFiles } from "../../stores/file-tree.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { onFileBrowser } from "../../stores/ws-listeners.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import { formatFileSize } from "../../utils/format.js";

	// ─── State ─────────────────────────────────────────────────────────────────

	let inputText = $state("");
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let attachMenuOpen = $state(false);
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
		inputText.startsWith("/") && !inputText.includes(" ") && !chatState.processing,
	);
	const commandQuery = $derived(
		commandMenuVisible ? inputText.slice(1) : "",
	);

	// ─── File menu state ──────────────────────────────────────────────────────

	const atQuery = $derived(extractAtQuery(inputText, cursorPos));
	const fileMenuVisible = $derived(
		!commandMenuVisible && atQuery !== null && !chatState.processing,
	);
	const fileQuery = $derived(atQuery?.query ?? "");
	const filteredFiles = $derived(
		fileMenuVisible ? filterFiles(fileTreeState.entries, fileQuery) : [],
	);

	// ─── Derived ───────────────────────────────────────────────────────────────

	const isProcessing = $derived(chatState.processing);
	const canSend = $derived(inputText.trim().length > 0);
	const showContextMini = $derived(uiState.contextPercent > 0);

	const contextFillColor = $derived.by(() => {
		if (uiState.contextPercent >= 95) return "bg-error";
		if (uiState.contextPercent >= 80) return "bg-warning";
		return "bg-success";
	});

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

		// Always send immediately — OpenCode queues server-side when busy.
		// Mark the message as "queued" visually when the LLM is processing.
		addUserMessage(messageText, undefined, isProcessing);
		wsSend({ type: "message", text: messageText });

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
		fileInput.click();
	}

	function handleAttachPhotos() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.multiple = true;
		fileInput.click();
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

	function fetchFileContent(
		path: string,
	): Promise<{ content: string; binary?: boolean }> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

			const unsub = onFileBrowser((msg) => {
				if (msg.type === "file_content" && (msg as { path: string }).path === path) {
					clearTimeout(timeout);
					unsub();
				const result: { content: string; binary?: boolean } = {
						content: (msg as { content: string }).content,
					};
					const binaryVal = (msg as { binary?: boolean }).binary;
					if (binaryVal !== undefined) {
						result.binary = binaryVal;
					}
					resolve(result);
				}
			});

			wsSend({ type: "get_file_content", path });
		});
	}

	function fetchDirectoryListing(path: string): Promise<string> {
		const requestPath = path.replace(/\/$/, "");
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

			const unsub = onFileBrowser((msg) => {
				if (msg.type === "file_list" && (msg as { path: string }).path === requestPath) {
					clearTimeout(timeout);
					unsub();
					const entries = (msg as { entries: Array<{ name: string; type: string; size?: number }> }).entries;
					const listing = entries
						.map((e) =>
							e.type === "directory"
								? `${e.name}/ (directory)`
								: `${e.name} (${formatFileSize(e.size ?? 0)}, file)`,
						)
						.join("\n");
					resolve(listing);
				}
			});

			wsSend({ type: "get_file_list", path: requestPath });
		});
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
		<div
			id="input-row"
			class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200 max-md:rounded-[20px] focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>
			<!-- Subagent context bar (above all other input chrome) -->
			<SubagentBackBar bind:this={subagentBackBarRef} />

			<!-- Context usage mini-bar -->
			<div
				id="context-mini"
				class="flex items-center gap-2 pt-1.5 pb-0.5 px-3.5 cursor-pointer select-none"
				class:hidden={!showContextMini}
			>
				<div
					class="context-mini-bar flex-1 h-1 rounded-[2px] bg-border overflow-hidden"
				>
					<div
						class="context-mini-fill h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out {contextFillColor}"
						id="context-mini-fill"
						style="width: {uiState.contextPercent}%"
					></div>
				</div>
				<span
					class="context-mini-label font-mono text-[10px] font-semibold text-text-dimmer whitespace-nowrap min-w-6 text-right"
					id="context-mini-label"
				>
					{uiState.contextPercent}%
				</span>
			</div>

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

			<!-- Bottom row: attach + agent + model + send -->
			<div id="input-bottom" class="flex items-center justify-between gap-1">
				<div
					id="input-bottom-left"
					class="flex items-center gap-1 min-w-0"
				>
					<!-- Attach button + menu -->
					<div id="attach-wrap" class="relative shrink-0">
						<button
							id="attach-btn"
							type="button"
							aria-label="Attach"
							class="w-9 h-9 rounded-full border-none bg-transparent text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-alt hover:text-text"
							onclick={toggleAttachMenu}
						>
							<Icon name="plus" size={18} />
						</button>
						<div
					id="attach-menu"
					class="absolute bottom-[calc(100%+8px)] left-0 min-w-[170px] bg-bg-alt border border-border rounded-[14px] shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] z-10 overflow-hidden"
							class:hidden={!attachMenuOpen}
						>
							<button
							class="attach-menu-item flex items-center gap-2.5 w-full py-3 px-4 border-none bg-none text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-150 not-last:border-b not-last:border-border-subtle hover:bg-bg-alt hover:text-text"
							id="attach-camera"
							type="button"
							onclick={handleAttachCamera}
						>
							<Icon name="camera" size={18} class="shrink-0" />
							<span>Take Photo</span>
						</button>
						<button
							class="attach-menu-item flex items-center gap-2.5 w-full py-3 px-4 border-none bg-none text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-150 not-last:border-b not-last:border-border-subtle hover:bg-bg-alt hover:text-text"
								id="attach-photos"
								type="button"
								onclick={handleAttachPhotos}
							>
								<Icon name="image" size={18} class="shrink-0" />
								<span>Add Photos</span>
							</button>
						</div>
					</div>

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
						class="send-btn shrink-0 w-9 h-9 rounded-full border-none bg-accent text-bg cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:bg-accent-hover disabled:opacity-25 disabled:cursor-default active:not-disabled:opacity-70"
						disabled={!canSend}
						title={isProcessing ? "Queue message" : "Send message"}
						onclick={handleSendClick}
					>
						<Icon name="arrow-up" size={18} />
					</button>
					{#if isProcessing}
						<button
							id="stop"
							class="shrink-0 w-9 h-9 rounded-full bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-bg-alt hover:text-text active:opacity-70"
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
