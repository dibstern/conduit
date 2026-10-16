<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script module lang="ts">
	// A composer remount must not repeat the same turn's diagnostic.
	const reportedMissingPrompts = new Set<string>();
	let draftId = crypto.randomUUID();
</script>

<script lang="ts">
	import { Schema } from "effect";
	import { WorkspaceMoveError } from "../../../contracts/session-workspace.js";
	import { WorktreeCreationError } from "../../../contracts/worktree.js";
	import { AccountIdSchema } from "../../../contracts/provider-instance.js";
	import { onDestroy, tick, untrack, type Snippet } from "svelte";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Surface from "../ui/Surface.svelte";
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
	import UsageWarningStrip from "./UsageWarningStrip.svelte";
	import InstanceModelPicker from "../model/InstanceModelPicker.svelte";
	import GitIdentity from "../session/GitIdentity.svelte";
	import PermissionModeSelector from "./PermissionModeSelector.svelte";
	import SkillHighlightBackdrop from "./SkillHighlightBackdrop.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import PendingInputTray from "./PendingInputTray.svelte";
	import { openSideThreads } from "../session/side-threads.svelte.js";
	import { stopBackgroundTasks } from "../session/background-tasks.svelte.js";
	import { currentChat, draftSend, followSessionBusy, getOrCreateSessionSlot, inputSyncState, isProcessing, phaseToProcessing, registerInputDraftPersistence, requestScrollOnNextContent } from "../../stores/chat.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { getClaudeAccounts } from "../../stores/claude-accounts.svelte.js";
	import { dismissGoalMet, goalDetails, goalView, isGoalMetDismissed, sessionGoals, type GoalComposerAction } from "../../stores/goal.svelte.js";
	import {
		conduitCommands,
		discoveryState,
		extractCommandQuery,
		filterCommands,
		getAvailableInstances,
		getEffectiveInstanceId,
		getDraftPick,
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
	import { placedSessionId } from "../../stores/transcript.svelte.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { getCurrentRoute, getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { connectionState } from "../../transport/connection-status.svelte.js";
	import { fade } from "svelte/transition";
	import { getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { getDriverTraits, getInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { requestTranscriptFollow, sessionViewState } from "../../stores/session-view.svelte.js";
	import { dismissToast, showToast, uiState } from "../../stores/ui.svelte.js";
	import { composerAccountId, usageState } from "../../stores/usage.svelte.js";
	import { rateLimitChatSend } from "../../stores/ws-send.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { composerPickerState } from "../../stores/composer-picker.svelte.js";
	import { ensureCanonical } from "../../utils/tool-summarizers/ensure-canonical.js";
	import { lookupSummarizer } from "../../utils/tool-summarizers/index.js";
	import { isPaused, segmentTurns, workingTime } from "../../utils/turns.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import { requestDraftPreWarm, requestSessionPreWarm } from "../../utils/session-prewarm.js";
	import { planUsageWindows, usageForecastTime } from "../../utils/continuation.js";
	import { switchSessionAccount } from "../../utils/account-switch.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import type { PendingImage } from "../../types.js";
	import type { InputDelivery, SteerBlocker } from "../../../contracts/stored-event.js";
	import type { WorktreeInfo } from "../../../shared-types.js";

	const inputAreaId = $props.id();
	const fileListboxId = `${inputAreaId}-file-listbox`;
	const commandListboxId = `${inputAreaId}-command-listbox`;
	const composerMoreTitleId = `${inputAreaId}-more-title`;
	let composerMoreOpen = $state(false);
	let composerMoreEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	const phoneIcons = $derived(composerPreferences.controls === "icons" && sessionViewState.composerTier === "phone");
	$effect(() => {
		const request = composerPickerState.request;
		if (request && composerMoreOpen) {
			request.opener = composerMoreEl ?? null;
			composerMoreOpen = false;
		}
	});
	$effect(() => {
		sessionState.currentId;
		sessionViewState.composerTier;
		composerPreferences.controls;
		composerMoreOpen = false;
	});

	let inputText = $state("");
	let draftWorktree = $state<WorktreeInfo | null>(null);
	let draftNewWorktree = $state(false);
	let draftWorktreeBase = $state<string | null>(null);
	let draftModeChosen = $state(false);
	let draftSessionMode = $state<Awaited<ReturnType<typeof rpc<"ResolveSessionMode">>> | undefined>();
	let pendingDraftSessionMode: Promise<void> | undefined;
	const draftRoute = $derived(getCurrentRoute());
	const draftContext = $derived(`${getDraftProject() ?? ""}:${sessionState.currentId ?? ""}:${draftRoute.page === "chat" && draftRoute.draft ? "draft" : "session"}`);
	const sessionModeContext = $derived(`${draftContext}:${sessionState.currentId ? "" : getEffectiveInstanceId()}`);
	$effect(() => {
		draftContext;
		draftWorktree = null;
		draftNewWorktree = false;
		draftWorktreeBase = null;
		draftModeChosen = false;
	});
	$effect(() => {
		sessionModeContext;
		const route = untrack(getCurrentRoute);
		const projectSlug = untrack(getDraftProject);
		draftSessionMode = undefined;
		pendingDraftSessionMode = undefined;
		if (route.page !== "chat" || !route.draft || !projectSlug || untrack(() => sessionState.currentId)) return;
		let current = true;
		pendingDraftSessionMode = rpc("ResolveSessionMode", { projectSlug })
			.then((resolution) => { if (current) draftSessionMode = resolution; })
			.catch((error) => { if (current) toastFailure("Couldn't load default session mode")(error); });
		return () => { current = false; };
	});
	const isGoalCommand = $derived(discoveryState.currentTraits?.supportsGoalState && inputText.startsWith("/goal"));
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let composerFocused = $state(false);
	let pendingImages = $state<PendingImage[]>([]);
	let commandMenuRef: CommandMenu | undefined = $state();
	let fileMenuRef: FileMenu | undefined = $state();
	let commandMenuActiveIndex = $state(0);
	let fileMenuActiveIndex = $state(0);
	let subagentBackBarRef: SubagentBackBar | undefined = $state();
	let cursorPos = $state(0);
	let composing = $state(false);
	const currentSession = $derived(findSession(sessionState.currentId ?? ""));
	const goalFacts = $derived(discoveryState.currentTraits?.supportsGoalState ? sessionGoals.get(sessionState.currentId ?? "") : undefined);
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
	// A queued prompt waits in the tray, so the transcript's last turn is the started one.
	const turn = $derived(segmentTurns(currentChat().messages, isProcessing()).at(-1));
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
		const key = JSON.stringify([sessionId, turn?.id ?? null]);
		if (reportedMissingPrompts.has(key)) return;
		reportedMissingPrompts.add(key);
		const lastRow = chat.transcript?.rows.at(-1);
		const last = chat.messages.at(-1);
		console.error("[turn-clock] Working session has no prompt to time from", {
			sessionId,
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
			if (part.type === "user" || part.type === "result" || (part.type === "assistant" && !part.finalized)) return "";
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
		requestSessionPreWarm(currentSession ? currentSession.projectSlug : getCurrentSlug(), sessionState.currentId);
		return () => requestSessionPreWarm(null, null);
	});
	function draftSessionPayload(projectSlug: string | null) {
		const displayed = getDraftPick();
		if (!projectSlug || !displayed) return undefined;
		return {
			projectSlug,
			originId: getBrowserClientId(),
			draftId,
			...displayed,
			instanceId: AccountIdSchema.make(displayed.instanceId),
			...(draftWorktree ? { worktreePath: draftWorktree.path } : {}),
			...(draftNewWorktree && draftWorktreeBase ? { worktreeBase: draftWorktreeBase } : {}),
		};
	}
	$effect(() => {
		requestDraftPreWarm(
			composerFocused && draftRoute.page === "chat" && draftRoute.draft &&
			!sessionState.currentId && !draftNewWorktree && (draftModeChosen || draftSessionMode !== undefined)
				? draftSessionPayload(getDraftProject()) : undefined,
		);
		return () => requestDraftPreWarm();
	});
	const composerProjectSlug = $derived(currentSession ? currentSession.projectSlug : getDraftProject() ?? "");
	const composerProject = $derived(projectState.projects.find((project) => project.slug === composerProjectSlug));
	const composerDirectory = $derived(composerProject ? effectiveWorkingDirectory(composerProject.folders[0], currentSession?.workspace) : undefined);
	const composerGit = $derived(currentSession?.workspace ? currentSession.git : currentSession?.git ?? composerProject?.git);
	const claudeAccounts = $derived(getClaudeAccounts(composerProjectSlug));
	const accountId = $derived(composerAccountId(currentSession));
	const composerInstance = $derived(getAvailableInstances().find((instance) => instance.id === accountId));
	// The settings row appears in one go. Until the daemon answers, models load
	// and a session link resolves, each control would fill in on its own and
	// guess (an empty store reads as OpenCode). "" is the undialled state, which
	// only Storybook stays in.
	const offline = $derived(["connecting", "disconnected", "error"].includes(connectionState.status));
	const routeSessionId = $derived(getCurrentSessionId());
	const settingsPending = $derived(
		offline || !discoveryState.modelsLoaded || (routeSessionId !== null && sessionState.currentId !== routeSessionId),
	);
	const composerDriver = $derived(composerInstance?.driver);
	const composerTraits = $derived(getDriverTraits(composerDriver));
	const composerPresentation = $derived(getProviderPresentation(composerDriver));
	const supportsWorktree = $derived(composerInstance?.capabilities?.supportsWorktree ?? instanceState.providerCapabilities[composerDriver ?? ""]?.supportsWorktree);
	const usageReading = $derived(claudeAccounts.readingOf(accountId));
	let sendMenuOpen = $state(false);
	let switchingAccount = $state(false);
	const hasOtherClaudeAccount = $derived(claudeAccounts.hasAlternative(accountId));
	const sendAccounts = $derived(currentSession ? claudeAccounts.sendOptions(accountId) : []);
	const switchTarget = $derived(sendAccounts[0]);
	const sendsAt = $derived.by(() => {
		if (usageReading?.status !== "limited") return undefined;
		const resets = planUsageWindows(usageReading)
			.filter((window) => window.utilization >= 100)
			.map((window) => Date.parse(window.resetsAt ?? ""))
			.filter((at) => at > clock.now);
		return resets.length > 0 ? Math.max(...resets) : undefined;
	});
	const sendMode = $derived.by(() => {
		if (sendsAt !== undefined) return usageState.limits.autoSwitch && switchTarget ? "switch" : "at-reset";
		const warnAt = usageState.limits.warnAt;
		return usageReading?.status === "available" && warnAt !== "off" &&
			planUsageWindows(usageReading).some((window) => window.utilization >= warnAt && window.utilization < 100)
			? "warning" : "normal";
	});
	const sendAtTime = $derived(usageForecastTime(sendsAt, clock.now));
	const hasSendMenu = $derived((sendMode === "at-reset" || sendMode === "switch") && hasOtherClaudeAccount);
	$effect(() => {
		// A quota reply belongs to the session and menu opening that requested it.
		currentSession?.id;
		accountId;
		composerProjectSlug;
		usageState.readings;
		if (sendsAt === undefined || !hasOtherClaudeAccount) sendMenuOpen = false;
		claudeAccounts.invalidateSendQuotas();
	});
	const pendingSendsAt = $derived.by(() => {
		const recovery = currentSession?.limitRecovery;
		const scheduledAt = recovery && !recovery.continued && !recovery.switched ? recovery.scheduledAt : undefined;
		return scheduledAt === undefined ? sendsAt : scheduledAt * 1000;
	});
	const placeholder = $derived(
		sendsAt !== undefined
			? sessionViewState.compact ? `Sends at ${sendAtTime}` : `Message${composerPresentation ? ` ${composerPresentation.label}` : ""}… sends at ${sendAtTime}`
			: currentSession?.settledAt != null ? "Message to un-settle…" :
			currentSession && isSessionSnoozed(currentSession, sessionState.now) ? "Message to wake…" :
			composerPresentation ? `Ask ${composerPresentation.label}…` : "Message…",
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
		fileMenuVisible
			? filterFiles(fileTreeState.entries, fileQuery)
			: { entries: [], dividerAt: 0 },
	);
	const fileListboxVisible = $derived(
		fileMenuVisible && (filteredFiles.entries.length > 0 || fileTreeState.loading),
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
			: fileListboxVisible && filteredFiles.entries.length > 0
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
			if (filteredFiles.entries.length === 0) return "Loading files";
			const fileCount = filteredFiles.entries.length;
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

	const draftProject = $derived(projectState.projects.find((project) => project.slug === getDraftProject()));
	const unsupportedDraftFolders = $derived(
		!sessionState.currentId && (draftProject?.folders.length ?? 0) > 1 &&
		getAvailableInstances().find((instance) => instance.id === getEffectiveInstanceId())?.capabilities?.supportsMultiFolder === false,
	);
	// A session drawn from its saved page takes sends once the server places it.
	const unplaced = $derived(placedSessionId() !== sessionState.currentId);
	const canSend = $derived(!unsupportedDraftFolders && !unplaced && (sessionState.currentId !== null || getDraftPick() !== undefined || (instanceState.loaded && !getEffectiveInstanceId())) && (inputText.trim().length > 0 || pendingImages.length > 0));
	const sendButtonLabel = $derived(
		sendMode === "at-reset"
			? `Send at ${sendAtTime}`
			: sendMode === "switch" && switchTarget
				? `Send on ${switchTarget.name}`
			: permissionsState.pendingQuestions.some((question) => question.sessionId === sessionState.currentId)
				? "Reply"
				: isProcessing()
					? "Queue message"
					: "Send",
	);
	/** Whether a send could steer the running turn, from the server's inbox arm:
	 *  hidden (undefined) when idle or the provider can't steer, disabled while a
	 *  prompt is open. Draft-dependent refusals only come back from a steer. */
	const steer = $derived.by(() => {
		const reason = currentChat().transcript?.steer;
		if (!isProcessing() || reason === undefined || reason === "no_steering") return undefined;
		return reason ?? "ready";
	});
	const sendButtonTitle = $derived(
		isGoalCommand ? "Set goal"
		: steer === "ready" ? `${sendButtonLabel} · ⌘/Ctrl+Enter or ⌘/Ctrl+click to ${inputText.trimStart().startsWith("/") ? "stop the turn and run it" : "steer"}`
		: steer === "prompt_open" ? `${sendButtonLabel} · Answer the open prompt before steering`
		: sendButtonLabel,
	);
	const steerPending = $derived(currentChat().transcript?.pending.some((input) => input.state === "steering") ?? false);
	/** The last steer the server refused, shown beside the input box until the draft changes. */
	let steerRefusal = $state<{ sessionId: string; reason: SteerBlocker } | null>(null);
	const STEER_REFUSALS: Record<SteerBlocker, string> = {
		no_steering: "This provider can't steer.",
		prompt_open: "Answer the open prompt first.",
		model_differs: "The running turn uses a different model.",
		agent_differs: "The running turn uses a different agent.",
		variant_differs: "The running turn uses a different effort.",
		slash_command: "Commands can't steer; they queue.",
	};
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
			(navigator.maxTouchPoints > 0 && sessionViewState.compact)
		);
	}

	async function syncInputDraft(text: string): Promise<void> {
		const sessionId = sessionState.currentId;
		const projectSlug = currentSession ? currentSession.projectSlug : getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		await rpc("SyncInputDraft", {
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
		steerRefusal = null;

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
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			sendComposer(steer ? "steer" : "queue");
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			if (isMobile()) {
				// Mobile: Enter inserts newline (default textarea behavior).
				// User taps Send button to send.
				return;
			}
			e.preventDefault();
			sendComposer();
		}
	}

	async function sendOnAccount(instanceId: string, delivery: InputDelivery = "queue"): Promise<boolean> {
		const sessionId = sessionState.currentId;
		const projectSlug = composerProjectSlug;
		const expectedInstanceId = accountId;
		if (!sessionId || !projectSlug || !expectedInstanceId || !canSend || switchingAccount) return false;
		const draft = inputText;
		const images = pendingImages;
		switchingAccount = true;
		try {
			if (!(await switchSessionAccount({ projectSlug, sessionId, instanceId, expectedInstanceId }))) return false;
			await tick();
			// Navigation or edits during the handoff leave the draft for its owner.
			if (sessionState.currentId !== sessionId || composerProjectSlug !== projectSlug || inputText !== draft || pendingImages !== images) return false;
			return await sendMessage(undefined, delivery);
		} finally {
			switchingAccount = false;
		}
	}

	function sendComposer(delivery: InputDelivery = "queue"): Promise<boolean> {
		if (switchingAccount) return Promise.resolve(false);
		return sendMode === "switch" && switchTarget ? sendOnAccount(switchTarget.id, delivery) : sendMessage(undefined, delivery);
	}

	let creatingSession = false;
	let startingSideThread = false;
	// A retry of the same draft reuses its input id, so a reply lost to a
	// dropped socket returns the Side Thread it made instead of a second one.
	let sideThreadAttempt: { draft: string; inputId: string } | undefined;

	async function startSideThread(question: string | undefined): Promise<boolean> {
		if (startingSideThread) return false;
		const parentSessionId = sessionState.currentId;
		const projectSlug = parentSessionId ? findSession(parentSessionId)?.projectSlug ?? getCurrentSlug() : null;
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
		const draft = JSON.stringify([parentSessionId, draftText, draftImages.map((image) => image.dataUrl)]);
		if (sideThreadAttempt?.draft !== draft) sideThreadAttempt = { draft, inputId: crypto.randomUUID() };
		const { inputId } = sideThreadAttempt;
		startingSideThread = true;
		try {
			const images = draftImages.map((image) => image.dataUrl);
			const { sessionId } = await rpc("StartSideThread", {
				projectSlug,
				parentSessionId,
				title: question,
				inputId,
				text: await withReferences(toProviderCommands(question, providerBuiltinNameSet), projectSlug),
				...(images.length > 0 ? { images } : {}),
				originId: getBrowserClientId(),
			});
			sideThreadAttempt = undefined;
			if (sessionState.currentId === parentSessionId && inputText === draftText && pendingImages === draftImages) {
				clearComposer();
				switchToSession(sessionId, projectSlug);
			}
			return true;
		} catch (error) {
			toastFailure("Failed to start Side Thread")(error);
			return false;
		} finally {
			startingSideThread = false;
		}
	}

	/** The text with each @reference's file or directory contents attached. */
	async function withReferences(text: string, projectSlug: string | null): Promise<string> {
		const refs = parseAtReferences(text);
		if (refs.length === 0) return text;
		const attachments: FileAttachment[] = [];
		for (const ref of refs) {
			try {
				if (ref.endsWith("/")) {
					const content = await fetchDirectoryListing(ref, projectSlug);
					attachments.push({ path: ref, type: "directory", content });
				} else {
					const result = await fetchFileContent(ref, projectSlug);
					attachments.push(result.binary ? { path: ref, type: "binary" } : { path: ref, type: "file", content: result.content });
				}
			} catch {
				// Skip files that fail to load
			}
		}
		return buildAttachedMessage(text, attachments);
	}

	async function sendMessage(textOverride?: string, delivery: InputDelivery = "queue"): Promise<boolean> {
		if (unsupportedDraftFolders || unplaced) return false;
		if (!sessionState.currentId && getEffectiveInstanceId() && !getDraftPick()) return false;
		let text = textOverride ?? inputText.trim();
		if (!text) return false;
		if (textOverride === undefined) {
			const match = text.match(/^\$(\S+)(?:\s+([\s\S]*))?$/);
			const command = conduitCommands.find((command) =>
				[command.name, ...command.aliases].some((name) => name === match?.[1]),
			);
			if (command?.handler === "startSideThread") return startSideThread(match?.[2]?.trim());
			text = toProviderCommands(text, providerBuiltinNameSet);
		}

		const messageText = textOverride === undefined ? await withReferences(text, composerProjectSlug) : text;

		// Collect image data URLs from pending images
		const imageUrls = textOverride === undefined && pendingImages.length > 0
			? pendingImages.map((img) => img.dataUrl)
			: undefined;

		// Always send immediately: conduit queues a busy send in the session's
		// tray, and the transcript shows the message once the adapter places it.
		let sid = sessionState.currentId;
		// A draft is created in the project its chip names, which can differ
		// from the attached one until the attach round trip lands.
		const projectSlug = sid ? findSession(sid)?.projectSlug ?? getCurrentSlug() : getDraftProject();
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
			let unsent: { text: string; images: typeof pendingImages } | undefined;
			try {
				// Sending before the default arrives must use the same workspace as
				// the chip. An explicit choice already supplies that workspace.
				const context = sessionModeContext;
				const resolution = pendingDraftSessionMode;
				if (!draftModeChosen) {
					await resolution;
					await tick();
				}
				if (context !== sessionModeContext || resolution !== pendingDraftSessionMode || sessionState.currentId) return false;
				if (!getEffectiveInstanceId()) {
					const presentation = getProviderPresentation(discoveryState.defaultProviderId);
					showToast({
						title: "No account available",
						variant: "error",
						body: getDriverTraits(discoveryState.defaultProviderId)?.accountKind === "config-directory" && presentation
							? `Add a ${presentation.label} account in Settings before sending.`
							: "Add an account in Settings before sending.",
					});
					return false;
				}
				const payload = draftSessionPayload(projectSlug);
				if (!payload) {
					showToast("Select model", { variant: "error" });
					return false;
				}
				requestDraftPreWarm();
				// The message leaves the composer now and shows in the pane until
				// the new session places it; a failed create puts it back.
				if (textOverride === undefined) {
					unsent = { text: inputText, images: pendingImages };
					clearComposer();
				}
				draftSend.message = { type: "user", uuid: crypto.randomUUID(), text: messageText, createdAt: Date.now() };
				draftSend.sessionId = null;
				const created = await rpc("CreateSession", {
					...payload,
					...(draftNewWorktree ? { newWorktree: true } : {}),
				});
				draftId = crypto.randomUUID();
				sid = created.sessionId;
				draftSend.sessionId = sid;
				storeNewSessionDraft("");
				// Don't yank someone who opened another session while this one was created.
				if (!sessionState.currentId) switchToSession(sid, projectSlug);
			} catch (error) {
				if (Schema.is(WorktreeCreationError)(error) || Schema.is(WorkspaceMoveError)(error)) {
					toastFailure("Could not start session")(error);
				} else {
					toastFailure("Failed to create session")(error);
				}
				draftSend.message = null;
				if (unsent && !sessionState.currentId && !inputText) {
					inputText = unsent.text;
					cursorPos = unsent.text.length;
					pendingImages = unsent.images;
				}
				return false;
			} finally {
				creatingSession = false;
			}
		}
		const commandId = crypto.randomUUID();
		if (!isProcessing()) requestScrollOnNextContent();
		const sentToSessionId = sid;
		// An input the inbox hands straight off starts the sender's turn now; the
		// row reports busy once the provider picks it up and ends the turn when it
		// goes idle (ni8.35). A queued, paused or reset-held input starts nothing.
		const { activity, messages } = getOrCreateSessionSlot(sid);
		const startsTurn = activity.phase === "idle" && !isSessionBusy(sid) && sendsAt === undefined
			&& !messages.transcript?.paused && !messages.transcript?.pending.length;
		if (startsTurn) {
			phaseToProcessing(activity);
			activity.awaitingInputId = commandId;
		}
		steerRefusal = null;
		const sent = new Promise<boolean>((resolve) => rateLimitChatSend(() => {
			rpc("input.submit", {
				projectSlug,
				sessionId: sentToSessionId,
				text: messageText,
				inputId: commandId,
				delivery,
				...(imageUrls ? { images: imageUrls } : {}),
				originId: getBrowserClientId(),
			}).then((response) => {
				if (!response.ok) {
					if (draftSend.sessionId === sentToSessionId) draftSend.message = null;
					steerRefusal = { sessionId: sentToSessionId, reason: response.reason };
					return resolve(false);
				}
				if (response.sessionId !== sentToSessionId && sessionState.currentId === sentToSessionId)
					switchToSession(response.sessionId, projectSlug, undefined, { replace: true });
				resolve(true);
			}).catch((error) => {
				if (draftSend.sessionId === sentToSessionId) draftSend.message = null;
				if (startsTurn && !isSessionBusy(sentToSessionId)) followSessionBusy(sentToSessionId, false);
				toastFailure("Failed to send message")(error);
				resolve(false);
			});
		}));
		if (delivery === "steer") {
			// A refused steer admits nothing, so its draft stays until the server takes it.
			if (!(await sent)) return false;
			if (sessionState.currentId !== sentToSessionId) {
				inputDrafts.delete(sentToSessionId);
				return true;
			}
		}
		if (textOverride !== undefined) return true;
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

	let taskStopToast: { id: string; sessionId: string; projectSlug: string } | null = $state(null);
	let composerDestroyed = false;
	$effect(() => {
		const offer = taskStopToast;
		if (!offer) return;
		const count = currentSession?.backgroundTasks?.length ?? 0;
		const active = sessionState.currentId === offer.sessionId && currentSession?.projectSlug === offer.projectSlug;
		const toast = uiState.toasts.find((toast) => toast.id === offer.id);
		untrack(() => {
			if (!active || count === 0 || !toast) {
				dismissToast(offer.id);
				taskStopToast = null;
			} else toast.title = `Turn stopped. ${count} ${count === 1 ? "task" : "tasks"} still running`;
		});
	});
	onDestroy(() => {
		composerDestroyed = true;
		if (taskStopToast) dismissToast(taskStopToast.id);
	});

	function handleStop() {
		const sessionId = sessionState.currentId;
		const projectSlug = currentSession ? currentSession.projectSlug : getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		const accountId = currentSession?.accountId;
		const driver = getInstanceById(accountId ?? "")?.driver;
		const supportsTaskStop = getDriverTraits(driver)?.sessionCapabilities.supportsTaskStop;
		const hadTasks = supportsTaskStop && (currentSession?.backgroundTasks?.length ?? 0) > 0;
		void rpc("CancelSession", {
			projectSlug,
			sessionId,
			commandId: crypto.randomUUID(),
		}).then(() => {
			// An interrupt can end a turn the row never reported busy for, so
			// nothing else would end it. A still-busy row ends it on idle.
			if (!isSessionBusy(sessionId)) followSessionBusy(sessionId, false);
			if (composerDestroyed || !hadTasks || sessionState.currentId !== sessionId || currentSession?.projectSlug !== projectSlug) return;
			const count = findSession(sessionId)?.backgroundTasks?.length ?? 0;
			if (count === 0) return;
			if (taskStopToast) dismissToast(taskStopToast.id);
			const id = showToast(`Turn stopped. ${count} ${count === 1 ? "task" : "tasks"} still running`, {
				duration: 6000,
				action: { label: "Stop them", run: () => {
					if (sessionState.currentId === sessionId && currentSession?.projectSlug === projectSlug) void stopBackgroundTasks(sessionId, projectSlug);
				} },
			});
			taskStopToast = { id, sessionId, projectSlug };
		}).catch(toastFailure("Failed to stop session"));
	}

	function handleSendClick(e: MouseEvent) {
		sendComposer(steer && (e.metaKey || e.ctrlKey) ? "steer" : "queue");
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
		if (!discoveryState.currentTraits?.supportsGoalState) return;
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
			if (!discoveryState.currentTraits?.supportsGoalState || sessionId !== sessionState.currentId) return;
			switch (action) {
				case "pause": handleStop(); break;
				case "resume": void sendMessage("Continue."); break;
				case "clear": void sendMessage("/goal clear", "steer"); break;
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

	/** Edit on a queued row: its text and images come back to the composer. */
	function takeBackQueuedInput(text: string, images: readonly string[]) {
		inputText = inputText.trim() ? `${inputText}\n\n${text}` : text;
		handleInput();
		cursorPos = inputText.length;
		pendingImages = [
			...pendingImages,
			...images.map((dataUrl) => ({ id: crypto.randomUUID(), dataUrl, name: "image", size: dataUrl.length })),
		];
		textareaEl?.focus();
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

{#snippet settingsStatus()}
	<div data-testid="composer-settings-pending" role="status" class="flex items-center gap-2 px-1.5 text-xs text-text-dimmer font-brand whitespace-nowrap">
		<span class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>
		{offline && discoveryState.modelsLoaded ? "Reconnecting to daemon" : "Connecting"}
	</div>
{/snippet}

<!-- File Menu (above input when "@" is typed) -->
{#if fileMenuVisible}
	<div id="file-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<FileMenu
			bind:this={fileMenuRef}
			bind:activeIndex={fileMenuActiveIndex}
			listboxId={fileListboxId}
			query={fileQuery}
			visible={fileMenuVisible}
			entries={filteredFiles.entries}
			dividerAt={filteredFiles.dividerAt}
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

{#snippet phoneMore(rows: Snippet, attention = false, checkout?: Snippet, warning?: Snippet)}
	<Button
		bind:element={composerMoreEl}
		variant="ghost" size="content" tone="inherit" hoverFill="none"
		class="relative h-[26px] shrink-0 rounded-[7px] px-[6px] text-text-secondary hover:bg-text/7"
		ariaLabel={attention ? "Composer options, workspace needs attention" : "Composer options"}
		aria-haspopup="dialog"
		aria-expanded={composerMoreOpen}
		data-testid="composer-more"
		onclick={() => { composerMoreOpen = true; }}
	>
		<Icon name="ellipsis" size={15} />
		{#if attention}<span data-testid="composer-more-attention" class="absolute right-[3px] top-[3px] size-[6px] rounded-full bg-warning ring-[1.5px] ring-input-bg" aria-hidden="true"></span>{/if}
	</Button>
	{#if composerMoreOpen}
		<Dialog open onclose={() => { composerMoreOpen = false; }} placement="sheet" labelledBy={composerMoreTitleId} returnFocus={() => composerMoreEl ?? null}>
			<Surface
				variant="plain" radius="none"
				data-testid="composer-more-sheet"
				class="max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-[18px] border-t border-border px-[16px] pt-[8px] pb-[max(20px,env(safe-area-inset-bottom))] font-brand"
			>
				<div class="mx-auto mb-[10px] h-[4px] w-[36px] rounded-[2px] bg-border-chip" aria-hidden="true"></div>
				<h2 id={composerMoreTitleId} class="mb-[2px] text-[11.5px] font-semibold text-text">Composer</h2>
				{@render rows()}
				<PermissionModeSelector variant="row" />
				{@render checkout?.()}
				{@render warning?.()}
			</Surface>
		</Dialog>
	{/if}
{/snippet}

<!-- While the textarea is focused the keyboard covers the home indicator, but iOS
     keeps env(safe-area-inset-bottom) at full size, leaving a dead gap above the
     keyboard. Drop the inset then. -->
<div
	id="input-area"
	{@attach publishComposerClearance}
	class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] has-[textarea:focus]:pb-[12px] max-md:px-3 max-md:py-1.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)] max-md:has-[textarea:focus]:pb-[8px]"
>
	<div id="input-wrapper" bind:clientWidth={sessionViewState.composerWidth} class="max-w-[760px] mx-auto relative">
		<!-- Subagent context bar (above input area) -->
		<SubagentBackBar bind:this={subagentBackBarRef} />

		{#if !sessionState.currentId && routeSessionId === null && sessionViewState.compact}
			<div class="pb-1.5"><NewSessionContext bind:worktree={draftWorktree} bind:newWorktree={draftNewWorktree} bind:worktreeBase={draftWorktreeBase} bind:modeChosen={draftModeChosen} sessionModeDefault={draftSessionMode} /></div>
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

		<UsageWarningStrip session={currentSession} projectSlug={composerProjectSlug} />

		{#if contextWarning && !compacting}
			<div data-testid="composer-context-warning" class="composer-context-warning flex items-center gap-[7px] mb-2 rounded-2xl border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary">
				<Icon name="panels-top-left" size={14} class="shrink-0 text-status-amber" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-amber">Context {Math.round(currentChat().contextPercent)}% full.</b> Older turns compact soon.</span>
				<TextButton tone="inherit" data-testid="composer-context-compact" class="shrink-0 font-semibold text-status-amber" onclick={() => sendMessage("/compact")}>Compact</TextButton>
			</div>
		{/if}

		{#if currentSession?.limitRecovery && !currentSession.limitRecovery.switched && (currentSession.limitRecovery.scheduledAt === undefined || currentSession.limitRecovery.cutOffMessageId !== undefined)}
			<UsageLimitStrip limitRecovery={currentSession.limitRecovery} sessionId={currentSession.id} projectSlug={currentSession.projectSlug} />
		{/if}

		<PendingInputTray
			inputs={currentChat().transcript?.pending ?? []}
			paused={currentChat().transcript?.paused ?? false}
			sendsAt={pendingSendsAt}
			{steer}
			onEdit={takeBackQueuedInput}
			onSteerRefused={(reason) => { if (sessionState.currentId) steerRefusal = { sessionId: sessionState.currentId, reason }; }}
		/>

		{#if steerRefusal && steerRefusal.sessionId === sessionState.currentId}
			<div data-testid="composer-steer-refused" role="status" class="flex items-center gap-[7px] mb-2 rounded-2xl border border-border px-[10px] py-[7px] text-[11.5px] leading-[1.35] text-text-secondary">
				<Icon name="info" size={14} class="shrink-0 text-status-amber" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-amber">Not steered.</b> {STEER_REFUSALS[steerRefusal.reason]}</span>
				<Button variant="ghost" size="content" tone="muted" hoverFill="none" iconOnly icon="x" iconSize={12} ariaLabel="Dismiss" class="size-5 shrink-0" onclick={() => { steerRefusal = null; }} />
			</div>
		{/if}

		<div
			id="input-row"
			class:goal={goal.border === "solid"}
			class:paused={goal.border === "dashed"}
			class:phone-icons={phoneIcons}
			class="flex flex-col bg-input-bg border border-border {phoneIcons ? 'min-h-[42px] rounded-[14px] py-[5px] pl-[10px] pr-[6px]' : 'rounded-[22px] p-[10px] max-md:rounded-[20px] max-md:p-[9px]'} transition-[border-color,box-shadow] duration-200 focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>
			{#if working || goal.phase === "checking"}
				<ComposerStatusHeader
					{elapsed}
					{missingPrompt}
					{activity}
					{goal}
					following={sessionViewState.atBottom}
					onlive={requestTranscriptFollow}
					class="-mx-[10px] -mt-[10px] mb-1.5 max-md:-mx-[9px] max-md:-mt-[9px]"
				/>
			{/if}
			<TwoRowComposerLayout id="input-bottom" data-testid="composer-layout" splitFooter={composerPreferences.controls === "icons" && sessionViewState.composerTier !== "phone"} style={phoneIcons ? "column-gap: 8px; align-items: center" : undefined}>
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
						<div class="relative {plainText ? 'h-[120px]' : ''}" style:min-height={`max(${phoneIcons ? 30 : 32}px, var(--composer-placeholder-height, 0px))`}>
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
								onfocus={() => {
									composerFocused = true;
									requestSessionPreWarm(currentSession ? currentSession.projectSlug : getCurrentSlug(), sessionState.currentId);
								}}
								onblur={() => { composerFocused = false; }}
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
					{#if composerPreferences.controls === "icons" && settingsPending}
						{@render settingsStatus()}
					{:else if composerPreferences.controls === "icons"}
						<div
							in:fade={{ duration: 180 }}
							id="input-bottom-right"
							data-testid={sessionViewState.composerTier !== "phone" ? "composer-icons-left" : undefined}
							class="flex items-center min-w-0 {sessionViewState.composerTier === 'phone' ? 'gap-1' : 'shrink-0 gap-[2px]'}"
						>
							<!-- Harness instance + model picker -->
						<InstanceModelPicker>
								{#snippet phoneControls(rows)}
									<PermissionModeSelector />
									{#if currentSession && composerDirectory}
										{@const session = currentSession}
										{#key session.id}
											<GitIdentity
												presentation="row"
												directory={composerDirectory}
												git={composerGit}
												workspaceCause={session.workspace?.cause}
												workspaceMissing={session.workspaceMissing}
												workspaceMismatch={session.workspaceMismatch}
												workspaceHint={session.workspaceHint}
												loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { projectSlug: composerProjectSlug, sessionId: session.id }) : undefined}
												onmove={(path) => rpc("MoveSessionWorkspace", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
												onrecreate={() => rpc("RecreateSessionWorktree", { projectSlug: composerProjectSlug, sessionId: session.id })}
												oncontinue={() => rpc("ContinueSessionInMainFolder", { projectSlug: composerProjectSlug, sessionId: session.id })}
												ondismiss={(path) => rpc("DismissWorkspaceHint", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
												onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { projectSlug: composerProjectSlug, sessionId: session.id, branchName }) : undefined}
											>
												{#snippet children(attention, checkout, warning)}
													{@render phoneMore(rows, attention, checkout, warning)}
												{/snippet}
											</GitIdentity>
										{/key}
									{:else}
										{@render phoneMore(rows)}
									{/if}
								{/snippet}
							</InstanceModelPicker>

							<!-- Approvals (permission mode) selector -->
							{#if sessionViewState.composerTier !== "phone"}<PermissionModeSelector />{/if}
						</div>
					{/if}
				{/snippet}
				{#snippet send()}
					{#if composerPreferences.controls === "icons" && sessionViewState.composerTier !== "phone" && !settingsPending && currentSession && composerDirectory}
						{@const session = currentSession}
						{#key session.id}
							<GitIdentity
								presentation="control"
								directory={composerDirectory}
								git={composerGit}
								workspaceCause={session.workspace?.cause}
								workspaceMissing={session.workspaceMissing}
								workspaceMismatch={session.workspaceMismatch}
								workspaceHint={session.workspaceHint}
								loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { projectSlug: composerProjectSlug, sessionId: session.id }) : undefined}
								onmove={(path) => rpc("MoveSessionWorkspace", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
								onrecreate={() => rpc("RecreateSessionWorktree", { projectSlug: composerProjectSlug, sessionId: session.id })}
								oncontinue={() => rpc("ContinueSessionInMainFolder", { projectSlug: composerProjectSlug, sessionId: session.id })}
								ondismiss={(path) => rpc("DismissWorkspaceHint", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
								onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { projectSlug: composerProjectSlug, sessionId: session.id, branchName }) : undefined}
							/>
						{/key}
					{/if}
					{#snippet sendAtLabel()}
						<span data-testid="composer-send-at-label">{sessionViewState.compact ? sendAtTime.replace(/^(\d\S*) (?:am|pm)$/, "$1") : `Send at ${sendAtTime}`}</span>
					{/snippet}
					<!-- Send / Stop buttons. While working, send only shows once there is
					     something to steer with; otherwise stop stands alone. -->
					<!-- No tone supplies text-white without a hover step; inherit leaves that colour local.
					     transition-colors replaces the arbitrary transition; 150ms is its default. -->
					{#if !isProcessing() || canSend}
					{#if hasSendMenu}
					<div data-testid="composer-send-control" class="inline-flex shrink-0 items-center rounded-full border font-mono text-[10.5px] whitespace-nowrap {sendMode === 'switch' ? 'border-border text-text' : 'border-status-red/50 text-status-red'} {sessionViewState.compact ? 'h-[32px]' : 'h-[26px]'}">
						<Button
							variant="ghost"
							size="content"
							tone="inherit"
							hoverFill="none"
							disabledStyle="undimmed"
							{...(sendMode === "switch" && sessionViewState.compact ? {} : { icon: sendMode === "switch" ? "arrow-up" : "clock" })}
							iconSize={13}
							id="send"
							data-goal={isGoalCommand ? "true" : "false"}
							data-send-mode={sendMode}
							type="button"
							class="send-btn h-full gap-[5px] rounded-l-full px-[10px] pr-[2px] font-mono text-[10.5px] touch-manipulation hover:not-disabled:opacity-90 active:not-disabled:opacity-70"
							disabled={!canSend || switchingAccount}
							title={sendButtonTitle}
							ariaLabel={sendButtonLabel}
							onclick={handleSendClick}
						>
							{#if sendMode === "switch" && switchTarget}
								{#if !sessionViewState.compact}<span>Send on</span>{/if}
								<AccountDot instanceId={switchTarget.id} size={7} />
								<span data-testid="composer-send-switch-label">{switchTarget.name}</span>
							{:else}
								{@render sendAtLabel()}
							{/if}
						</Button>
						<Menu
							bind:open={sendMenuOpen}
							onopenchange={(open) => {
								if (open) void claudeAccounts.refreshQuotas("send");
								else claudeAccounts.invalidateSendQuotas(false);
							}}
							presentation={sessionViewState.compact ? "sheet" : "popover"}
							side="top"
							align="end"
							ariaLabel="Send options"
							class={sessionViewState.compact ? "px-[14px]" : "w-[250px] p-[5px]"}
							data-testid="composer-send-menu"
						>
							{#snippet trigger({ props })}
								<Button {...props} variant="ghost" size="content" tone="inherit" hoverFill="none" iconOnly icon="chevron-down" iconSize={11} ariaLabel="Send options" data-testid="composer-send-menu-trigger" disabled={switchingAccount} class="h-full w-[24px] rounded-r-full pr-[4px] touch-manipulation hover:not-disabled:opacity-90" />
							{/snippet}
							<MenuItem density="compact" data-testid="composer-send-menu-reset" data-selected="true" disabled={!canSend || switchingAccount} class="rounded-[7px] bg-border-chip" onselect={() => void sendMessage()}>
								<Icon name="clock" size={13} class="shrink-0 text-status-red" />
								<span class="flex-1">Send at {sendAtTime}</span>
								<span class="font-mono text-[10.5px] text-text-dimmer">{claudeAccounts.nameOf(accountId)}</span>
							</MenuItem>
							{#each sendAccounts as option (option.id)}
								<MenuItem density="compact" data-testid="composer-send-menu-account" data-account={option.id} disabled={!canSend || switchingAccount} class="rounded-[7px]" onselect={() => void sendOnAccount(option.id)}>
									<AccountDot instanceId={option.id} size={7} />
									<span class="flex-1">Send now on {option.name}</span>
									<span class="font-mono text-[10.5px] text-text-dimmer">{option.fullest.kind === "five_hour" ? "5h" : "wk"} {Math.round(option.fullest.utilization)}%</span>
								</MenuItem>
							{/each}
							<div data-testid="composer-send-menu-note" class="mt-[3px] border-t border-border px-[6px] pt-[5px] pb-[3px] font-mono text-[10.5px] text-text-dimmer whitespace-normal">Another account takes over the session, as Switch account does.</div>
						</Menu>
					</div>
					{:else}
					<Button
						variant="ghost"
						size="content"
						tone="inherit"
						hoverFill="none"
						disabledStyle="undimmed"
						{...(sendMode === "at-reset" ? { iconOnly: false as const, children: sendAtLabel } : { iconOnly: true as const })}
						icon={sendMode === "at-reset" ? "clock" : isGoalCommand ? "target" : "arrow-up"}
						iconSize={sendMode === "at-reset" || phoneIcons ? 13 : 17}
						id="send"
						data-goal={isGoalCommand ? "true" : "false"}
						data-send-mode={sendMode}
						type="button"
						class="send-btn shrink-0 touch-manipulation hover:not-disabled:opacity-90 active:not-disabled:opacity-70 {sendMode === 'at-reset' ? 'gap-[5px] rounded-full border border-status-red/50 px-[10px] font-mono text-[10.5px] text-status-red whitespace-nowrap' : (phoneIcons ? 'w-[30px] rounded-[9px] ' : 'w-[32px] rounded-[10px] ') + (isGoalCommand ? 'bg-status-violet text-bg' : 'bg-brand-a text-white')} {sendMode === 'at-reset' && !sessionViewState.compact ? 'h-[26px]' : phoneIcons && sendMode !== 'at-reset' ? 'h-[30px]' : 'h-[32px]'} {sendMode === 'at-reset' ? '' : 'disabled:bg-send-off-bg disabled:text-send-off'}"
						disabled={!canSend}
						title={sendButtonTitle}
						ariaLabel={isGoalCommand ? "Set goal" : sendButtonLabel}
						onclick={handleSendClick}
					/>
					{/if}
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
							title={steerPending ? "Stop generating · A pending steer still runs" : "Stop generating"}
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
				class="flex h-[24px] items-center justify-between gap-[14px] px-[6px] pt-[3px] text-[11.5px] text-text-muted whitespace-nowrap"
			>
				{#if settingsPending}
					{@render settingsStatus()}
				{:else}
				<div in:fade={{ duration: 180 }} data-testid="composer-words-left" class="inline-flex min-w-0 shrink-0 items-center gap-[5px]">
					<InstanceModelPicker variant="words" />
					{#if (composerTraits?.composerModeControl ?? "permission-mode") === "permission-mode"}
						<span aria-hidden="true" class="text-border-chip">·</span>
						<PermissionModeSelector variant="words" />
					{/if}
				</div>
				<div in:fade={{ duration: 180 }} data-testid="composer-words-right" class="inline-flex min-w-0 shrink items-center justify-end gap-[5px]">
					{#if currentSession}
						{@const session = currentSession}
						{#if composerDirectory}
							{#key session.id}
								<GitIdentity
									presentation="word"
									directory={composerDirectory}
									git={composerGit}
									workspaceCause={session.workspace?.cause}
									workspaceMissing={session.workspaceMissing}
									workspaceMismatch={session.workspaceMismatch}
									workspaceHint={session.workspaceHint}
									loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { projectSlug: composerProjectSlug, sessionId: session.id }) : undefined}
									onmove={(path) => rpc("MoveSessionWorkspace", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
									onrecreate={() => rpc("RecreateSessionWorktree", { projectSlug: composerProjectSlug, sessionId: session.id })}
									oncontinue={() => rpc("ContinueSessionInMainFolder", { projectSlug: composerProjectSlug, sessionId: session.id })}
									ondismiss={(path) => rpc("DismissWorkspaceHint", { projectSlug: composerProjectSlug, sessionId: session.id, path })}
									onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { projectSlug: composerProjectSlug, sessionId: session.id, branchName }) : undefined}
								/>
							{/key}
						{/if}
						{#if currentChat().contextPercent > 0}
							<span data-testid="composer-word-context-usage" data-warning={contextWarning ? "true" : undefined} class:text-status-amber={contextWarning} class="shrink-0 pl-[4px]">{Math.round(currentChat().contextPercent)}%</span>
						{/if}
					{/if}
				</div>
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
		{#if !sessionState.currentId && routeSessionId === null && !sessionViewState.compact}
			<div class="pt-2"><NewSessionContext bind:worktree={draftWorktree} bind:newWorktree={draftNewWorktree} bind:worktreeBase={draftWorktreeBase} bind:modeChosen={draftModeChosen} sessionModeDefault={draftSessionMode} /></div>
		{/if}
	</div>
</div>

<style>
	.phone-icons :global(.composer-text-metrics) {
		font-size: 12.5px;
		line-height: 20px;
		padding: 5px 0;
	}
	.phone-icons :global(#attach-btn) {
		width: 15px;
		height: 30px;
	}
	.phone-icons :global(#attach-btn svg) {
		width: 15px;
		height: 15px;
	}

	.composer-task-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--color-tool);
		animation: composer-task-pulse 1.4s ease-in-out infinite;
	}
	@keyframes composer-task-pulse { 50% { opacity: 0.3; } }
	@media (prefers-reduced-motion: reduce) { .composer-task-dot { animation: none; } }
	:global(#send[data-goal="true"]:not([data-send-mode="at-reset"]):not([data-send-mode="switch"])) {
		background: var(--color-status-violet);
		color: var(--color-bg);
	}
	:global(#send[data-send-mode="warning"]) {
		box-shadow: 0 0 0 2px var(--color-bg), 0 0 0 3.5px var(--color-status-amber);
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
