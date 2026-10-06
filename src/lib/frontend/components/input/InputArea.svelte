<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script module lang="ts">
	// A composer remount must not repeat the same turn's diagnostic.
	const reportedMissingPrompts = new Set<string>();
</script>

<script lang="ts">
	import { tick, untrack } from "svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TwoRowComposerLayout from "../ui/TwoRowComposerLayout.svelte";
	import AttachMenu from "./AttachMenu.svelte";
	import ComposerStatusHeader from "./ComposerStatusHeader.svelte";
	// biome-ignore lint/style/useImportType: CommandMenu is used as a value for bind:this
	import CommandMenu from "./CommandMenu.svelte";
	// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
	import FileMenu from "./FileMenu.svelte";
	import NewSessionContext from "./NewSessionContext.svelte";
	import UsageLimitStrip from "./UsageLimitStrip.svelte";
	import InstanceModelPicker from "../model/InstanceModelPicker.svelte";
	import PermissionModeSelector from "./PermissionModeSelector.svelte";
	import SkillHighlightBackdrop from "./SkillHighlightBackdrop.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import { openSideThreads } from "../session/side-threads.svelte.js";
	import { addUserMessage, currentChat, followSessionBusy, getOrCreateSessionSlot, inputSyncState, isProcessing, phaseToProcessing, registerInputDraftPersistence } from "../../stores/chat.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { dismissGoalMet, goalDetails, goalView, isGoalMetDismissed, sessionGoals, type GoalComposerAction } from "../../stores/goal.svelte.js";
	import {
		conduitCommands,
		discoveryState,
		extractCommandQuery,
		filterCommands,
		getChosenModel,
		getEffectiveInstanceId,
		getModelDisplayName,
		toProviderCommands,
	} from "../../stores/discovery.svelte.js";
	import {
		buildMentionInsertion,
		extractAtQuery,
		fileTreeState,
		filterFiles,
	} from "../../stores/file-tree.svelte.js";
	import { fetchFileContent, fetchDirectoryListing, resizeImageIfNeeded } from "./input-utils.js";
	import { findSession, isSessionBusy, isSessionSnoozed, sessionAttention, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getDraftProject, rememberNewSessionProject } from "../../stores/project.svelte.js";
	import { requestTranscriptFollow, sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { rateLimitChatSend } from "../../stores/ws-send.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
	import { isPaused, segmentTurns, startedTurn, workingTime } from "../../utils/turns.js";
	import { cancelSessionRpc, createSessionRpc, sendMessageRpc, startSideThreadRpc, syncInputDraftRpc } from "../../transport/ws-rpc-client.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import { requestSessionPreWarm } from "../../utils/session-prewarm.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import type { PendingImage } from "../../types.js";

	const inputAreaId = $props.id();
	const fileListboxId = `${inputAreaId}-file-listbox`;
	const commandListboxId = `${inputAreaId}-command-listbox`;

	let inputText = $state("");
	const isGoalCommand = $derived(discoveryState.currentProviderId === "claude" && inputText.startsWith("/goal"));
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
	const goalFacts = $derived(discoveryState.currentProviderId === "claude" ? sessionGoals.get(sessionState.currentId ?? "") : undefined);
	const goal = $derived(goalView(
		goalFacts,
		isProcessing() ? "busy" : currentSession?.status ?? "idle",
	));
	let goalNow = $state(Date.now());
	let undoneClearKey = $state<string | null>(null);
	const clearKey = $derived(goalFacts ? `${goalFacts.sessionId}:${goalFacts.endedAt}` : null);
	const showClearedGoal = $derived(goal.phase === "cleared" && goalFacts?.endedAt !== undefined && goalNow - goalFacts.endedAt < 10_000 && clearKey !== undoneClearKey);
	$effect(() => {
		const endedAt = goal.phase === "cleared" ? goalFacts?.endedAt : undefined;
		const now = Date.now();
		goalNow = now;
		if (endedAt === undefined || now - endedAt >= 10_000) return;
		const timer = setTimeout(() => { goalNow = Date.now(); }, endedAt + 10_000 - now + 1);
		return () => clearTimeout(timer);
	});
	const turn = $derived.by(() => {
		const chat = currentChat();
		return startedTurn(segmentTurns(chat.messages, isProcessing(), chat.turnEpoch), chat.turnEpoch, isProcessing());
	});
	const paused = $derived(turn !== undefined && isPaused(turn));
	const working = $derived(isProcessing() || paused || Boolean(currentSession && sessionAttention(currentSession) === "working"));
	const elapsed = $derived.by(() => {
		if (!turn) return undefined;
		if (paused) return workingTime(turn, Date.now());
		if (turn.live) return workingTime(turn, clock.now);
		if (turn.user?.turnTiming?.endedAt !== undefined) return workingTime(turn, Date.now());
		return undefined;
	});
	const missingPrompt = $derived(isProcessing() && currentChat().loadLifecycle === "ready" && !turn?.user);
	$effect(() => {
		if (!missingPrompt) return;
		const sessionId = sessionState.currentId;
		if (!sessionId) return;
		const chat = currentChat();
		const key = JSON.stringify([sessionId, chat.turnEpoch]);
		if (reportedMissingPrompts.has(key)) return;
		reportedMissingPrompts.add(key);
		const lastRow = chat.transcript?.rows.at(-1);
		const last = chat.messages.at(-1);
		console.error("[turn-clock] Working session has no prompt to time from", {
			sessionId,
			turnEpoch: chat.turnEpoch,
			messageCount: chat.messages.length,
			lastMessageRole: lastRow?.role ?? last?.type ?? null,
			lastMessageId: lastRow?.id ?? (last && "messageId" in last ? last.messageId ?? last.uuid : last?.uuid) ?? null,
		});
	});
	const activity = $derived.by(() => {
		const chat = currentChat();
		for (let i = chat.messages.length - 1; i >= 0; i--) {
			const part = chat.messages[i];
			if (!part) continue;
			if (part.type === "user") {
				// A queued steering message doesn't end the current activity.
				if (part.sentDuringEpoch != null && part.sentDuringEpoch >= chat.turnEpoch) continue;
				return "";
			}
			if (part.type === "result" || (part.type === "assistant" && !part.finalized)) return "";
			if (part.type === "thinking" && !part.done) return "Thinking";
			// Projected rows report every ordinary tool as completed, so the
			// missing result is what marks the tool still in flight.
			if (part.type === "tool" && part.result === undefined && part.status !== "error") {
				const summary = lookupSummarizer(part.name).summarize(ensureCanonical(part.name, part.input), {});
				return summary.subtitle ? `${part.name} · ${summary.subtitle}` : part.name;
			}
		}
		return "";
	});
	$effect(() => {
		requestSessionPreWarm(getCurrentSlug(), sessionState.currentId);
		return () => requestSessionPreWarm(null, null);
	});
	const placeholder = $derived(
		currentSession?.settledAt != null ? "Message to un-settle…" :
		currentSession && isSessionSnoozed(currentSession, sessionState.now) ? "Message to wake…" :
		isProcessing() ? "Reply to steer…" :
		discoveryState.currentProviderId === "opencode" ? "Ask OpenCode…" : "Ask Claude…",
	);

	// Each session keeps its own unsent input text. Switching sessions saves the
	// current draft and restores the target session's draft (or empty string).

	const inputDrafts = new Map<string, string>();
	// undefined until the first run, so a fresh load restores its draft too.
	let previousSessionId: string | null | undefined ;

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

	const commandMatch = $derived(extractCommandQuery(inputText, cursorPos));
	const commandMenuVisible = $derived(commandMatch !== null);
	const commandQuery = $derived(commandMatch?.query ?? "");
	const conduitCommandNames = new Set<string>(
		conduitCommands.flatMap((command) => [command.name, ...command.aliases]),
	);
	const availableCommands = $derived([
		...(!currentSession?.sideThread
			? conduitCommands.flatMap((command) =>
				[command.name, ...command.aliases].map((name) => ({
					name,
					description: command.description,
					builtin: true,
				})),
			)
			: []),
		...discoveryState.commands.filter((command) =>
			!command.builtin || !conduitCommandNames.has(command.name),
		),
	]);
	/** `$` lists Conduit commands and provider built-ins; `/` lists skills. */
	const menuCommands = $derived(
		commandMatch
			? availableCommands.filter(
					(c) => (c.builtin ?? false) === (commandMatch.trigger === "$"),
				)
			: [],
	);
	const filteredCommands = $derived(filterCommands(menuCommands, commandQuery));
	const commandListboxVisible = $derived(filteredCommands.length > 0);

	/** Known `/skill` and `$builtin` names, for inline recognition in the composer. */
	const commandNameSet = $derived(
		new Set(discoveryState.commands.filter((c) => !c.builtin).map((c) => c.name)),
	);
	const builtinNameSet = $derived(
		new Set(availableCommands.filter((c) => c.builtin).map((c) => c.name)),
	);
	const providerBuiltinNameSet = $derived(
		new Set(discoveryState.commands.filter((c) => c.builtin && !conduitCommandNames.has(c.name)).map((c) => c.name)),
	);

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
	const contextWarning = $derived(isContextWarning(currentChat().contextPercent, composerPreferences.contextWarning));
	const compacting = $derived.by(() => {
		const messages = currentChat().messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.type === "system" && message.compaction) return message.compaction === "started";
		}
		return false;
	});
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
	let startingSideThread = false;

	async function sendMessage(textOverride?: string): Promise<boolean> {
		let text = textOverride ?? inputText.trim();
		let sideThread: { sessionId: string; projectSlug: string; images: string[] } | undefined;
		const builtins = providerBuiltinNameSet;
		if (!text) return false;
		if (textOverride === undefined) {
			const match = text.match(/^\$(\S+)(?:\s+([\s\S]*))?$/);
			const command = conduitCommands.find((command) =>
				[command.name, ...command.aliases].some((name) => name === match?.[1]),
			);
			if (command?.handler === "startSideThread") {
				const question = match?.[2]?.trim();
				if (startingSideThread) return false;
				const parentSessionId = sessionState.currentId;
				const projectSlug = getCurrentSlug();
				if (!parentSessionId || !projectSlug) {
					showToast("Open a session to start a Side Thread", { variant: "error" });
					return false;
				}
				// A bare command asks for the list rather than a new Side Thread.
				if (!question) {
					openSideThreads();
					clearComposer();
					return false;
				}
				const draftText = inputText;
				const draftImages = pendingImages;
				const images = pendingImages.map((image) => image.dataUrl);
				startingSideThread = true;
				try {
					const { sessionId } = await startSideThreadRpc({ projectSlug, parentSessionId, title: question });
					sideThread = { sessionId, projectSlug, images };
					if (sessionState.currentId === parentSessionId && inputText === draftText && pendingImages === draftImages) {
						inputText = "";
						pendingImages = [];
						inputDrafts.delete(parentSessionId);
						if (inputSyncTimer) {
							clearTimeout(inputSyncTimer);
							inputSyncTimer = null;
						}
						void syncInputDraftRpc({ projectSlug, sessionId: parentSessionId, text: "", originId: getBrowserClientId() }).catch(() => undefined);
						switchToSession(sessionId, projectSlug);
						await tick();
					}
					text = question;
				} catch (error) {
					showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
					return false;
				} finally {
					startingSideThread = false;
				}
			}
			text = toProviderCommands(text, builtins);
		}

		// Parse @references and fetch file contents
		const refs = textOverride === undefined ? parseAtReferences(text) : [];
		let messageText = text;

		if (refs.length > 0) {
			const attachments: FileAttachment[] = [];

			for (const ref of refs) {
				try {
					if (ref.endsWith("/")) {
						// Directory: fetch listing
						const content = await fetchDirectoryListing(ref, sideThread?.projectSlug ?? getCurrentSlug());
						attachments.push({ path: ref, type: "directory", content });
					} else {
						// File: fetch content
						const result = await fetchFileContent(ref, sideThread?.projectSlug ?? getCurrentSlug());
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
		const imageUrls = sideThread
			? (sideThread.images.length > 0 ? sideThread.images : undefined)
			: textOverride === undefined && pendingImages.length > 0
			? pendingImages.map((img) => img.dataUrl)
			: undefined;

		// Always send immediately — OpenCode queues server-side when busy.
		// When the LLM is processing, `sentDuringEpoch` is recorded so the
		// UI can derive the "Queued" shimmer reactively.
		let sid = sideThread?.sessionId ?? sessionState.currentId;
		// A draft is created in the project its chip names, which can differ
		// from the attached one until the attach round trip lands.
		const projectSlug = sideThread?.projectSlug ?? (sid ? getCurrentSlug() : getDraftProject());
		if (!projectSlug) {
			showToast("No active project", { variant: "error" });
			return false;
		}
		if (!sid) {
			// First send with no active session: create one bound to the selected
			// harness instance (the picker's pre-creation draft), then send into it.
			// A second Enter before the create lands would make a second session.
			if (creatingSession) return false;
			creatingSession = true;
			try {
				// The draft's model pick is client-local until the session exists.
				const instanceId = getEffectiveInstanceId();
				const model = getChosenModel(instanceId);
				const created = await createSessionRpc({
					projectSlug,
					originId: getBrowserClientId(),
					instanceId,
					...(model ? { model } : {}),
				});
				sid = created.sessionId;
				rememberNewSessionProject(projectSlug);
				storeNewSessionDraft("");
				// Don't yank someone who opened another session while this one was created.
				if (!sessionState.currentId) switchToSession(sid, projectSlug);
			} catch {
				showToast("Failed to create session", { variant: "error" });
				return false;
			} finally {
				creatingSession = false;
			}
		}
		const { activity, messages } = getOrCreateSessionSlot(sid);
		addUserMessage(activity, messages, messageText, imageUrls, isProcessing());
		// The turn starts now for the sender; its row reports busy once the
		// provider picks the prompt up, and ends the turn when it goes idle.
		phaseToProcessing(activity);
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
				if (!isSessionBusy(sentToSessionId)) followSessionBusy(sentToSessionId, false);
				showToast("Failed to send message", { variant: "error" });
			});
		});
		if (textOverride !== undefined) return true;
		if (sideThread && (sessionState.currentId !== sideThread.sessionId || inputText !== "" || pendingImages.length > 0)) return true;
		clearComposer();
		return true;
	}

	function clearComposer() {
		pendingImages = [];
		inputText = "";
		cursorPos = 0;
		if (sessionState.currentId) {
			inputDrafts.delete(sessionState.currentId);
		}
		// Cancel any pending debounced draft sync (it would re-sync the old
		// draft text to the server after we just cleared it) and send an
		// immediate empty sync so the server-side draft store is cleared too.
		if (inputSyncTimer) {
			clearTimeout(inputSyncTimer);
			inputSyncTimer = null;
		}
		void syncInputDraft("").catch(() => undefined);
	}

	async function undoGoalClear() {
		const facts = goalFacts;
		const key = clearKey;
		if (facts?.ended !== "cleared" || !facts.endedGoal || facts.sessionId !== sessionState.currentId) return;
		if (await sendMessage(`/goal ${facts.endedGoal.condition}`)) undoneClearKey = key;
	}

	function handleStop() {
		const sessionId = sessionState.currentId;
		const projectSlug = getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		void cancelSessionRpc({
			projectSlug,
			sessionId,
			commandId: crypto.randomUUID(),
		}).then(() => {
			// An interrupt can end a turn the row never reported busy for, so
			// nothing else would end it. A still-busy row ends it on idle.
			if (!isSessionBusy(sessionId)) followSessionBusy(sessionId, false);
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

	function handleAttachSetGoal(condition = "") {
		if (discoveryState.currentProviderId !== "claude") return;
		inputText = `/goal ${condition}`;
		cursorPos = inputText.length;
		requestAnimationFrame(() => {
			textareaEl?.focus();
			textareaEl?.setSelectionRange(inputText.length, inputText.length);
			handleInput();
		});
	}

	$effect(() => {
		function handleGoalAction(event: CustomEvent<GoalComposerAction>) {
			const { action, sessionId, condition } = event.detail;
			if (discoveryState.currentProviderId !== "claude" || sessionId !== sessionState.currentId) return;
			switch (action) {
				case "pause": handleStop(); break;
				case "resume": void sendMessage("Continue."); break;
				case "clear": void sendMessage("/goal clear"); break;
				case "edit": handleAttachSetGoal(condition); break;
				case "new": handleAttachSetGoal(); break;
			}
		}
		window.addEventListener("composer:goal", handleGoalAction);
		return () => window.removeEventListener("composer:goal", handleGoalAction);
	});

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
		// Replace the query region with the selected command text (e.g. "/skill " or "$compact ").
		// User can then type arguments and press Enter to send.
		let newCursorPos: number;
		if (commandMatch) {
			const before = inputText.slice(0, commandMatch.start);
			const after = inputText.slice(commandMatch.end);
			newCursorPos = commandMatch.start + command.length;
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
		if (commandMatch) {
			const before = inputText.slice(0, commandMatch.start);
			const after = inputText.slice(commandMatch.end);
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

	/** Publishes how far the composer's top edge sits above the viewport bottom
	 *  as --composer-clearance, so the toast stack (Toast.svelte) never covers
	 *  it. Measured from the viewport rather than the composer's height because a
	 *  terminal panel below the chat lifts the composer. Watching the parent too
	 *  catches that move, since the chat column shrinks when it happens. */
	function publishComposerClearance(area: HTMLElement) {
		const root = document.documentElement;
		const observer = new ResizeObserver(() => {
			const clearance = area.offsetHeight > 0 ? window.innerHeight - area.getBoundingClientRect().top : 0;
			root.style.setProperty("--composer-clearance", `${Math.max(0, clearance)}px`);
		});
		observer.observe(area);
		if (area.parentElement) observer.observe(area.parentElement);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--composer-clearance");
		};
	}
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

<!-- Command Menu (above input when "/" or "$" is typed) -->
{#if commandMenuVisible}
	<div id="command-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<CommandMenu
			bind:this={commandMenuRef}
			bind:activeIndex={commandMenuActiveIndex}
			listboxId={commandListboxId}
			query={commandQuery}
			visible={commandMenuVisible}
			commands={[...menuCommands]}
			trigger={commandMatch?.trigger ?? "/"}
			onSelect={handleCommandSelect}
			onClose={handleCommandClose}
		/>
	</div>
{/if}

<!-- While the textarea is focused the keyboard covers the home indicator, but iOS
     keeps env(safe-area-inset-bottom) at full size, leaving a dead gap above the
     keyboard. Drop the inset then. -->
<div
	id="input-area"
	{@attach publishComposerClearance}
	class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] has-[textarea:focus]:pb-[12px] max-md:px-3 max-md:py-1.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)] max-md:has-[textarea:focus]:pb-[8px]"
>
	<div id="input-wrapper" class="max-w-[760px] mx-auto relative">
		<!-- Subagent context bar (above input area) -->
		<SubagentBackBar bind:this={subagentBackBarRef} />

		{#if !sessionState.currentId && sessionViewState.compact}
			<div class="pb-1.5"><NewSessionContext /></div>
		{/if}

		{#if isGoalCommand}
			<div
				data-testid="composer-goal-hint"
				class="composer-goal-hint flex items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary"
			>
				<Icon name="target" size={14} class="shrink-0 text-status-violet" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-violet">/goal</b> sets a goal. Claude keeps working, and checks itself after each turn, until it's met.</span>
			</div>
		{/if}

		{#if goal.phase === "met" && goalFacts && !isGoalMetDismissed(goalFacts)}
			<div data-testid="composer-goal-met" class="composer-goal-met flex items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary">
				<Icon name="check" size={14} class="shrink-0 text-status-green" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-green">Goal met</b>{goalFacts.endedGoal?.lastReason ? ` · ${goalFacts.endedGoal.lastReason}` : ""}{goal.subtitle.slice("Goal met".length)}</span>
				<TextButton tone="inherit" data-testid="composer-goal-met-details" class="shrink-0 font-semibold" onclick={() => { goalDetails.open = true; }}>Details</TextButton>
				<Button variant="ghost" size="content" tone="muted" hoverFill="none" iconOnly icon="x" iconSize={12} ariaLabel="Dismiss" class="size-5 shrink-0" onclick={() => { if (goalFacts) dismissGoalMet(goalFacts); }} />
			</div>
		{:else if showClearedGoal}
			<div data-testid="composer-goal-cleared" class="composer-goal-cleared flex items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-muted">
				<Icon name="target" size={14} class="shrink-0" />
				<span class="flex-1 min-w-0">Goal cleared</span>
				<TextButton tone="inherit" class="shrink-0 font-semibold" disabled={!goalFacts?.endedGoal} onclick={undoGoalClear}>Undo</TextButton>
			</div>
		{/if}

		{#if contextWarning && !compacting}
			<div data-testid="composer-context-warning" class="composer-context-warning flex items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary">
				<Icon name="panels-top-left" size={14} class="shrink-0 text-status-amber" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-amber">Context {Math.round(currentChat().contextPercent)}% full.</b> Older turns compact soon.</span>
				{#if discoveryState.currentProviderId === "claude"}
					<TextButton tone="inherit" data-testid="composer-context-compact" class="shrink-0 font-semibold text-status-amber" onclick={() => sendMessage("/compact")}>Compact</TextButton>
				{/if}
			</div>
		{/if}

		{#if currentSession?.limitRecovery && !currentSession.limitRecovery.switched}
			<UsageLimitStrip limitRecovery={currentSession.limitRecovery} sessionId={currentSession.id} projectSlug={currentSession.projectSlug ?? getCurrentSlug() ?? ""} />
		{/if}

		<div
			id="input-row"
			class:goal={goal.border === "solid"}
			class:paused={goal.border === "dashed"}
			class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200 max-md:rounded-[20px] focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>
			{#if working || goal.phase === "checking"}
				<ComposerStatusHeader
					{elapsed}
					{missingPrompt}
					{activity}
					{goal}
					following={sessionViewState.atBottom}
					onlive={requestTranscriptFollow}
					class="-mx-1.5 -mt-1.5 mb-1.5"
				/>
			{/if}
			<TwoRowComposerLayout id="input-bottom" data-testid="composer-layout">
				{#snippet field()}
					<!-- Textarea row.
					     The composer grows with its text and then scrolls, and both of those
					     are CSS here rather than JS: the mirror sizes the row, this container
					     caps and scrolls it, and the textarea is stretched over the mirror at
					     the full content height so it never scrolls on its own. One scroll
					     position for the whole composer means the caret cannot end up on a
					     different line from the text it sits in.
					     `scrollbar-gutter: stable` keeps a scrollbar appearing from narrowing
					     the textarea but not the mirror, which would wrap them differently. -->
					<div class="max-h-[120px] overflow-y-auto [scrollbar-gutter:stable] max-md:[scrollbar-width:none]">
						<!-- Past HIGHLIGHT_MAX_CHARS the mirror renders nothing, so it can no
						     longer size the row: pin the row to the cap and let the textarea
						     scroll itself. Safe only because the mirror is blank in that mode,
						     so there is still just one scroll position in play. -->
						<div class="relative {plainText ? 'h-[120px]' : ''}" style:min-height="max(32px, var(--composer-placeholder-height, 0px))">
							<SkillHighlightBackdrop
								text={plainText ? "" : inputText}
								commandNames={commandNameSet}
								builtinNames={builtinNameSet}
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
								onfocus={() => requestSessionPreWarm(getCurrentSlug(), sessionState.currentId)}
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

				{/snippet}
				{#snippet leading()}
					<div
						id="input-bottom-left"
						class="flex items-center gap-1 min-w-0"
					>
						<!-- Attach button + menu -->
						<AttachMenu onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} onSetGoal={() => handleAttachSetGoal()} />
					</div>
				{/snippet}
				{#snippet controls()}
					{#if composerPreferences.controls === "icons"}
						<div
							id="input-bottom-right"
							class="flex items-center gap-1 min-w-0"
						>
							<!-- Harness instance + model picker -->
							<InstanceModelPicker />

							<!-- Approvals (permission mode) selector -->
							<PermissionModeSelector />
						</div>
					{/if}
				{/snippet}
				{#snippet send()}
					<!-- Send / Stop buttons. While working, send only shows once there is
					     something to steer with; otherwise stop stands alone. -->
					<!-- No tone supplies text-white without a hover step; inherit leaves that colour local.
					     transition-colors replaces the arbitrary transition; 150ms is its default. -->
					{#if !isProcessing() || canSend}
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						hoverFill="none"
						disabledStyle="undimmed"
						iconOnly
						icon={isGoalCommand ? "target" : "arrow-up"}
						iconSize={17}
						id="send"
						data-goal={isGoalCommand ? "true" : "false"}
						type="button"
						class="send-btn shrink-0 w-[32px] h-[32px] rounded-[10px] touch-manipulation hover:not-disabled:opacity-90 active:not-disabled:opacity-70 {isGoalCommand ? 'bg-status-violet text-bg' : 'bg-brand-a text-white'} disabled:bg-send-off-bg disabled:text-send-off"
						disabled={!canSend}
						title={isGoalCommand ? "Set goal" : sendButtonLabel}
						ariaLabel={isGoalCommand ? "Set goal" : sendButtonLabel}
						onclick={handleSendClick}
					/>
					{/if}
					{#if isProcessing()}
						<Button
							variant="ghost"
							size="content"
							tone="inherit"
							hoverFill="none"
							id="stop"
							type="button"
							class="shrink-0 ml-[3px] w-[32px] h-[32px] rounded-[10px] bg-text text-bg touch-manipulation hover:opacity-90 active:opacity-70"
							title="Stop generating"
							ariaLabel="Stop generating"
							onclick={handleStop}
						><i data-testid="stop-square" class="block w-[10px] h-[10px] rounded-[2px] bg-current"></i></Button>
					{/if}
				{/snippet}
			</TwoRowComposerLayout>
		</div>
		{#if composerPreferences.controls === "words"}
			<div
				data-testid="composer-words-row"
				class="flex h-[24px] items-center gap-px px-[6px] pt-[3px] text-[11.5px] text-text-muted whitespace-nowrap"
			>
				<InstanceModelPicker variant="words" />
				<span aria-hidden="true" class="text-border-chip">·</span>
				<PermissionModeSelector variant="words" />
				<span class="flex-1"></span>
				{#if currentChat().contextPercent > 0}
					<span data-testid="composer-word-context-usage" data-warning={contextWarning ? "true" : undefined} class:text-status-amber={contextWarning} class="shrink-0 px-[5px] py-[2px]">{Math.round(currentChat().contextPercent)}%</span>
				{/if}
			</div>
		{/if}
		{#if currentSession?.backgroundTasks?.length}
			<!-- One pulse per live background task; the header row lists them. -->
			<div data-testid="composer-task-dots" aria-hidden="true" class="flex justify-center gap-1.5 pt-[7px]">
				{#each currentSession.backgroundTasks as task, index (task.id)}
					<i class="composer-task-dot" style:animation-delay="{(index % 3) * 0.35}s"></i>
				{/each}
			</div>
		{/if}
		{#if !sessionState.currentId && !sessionViewState.compact}
			<div class="pt-2"><NewSessionContext /></div>
		{/if}
	</div>
</div>

<style>
	.composer-task-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--color-tool);
		animation: composer-task-pulse 1.4s ease-in-out infinite;
	}
	@keyframes composer-task-pulse { 50% { opacity: 0.3; } }
	@media (prefers-reduced-motion: reduce) { .composer-task-dot { animation: none; } }
	:global(#send[data-goal="true"]) {
		background: var(--color-status-violet);
		color: var(--color-bg);
	}

	.composer-goal-hint, .composer-goal-met, .composer-goal-cleared {
		border-color: color-mix(in srgb, var(--goal-bar-color, var(--color-status-violet)) 38%, transparent);
		background: color-mix(in srgb, var(--goal-bar-color, var(--color-status-violet)) 10%, transparent);
	}

	.composer-goal-met {
		--goal-bar-color: var(--color-status-green);
	}

	.composer-goal-cleared {
		--goal-bar-color: var(--color-text-muted);
	}

	.composer-context-warning {
		border-color: color-mix(in srgb, var(--color-status-amber) 38%, transparent);
		background: color-mix(in srgb, var(--color-status-amber) 10%, transparent);
	}

	#input-row.goal {
		border-color: var(--color-status-violet);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-status-violet) 16%, transparent);
	}

	#input-row.paused {
		border: 1px dashed color-mix(in srgb, var(--color-status-violet) 60%, var(--color-border));
		box-shadow: none;
	}
</style>
