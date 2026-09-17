<!-- ─── Input Area ──────────────────────────────────────────────────────────── -->
<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script lang="ts">
	import { untrack } from "svelte";
	import Button from "../ui/Button.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import AgentSelector from "../model/AgentSelector.svelte";
	import AttachMenu from "./AttachMenu.svelte";
	// biome-ignore lint/style/useImportType: CommandMenu is used as a value for bind:this
	import CommandMenu from "./CommandMenu.svelte";
	import ContextBar from "./ContextBar.svelte";
	// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
	import FileMenu from "./FileMenu.svelte";
	import InstanceModelPicker from "../model/InstanceModelPicker.svelte";
	import PermissionModeSelector from "./PermissionModeSelector.svelte";
	import SkillHighlightBackdrop from "./SkillHighlightBackdrop.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import { addUserMessage, currentChat, getOrCreateSessionSlot, inputSyncState, isProcessing } from "../../stores/chat.svelte.js";
	import {
		discoveryState,
		extractSlashQuery,
		filterCommands,
		getEffectiveInstanceId,
		getModelDisplayName,
	} from "../../stores/discovery.svelte.js";
	import {
		buildMentionInsertion,
		extractAtQuery,
		fileTreeState,
		filterFiles,
	} from "../../stores/file-tree.svelte.js";
	import { fetchFileContent, fetchDirectoryListing, resizeImageIfNeeded } from "./input-utils.js";
	import { sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { rateLimitChatSend } from "../../stores/ws.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { cancelSessionRpc, createSessionRpc, sendMessageRpc, syncInputDraftRpc } from "../../transport/ws-rpc-client.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import type { PendingImage } from "../../types.js";

	const inputAreaId = $props.id();
	const fileListboxId = `${inputAreaId}-file-listbox`;
	const commandListboxId = `${inputAreaId}-command-listbox`;

	// ─── State ─────────────────────────────────────────────────────────────────

	let inputText = $state("");
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let pendingImages = $state<PendingImage[]>([]);
	let commandMenuRef: CommandMenu | undefined = $state();
	let fileMenuRef: FileMenu | undefined = $state();
	let commandMenuActiveIndex = $state(0);
	let fileMenuActiveIndex = $state(0);
	let subagentBackBarRef: SubagentBackBar | undefined = $state();
	let cursorPos = $state(0);
	let composing = $state(false);

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
			}
		});
	});

	// ─── Input sync (cross-tab) ───────────────────────────────────────────────

	/** Track which sync we last applied to avoid re-applying our own. */
	let lastSyncApplied = 0;

	/** When the local user last typed, so stale syncs can be told apart. */
	let lastLocalEditAt = 0;

	// A sync is already behind by our own 300ms debounce plus a round trip, so
	// one that lands right after a keystroke describes text older than what is
	// on screen. Applying it deletes what the user just typed.
	const SYNC_GRACE_MS = 1_000;

	/** Receive input sync from another tab viewing the same session. */
	$effect(() => {
		if (inputSyncState.lastUpdated <= lastSyncApplied) return;
		lastSyncApplied = inputSyncState.lastUpdated;
		if (Date.now() - lastLocalEditAt < SYNC_GRACE_MS) return;
		inputText = inputSyncState.text;
	});

	/** Timer for debounced outgoing input sync. */
	let inputSyncTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Command menu state ────────────────────────────────────────────────────

	const slashQuery = $derived(extractSlashQuery(inputText, cursorPos));
	const commandMenuVisible = $derived(slashQuery !== null);
	const commandQuery = $derived(slashQuery?.query ?? "");
	const filteredCommands = $derived(
		commandMenuVisible ? filterCommands(discoveryState.commands, commandQuery) : [],
	);
	const commandListboxVisible = $derived(filteredCommands.length > 0);

	/** Names of known slash commands/skills, for inline recognition in the composer. */
	const commandNameSet = $derived(new Set(discoveryState.commands.map((c) => c.name)));

	// ─── File menu state ──────────────────────────────────────────────────────

	const atQuery = $derived(extractAtQuery(inputText, cursorPos));
	const fileMenuVisible = $derived(
		!commandMenuVisible && atQuery !== null,
	);
	const fileQuery = $derived(atQuery?.query ?? "");
	const filteredFiles = $derived(
		fileMenuVisible ? filterFiles(fileTreeState.entries, fileQuery) : [],
	);
	const fileListboxVisible = $derived(
		fileMenuVisible && (filteredFiles.length > 0 || fileTreeState.loading),
	);
	const activeListboxId = $derived(
		commandListboxVisible
			? commandListboxId
			: fileListboxVisible
				? fileListboxId
				: undefined,
	);
	const activeOptionId = $derived(
		commandListboxVisible
			? `${commandListboxId}-option-${commandMenuActiveIndex}`
			: fileListboxVisible && filteredFiles.length > 0
				? `${fileListboxId}-option-${fileMenuActiveIndex}`
				: undefined,
	);

	/**
	 * Spoken announcement for the mention menus. The composer is a plain textarea,
	 * not a combobox (conduit-test-n9s, option 3C), so there is no `aria-expanded`
	 * for a screen reader to read the opened state off. This live region carries
	 * that signal instead. Empty string when nothing is open, so closing is silent.
	 */
	const listboxStatusText = $derived.by(() => {
		if (commandListboxVisible) {
			const n = filteredCommands.length;
			return `${n} command${n === 1 ? "" : "s"} available`;
		}
		if (fileListboxVisible) {
			if (filteredFiles.length === 0) return "Loading files";
			const n = filteredFiles.length;
			return `${n} file${n === 1 ? "" : "s"} available`;
		}
		return "";
	});

	// ─── Derived ───────────────────────────────────────────────────────────────

	// Pasting a log dump means the composer holds far more text than it can show.
	// Past this size the highlight mirror stops earning its keep: it would lay the
	// whole draft out a second time, which costs ~300ms per megabyte. Fall back to
	// the textarea's own (unhighlighted) text, exactly as during IME composition.
	const HIGHLIGHT_MAX_CHARS = 20_000;
	const plainText = $derived(inputText.length > HIGHLIGHT_MAX_CHARS);

	const canSend = $derived(inputText.trim().length > 0 || pendingImages.length > 0);
	const showContextMini = $derived(currentChat().contextPercent > 0);
	/** Drift is only reportable with complete mismatch evidence. */
	const modelDrift = $derived.by(() => {
		const execution = discoveryState.modelExecution;
		return execution?.drifted === true &&
			execution.requestedModel &&
			execution.expectedModel &&
			execution.actualModel
			? {
					actualModel: execution.actualModel,
					requestedModel: execution.requestedModel,
				}
			: null;
	});

	// ─── Mobile detection ─────────────────────────────────────────────────────
	// On mobile, Enter inserts a newline (default textarea behavior) and the
	// user taps the Send button. On desktop, Enter sends the message.

	function isMobile(): boolean {
		return (
			/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
			(navigator.maxTouchPoints > 0 && window.innerWidth < 768)
		);
	}

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function syncInputDraft(text: string) {
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		void syncInputDraftRpc({
			projectSlug,
			sessionId,
			text,
			originId: getBrowserClientId(),
		}).catch(() => undefined);
	}

	function handleInput() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
		lastLocalEditAt = Date.now();

		// Debounced outgoing input sync to other tabs
		if (inputSyncTimer) clearTimeout(inputSyncTimer);
		inputSyncTimer = setTimeout(() => {
			inputSyncTimer = null;
			syncInputDraft(inputText);
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

	// During IME composition the textarea must show its own pre-commit text, so we
	// reveal the textarea text and hide the backdrop until composition ends.
	function handleCompositionStart() {
		composing = true;
	}

	function handleCompositionEnd() {
		composing = false;
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
			handleCommandClose();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			if (isMobile()) {
				// Mobile: Enter inserts newline (default textarea behavior).
				// User taps Send button to send.
				return;
			}
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
		const projectSlug = getCurrentSlug();
		if (!projectSlug) {
			showToast("No active project", { variant: "error" });
			return;
		}
		let sid = sessionState.currentId;
		if (!sid) {
			// First send with no active session: create one bound to the selected
			// harness instance (the picker's pre-creation draft), then send into it.
			try {
				const created = await createSessionRpc({
					projectSlug,
					originId: getBrowserClientId(),
					instanceId: getEffectiveInstanceId(),
				});
				sid = created.sessionId;
				switchToSession(sid);
			} catch {
				showToast("Failed to create session", { variant: "error" });
				return;
			}
		}
		const { activity, messages } = getOrCreateSessionSlot(sid);
		addUserMessage(activity, messages, messageText, imageUrls, isProcessing());
		rateLimitChatSend(() => {
			void sendMessageRpc({
				projectSlug,
				sessionId: sid,
				text: messageText,
				commandId: crypto.randomUUID(),
				...(imageUrls ? { images: imageUrls } : {}),
				originId: getBrowserClientId(),
			}).catch(() => {
				showToast("Failed to send message", { variant: "error" });
			});
		});

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
		syncInputDraft("");
	}

	function handleStop() {
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		void cancelSessionRpc({
			projectSlug,
			sessionId,
			commandId: crypto.randomUUID(),
		}).catch(() => {
			showToast("Failed to stop session", { variant: "error" });
		});
	}

	function handleSendClick() {
		sendMessage();
	}

	function handleAttachCamera() {
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.capture = "environment";
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	function handleAttachPhotos() {
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
		// Replace the slash query region with the selected command text (e.g. "/skill ").
		// User can then type arguments and press Enter to send.
		let newCursorPos: number;
		if (slashQuery) {
			const before = inputText.slice(0, slashQuery.start);
			const after = inputText.slice(slashQuery.end);
			newCursorPos = slashQuery.start + command.length;
			inputText = before + command + after;
		} else {
			inputText = command;
			newCursorPos = command.length;
		}
		// Move cursor to end of inserted command and focus the textarea
		if (textareaEl) {
			textareaEl.focus();
			requestAnimationFrame(() => {
				if (textareaEl) {
					textareaEl.selectionStart = newCursorPos;
					textareaEl.selectionEnd = newCursorPos;
					cursorPos = newCursorPos;
				}
			});
		}
	}

	function handleCommandClose() {
		if (slashQuery) {
			const before = inputText.slice(0, slashQuery.start);
			const after = inputText.slice(slashQuery.end);
			inputText = before + after;
		} else {
			inputText = "";
		}
	}

	// ─── File menu handlers ───────────────────────────────────────────────────

	function handleFileSelect(path: string) {
		if (!atQuery || !textareaEl) return;

		const before = inputText.slice(0, atQuery.start);
		const after = inputText.slice(atQuery.end);
		const insertion = buildMentionInsertion(path);
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

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

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
			bind:activeIndex={fileMenuActiveIndex}
			listboxId={fileListboxId}
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
	<div id="command-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<CommandMenu
			bind:this={commandMenuRef}
			bind:activeIndex={commandMenuActiveIndex}
			listboxId={commandListboxId}
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
			<ContextBar percent={currentChat().contextPercent} />
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

			<!-- Textarea row.
			     The composer grows with its text and then scrolls, and both of those
			     are CSS here rather than JS: the mirror sizes the row, this container
			     caps and scrolls it, and the textarea is stretched over the mirror at
			     the full content height so it never scrolls on its own. One scroll
			     position for the whole composer means the caret cannot end up on a
			     different line from the text it sits in.
			     `scrollbar-gutter: stable` keeps a scrollbar appearing from narrowing
			     the textarea but not the mirror, which would wrap them differently. -->
			<div class="max-h-[120px] overflow-y-auto [scrollbar-gutter:stable]">
				<!-- Past HIGHLIGHT_MAX_CHARS the mirror renders nothing, so it can no
				     longer size the row: pin the row to the cap and let the textarea
				     scroll itself. Safe only because the mirror is blank in that mode,
				     so there is still just one scroll position in play. -->
				<div class="relative min-h-6 {plainText ? 'h-[120px]' : ''}">
					<SkillHighlightBackdrop
						text={plainText ? "" : inputText}
						commandNames={commandNameSet}
						dimmed={composing || plainText}
					/>
					<!--
						`chrome="bare"` + `size="content"`: the affordance is
						`#input-row` above, which owns the border and the focus ring,
						so the field itself paints nothing and sizes itself. Dropped
						from the class list: `bg-transparent` and `border-none`, both
						of which Tailwind v4's preflight already does on a textarea
						and which only squatted on their utility group.
						`outline-none` is load-bearing and now comes from `bare`.

						The text colour moved from two `class:` directives into the
						class string because Svelte has no `class:` directive on a
						COMPONENT tag. That is also why `bare` emits no text colour:
						this swap and a primitive `text-text` would be two utilities
						in one Tailwind group, resolved by stylesheet order, and the
						call site would lose.
					-->
					<Textarea
						id="input"
						aria-label="Message"
						aria-autocomplete="list"
						aria-haspopup="listbox"
						aria-controls={activeListboxId}
						aria-activedescendant={activeOptionId}
						chrome="bare"
						size="content"
						placeholder="Ask anything. / to use skills, @ to mention files"
						autocomplete="off"
						enterkeyhint={isMobile() ? "enter" : "send"}
						class="composer-text-metrics absolute inset-0 z-10 caret-[var(--color-text)] resize-none placeholder:text-text-muted {plainText
							? 'overflow-y-auto'
							: 'overflow-hidden'} {composing || plainText
							? 'text-text'
							: 'text-transparent'}"
						bind:value={inputText}
						bind:element={textareaEl}
						oninput={handleInput}
						onkeydown={handleKeydown}
						onkeyup={handleKeyup}
						onclick={handleClick}
						oncompositionstart={handleCompositionStart}
						oncompositionend={handleCompositionEnd}
					/>
					<div class="sr-only" role="status" data-testid="composer-menu-status">
						{listboxStatusText}
					</div>
				</div>
			</div>

						<!-- Pending image previews -->
			{#if pendingImages.length > 0}
				<PastePreview images={pendingImages} onRemove={removePendingImage} />
			{/if}

			<!-- Model drift notice: own row, so it never crowds the controls below -->
			{#if modelDrift}
				<div
					data-testid="current-model-drift"
					class="mx-1 mb-1 rounded-lg border border-warning/30 bg-warning-bg px-2 py-1 text-[11px] leading-[1.3] font-medium text-warning"
				>
					⚠ Running {getModelDisplayName(modelDrift.actualModel)} — you selected {getModelDisplayName(modelDrift.requestedModel)}
				</div>
			{/if}

			<!-- Bottom row: attach + agent + model + send -->
			<div id="input-bottom" class="flex items-center justify-between gap-1">
				<div
					id="input-bottom-left"
					class="flex items-center gap-1 min-w-0"
				>
					<!-- Attach button + menu -->
					<AttachMenu onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} />

					<!-- Agent selector -->
					<div id="agent-selector-wrap">
						<AgentSelector />
					</div>
				</div>

				<div
					id="input-bottom-right"
					class="flex items-center gap-1 min-w-0"
				>
					<!-- Harness instance + model picker -->
					<InstanceModelPicker />

					<!-- Approvals (permission mode) selector -->
					<PermissionModeSelector />

					<!-- Send / Stop buttons -->
					<!-- No tone supplies text-white without a hover step; inherit leaves that colour local.
					     transition-colors replaces the arbitrary transition; 150ms is its default. -->
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						hoverFill="none"
						disabledStyle="ghosted"
						iconOnly
						icon="arrow-up"
						iconSize={18}
						id="send"
						type="button"
						class="send-btn shrink-0 w-8 h-8 rounded-[10px] bg-brand-a text-white touch-manipulation hover:not-disabled:opacity-90 active:not-disabled:opacity-70"
						disabled={!canSend}
						title={isProcessing() ? "Queue message" : "Send message"}
						ariaLabel={isProcessing() ? "Queue message" : "Send message"}
						onclick={handleSendClick}
					/>
					{#if isProcessing()}
						<!-- The arbitrary transition yields to Button's transition-colors; duration-150 restates its default. -->
						<Button
							variant="secondary"
							size="content"
							tone="muted"
							hoverFill="alt"
							iconOnly
							icon="square"
							iconSize={18}
							id="stop"
							type="button"
							class="shrink-0 w-8 h-8 rounded-[10px] touch-manipulation active:opacity-70"
							title="Stop generating"
							ariaLabel="Stop generating"
							onclick={handleStop}
						/>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
