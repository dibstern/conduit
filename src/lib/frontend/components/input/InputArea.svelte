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
	import NewSessionContext from "./NewSessionContext.svelte";
	import InstanceModelPicker from "../model/InstanceModelPicker.svelte";
	import PermissionModeSelector from "./PermissionModeSelector.svelte";
	import SkillHighlightBackdrop from "./SkillHighlightBackdrop.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import { addUserMessage, currentChat, getOrCreateSessionSlot, inputSyncState, isProcessing, registerInputDraftPersistence } from "../../stores/chat.svelte.js";
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
	import { findSession, isSessionSnoozed, sessionAttention, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { getCurrentRoute, getCurrentSlug, getDraftProject } from "../../stores/router.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
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
	const currentSession = $derived(findSession(sessionState.currentId ?? ""));
	const placeholder = $derived(
		currentSession?.settledAt != null ? "Message to un-settle…" :
		currentSession && isSessionSnoozed(currentSession, sessionState.now) ? "Message to wake…" :
		"Ask anything. / to use skills, @ to mention files",
	);

	// Each session keeps its own unsent input text. Switching sessions saves the
	// current draft and restores the target session's draft (or empty string).

	const inputDrafts = new Map<string, string>();
	// undefined until the first run, so a fresh load restores its draft too.
	let previousSessionId: string | null | undefined = undefined;

	// The new-session draft has no server-side store, so it lives here to
	// survive a reload: a half-typed first prompt must not vanish.
	const NEW_SESSION_DRAFT_KEY = "conduit:new-session-draft";
	function readNewSessionDraft(): string {
		try {
			return localStorage.getItem(NEW_SESSION_DRAFT_KEY) ?? "";
		} catch {
			return "";
		}
	}
	function storeNewSessionDraft(text: string) {
		try {
			if (text) localStorage.setItem(NEW_SESSION_DRAFT_KEY, text);
			else localStorage.removeItem(NEW_SESSION_DRAFT_KEY);
		} catch {
			// Storage can be unavailable (private mode); the draft just won't persist.
		}
	}
	const reloadRestoredDrafts = new Set<string>();
	// Extend the existing draft map across a reload, including drafts typed
	// before a session exists. Session drafts also keep using the server RPC.
	const reloadDraftKey = "conduit-reload-drafts";
	try {
		const saved = sessionStorage.getItem(reloadDraftKey);
		if (saved) {
			for (const [id, text] of JSON.parse(saved) as [string, string][]) {
				inputDrafts.set(id, text);
				reloadRestoredDrafts.add(id);
			}
			sessionStorage.removeItem(reloadDraftKey);
		}
	} catch {
		// A restricted browser can still use the existing server draft sync.
	}

	$effect(() => {
		const currentId = sessionState.currentId;
		untrack(() => {
			if (currentId !== previousSessionId) {
				// Save draft for the session we're leaving
				if (previousSessionId) {
					inputDrafts.set(previousSessionId, inputText);
				}
				// Restore draft for the session we're entering
				inputText = currentId
					? (inputDrafts.get(currentId) ?? "")
					: readNewSessionDraft();
				previousSessionId = currentId;
				lastLocalEditAt = reloadRestoredDrafts.delete(currentId ?? "") ? Date.now() : 0;
				// Cancel any pending outgoing sync from the previous session
				if (inputSyncTimer) {
					clearTimeout(inputSyncTimer);
					inputSyncTimer = null;
				}
			}
		});
	});

	// Input sync (cross-tab)

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
		if (inputSyncState.reloadPending) return;
		if (Date.now() - lastLocalEditAt < SYNC_GRACE_MS) return;
		inputText = inputSyncState.text;
	});

	// + opens a draft ready to type into.
	$effect(() => {
		const route = getCurrentRoute();
		if (route.page === "chat" && route.draft) untrack(() => textareaEl?.focus());
	});

	/** Timer for debounced outgoing input sync. */
	let inputSyncTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => registerInputDraftPersistence(async () => {
		if (inputSyncTimer) {
			clearTimeout(inputSyncTimer);
			inputSyncTimer = null;
		}
		let savedText: string;
		let savedSessionId: string | null;
		do {
			savedText = inputText;
			savedSessionId = sessionState.currentId;
			await syncInputDraft(savedText);
		} while (inputText !== savedText || sessionState.currentId !== savedSessionId);
		// Cancelling the debounce above dropped any pending new-session draft write.
		if (!sessionState.currentId) storeNewSessionDraft(inputText);
		// Images live only in this composer. Defer reload until sent or removed.
		if (pendingImages.length > 0) return false;
		inputDrafts.set(sessionState.currentId ?? "", inputText);
		sessionStorage.setItem(reloadDraftKey, JSON.stringify([...inputDrafts]));
		return true;
	}));

	const slashQuery = $derived(extractSlashQuery(inputText, cursorPos));
	const commandMenuVisible = $derived(slashQuery !== null);
	const commandQuery = $derived(slashQuery?.query ?? "");
	const filteredCommands = $derived(
		commandMenuVisible ? filterCommands(discoveryState.commands, commandQuery) : [],
	);
	const commandListboxVisible = $derived(filteredCommands.length > 0);

	/** Names of known slash commands/skills, for inline recognition in the composer. */
	const commandNameSet = $derived(new Set(discoveryState.commands.map((c) => c.name)));

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
	 * not a combobox (option 3C), so there is no `aria-expanded`
	 * for a screen reader to read the opened state off. This live region carries
	 * that signal instead. Empty string when nothing is open, so closing is silent.
	 */
	const listboxStatusText = $derived.by(() => {
		if (commandListboxVisible) {
			const commandCount = filteredCommands.length;
			return `${commandCount} command${commandCount === 1 ? "" : "s"} available`;
		}
		if (fileListboxVisible) {
			if (filteredFiles.length === 0) return "Loading files";
			const fileCount = filteredFiles.length;
			return `${fileCount} file${fileCount === 1 ? "" : "s"} available`;
		}
		return "";
	});

	// Pasting a log dump means the composer holds far more text than it can show.
	// Past this size the highlight mirror stops earning its keep: it would lay the
	// whole draft out a second time, which costs ~300ms per megabyte. Fall back to
	// the textarea's own (unhighlighted) text, exactly as during IME composition.
	const HIGHLIGHT_MAX_CHARS = 20_000;
	const plainText = $derived(inputText.length > HIGHLIGHT_MAX_CHARS);

	const canSend = $derived(inputText.trim().length > 0 || pendingImages.length > 0);
	const sendButtonLabel = $derived(
		permissionsState.pendingQuestions.some((question) => question.sessionId === sessionState.currentId)
			? "Reply"
			: isProcessing()
				? "Queue message"
				: "Send message",
	);
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

	// On mobile, Enter inserts a newline (default textarea behavior) and the
	// user taps the Send button. On desktop, Enter sends the message.

	function isMobile(): boolean {
		return (
			/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
			(navigator.maxTouchPoints > 0 && window.innerWidth < 768)
		);
	}

	function syncInputDraft(text: string): Promise<void> {
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!sessionId || !projectSlug) return Promise.resolve();
		return syncInputDraftRpc({
			projectSlug,
			sessionId,
			text,
			originId: getBrowserClientId(),
		});
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
			if (sessionState.currentId) void syncInputDraft(inputText).catch(() => undefined);
			else storeNewSessionDraft(inputText);
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

	let creatingSession = false;

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
		let sid = sessionState.currentId;
		// A draft is created in the project its chip names, which can differ
		// from the attached one until the attach round trip lands.
		const projectSlug = sid ? getCurrentSlug() : getDraftProject();
		if (!projectSlug) {
			showToast("No active project", { variant: "error" });
			return;
		}
		if (!sid) {
			// First send with no active session: create one bound to the selected
			// harness instance (the picker's pre-creation draft), then send into it.
			// A second Enter before the create lands would make a second session.
			if (creatingSession) return;
			creatingSession = true;
			try {
				const created = await createSessionRpc({
					projectSlug,
					originId: getBrowserClientId(),
					instanceId: getEffectiveInstanceId(),
				});
				sid = created.sessionId;
				storeNewSessionDraft("");
				// Don't yank someone who opened another session while this one was created.
				if (!sessionState.currentId) switchToSession(sid, projectSlug);
			} catch {
				showToast("Failed to create session", { variant: "error" });
				return;
			} finally {
				creatingSession = false;
			}
		}
		const { activity, messages } = getOrCreateSessionSlot(sid);
		addUserMessage(activity, messages, messageText, imageUrls, isProcessing());
		const sentToSessionId = sid;
		rateLimitChatSend(() => {
			void sendMessageRpc({
				projectSlug,
				sessionId: sentToSessionId,
				text: messageText,
				commandId: crypto.randomUUID(),
				...(imageUrls ? { images: imageUrls } : {}),
				originId: getBrowserClientId(),
			}).then((response) => {
				if (response.sessionId !== sentToSessionId && sessionState.currentId === sentToSessionId)
					switchToSession(response.sessionId, projectSlug, undefined, { replace: true });
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
		void syncInputDraft("").catch(() => undefined);
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
			commands={[...discoveryState.commands]}
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
		{#if isProcessing() || (currentSession && sessionAttention(currentSession) === "working")}
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

		{#if !sessionState.currentId && sessionViewState.compact}
			<div class="pb-1.5"><NewSessionContext /></div>
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
						{placeholder}
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
			<div id="input-bottom" class="flex min-w-0 items-center justify-between gap-1">
				<div
					id="input-bottom-left"
					class="flex items-center gap-1 min-w-0"
				>
					<!-- Attach button + menu -->
					<AttachMenu onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} />

					<!-- Agent selector -->
					<div id="agent-selector-wrap" class="min-w-0">
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
						title={sendButtonLabel}
						ariaLabel={sendButtonLabel}
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
		{#if !sessionState.currentId && !sessionViewState.compact}
			<div class="pt-2"><NewSessionContext /></div>
		{/if}
	</div>
</div>
