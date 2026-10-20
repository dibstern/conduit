<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script lang="ts">
	import Popover from "../ui/Popover.svelte";
	import ComposerFrame from "../ui/ComposerFrame.svelte";
	import ComposerStrip from "../ui/ComposerStrip.svelte";
	import ComposerSendGroup from "../ui/ComposerSendGroup.svelte";
	import { AccountIdSchema, getProviderDriver } from "../../../contracts/provider-instance.js";
	import { tick, untrack, type Snippet } from "svelte";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TwoRowComposerLayout from "../ui/TwoRowComposerLayout.svelte";
	import AttachMenu from "./AttachMenu.svelte";
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
	import { projectReferences, serializeReferences } from "../../../composer-references.js";
	import { referenceEditing } from "./reference-editing.js";
	import { provideComposerDraft } from "./composer-reference.svelte.js";
	import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import PendingInputTray from "./PendingInputTray.svelte";
	import { openSideThreads } from "../session/side-threads.svelte.js";
	import { currentChat, draftSend, isProcessing, registerInputDraft, requestScrollOnNextContent } from "../../stores/chat.svelte.js";
	import { send, stop, turn as readTurn } from "../../stores/turn.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { approvals } from "../../stores/composer-settings.svelte.js";
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
	import { fetchFileContent, fetchDirectoryListing, prepareFileAttachment } from "./input-utils.js";
	import { parseAttachmentDataUrl } from "../../../attachment-data-url.js";
	import { findSession, isSessionSnoozed, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { getCurrentRoute, getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { connectionState } from "../../transport/connection-status.svelte.js";
	import { createComposerDraft } from "../../stores/composer-draft/runner.svelte.js";
	import { fade } from "svelte/transition";
	import { getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { getDriverTraits, instanceState } from "../../stores/instance.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast, uiState } from "../../stores/ui.svelte.js";
	import { composerAccountId, usageState } from "../../stores/usage.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { composerPickerState } from "../../stores/composer-picker.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import { requestDraftPreWarm, requestSessionPreWarm } from "../../utils/session-prewarm.js";
	import { planUsageWindows, usageForecastTime } from "../../utils/continuation.js";
	import { switchSessionAccount } from "../../utils/account-switch.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import type { FileAttachment } from "../../utils/file-attach.js";
	import type { PendingAttachment, SessionPermissionMode } from "../../types.js";
	import type { InputDelivery, SteerBlocker } from "../../../contracts/stored-event.js";
	import type { WorktreeInfo } from "../../../shared-types.js";

	const inputAreaId = $props.id();
	const fileListboxId = `${inputAreaId}-file-listbox`;
	const commandListboxId = `${inputAreaId}-command-listbox`;
	let composerWrapperEl: HTMLDivElement | undefined = $state();
	let composerMoreOpen = $state(false);
	$effect(() => {
		const request = composerPickerState.request;
		if (request && composerMoreOpen) {
			request.opener = composerWrapperEl?.querySelector<HTMLElement>('[data-testid="model-picker-trigger"], [data-testid="composer-words-sheet-trigger"]') ?? request.opener;
			composerMoreOpen = false;
		}
	});
	$effect(() => {
		sessionState.currentId;
		sessionViewState.composerTier;
		composerPreferences.controls;
		composerMoreOpen = false;
	});

	const composerDraft = createComposerDraft({
		key: () => {
			const route = getCurrentRoute();
			return route.page !== "chat" ? null : route.sessionId ? { session: route.sessionId } : route.draftId ? { draft: route.draftId } : null;
		},
		projectSlug: getDraftProject,
		hasAttachments: () => pendingAttachments.length > 0 || readingAttachments > 0,
	});
	let draftWorktree = $state<WorktreeInfo | null>(null);
	let draftNewWorktree = $state(false);
	let draftWorktreeBase = $state<string | null>(null);
	let draftModeChosen = $state(false);
	let draftSessionMode = $state<Awaited<ReturnType<typeof rpc<"ResolveSessionMode">>> | undefined>();
	let pendingDraftSessionMode: Promise<void> | undefined;
	const draftRoute = $derived(getCurrentRoute());
	const draftId = $derived(draftRoute.page === "chat" ? draftRoute.draftId : undefined);
	const draftContext = $derived(`${getDraftProject() ?? ""}:${sessionState.currentId ?? ""}:${draftId ?? "session"}`);
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
	const supportsGoal = $derived(discoveryState.currentTraits?.supportsGoalState === true);
	const isGoalCommand = $derived(supportsGoal && /^[/$]goal(?:\s|$)/.test(composerDraft.text));
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	const referenceEditor = referenceEditing({ read: () => composerDraft.text, write: (text) => { composerDraft.text = text; }, context: () => draftContext, element: () => textareaEl, changed: handleInput });
	const referenceView = $derived(projectReferences(composerDraft.text));
	$effect(() => provideComposerDraft({ sessionId: () => sessionState.currentId, draft: () => composerDraft.text, insert: (reference) => { if (!readOnlySubagent) referenceEditor.insert(reference); }, remove: referenceEditor.remove }));
	let fieldScroller: HTMLDivElement | undefined = $state();
	let composerFocused = $state(false);
	let pendingAttachments = $state<PendingAttachment[]>([]);
	let readingAttachments = $state(0);
	let attachmentError = $state("");
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
	const turnControl = $derived(readTurn());
	const working = $derived(turnControl.working);
	$effect(() => {
		requestSessionPreWarm(readOnlySubagent ? null : sessionState.currentId);
		return () => requestSessionPreWarm(null);
	});
	function draftSessionPayload(projectSlug: string | null) {
		const displayed = getDraftPick();
		if (!projectSlug || !displayed || !draftId) return undefined;
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
	// Wait for accounts and session placement before showing settings. Catalog
	// loading belongs to the picker, which must stay available to switch accounts.
	const offline = $derived(["connecting", "disconnected", "error"].includes(connectionState.status));
	const routeSessionId = $derived(getCurrentSessionId());
	const settingsPending = $derived(
		offline || (!sessionState.currentId && !instanceState.loaded) || (routeSessionId !== null && sessionState.currentId !== routeSessionId),
	);
	const composerDriver = $derived(composerInstance?.driver);
	const composerTraits = $derived(getDriverTraits(composerDriver));
	const composerPresentation = $derived(getProviderPresentation(composerDriver));
	const readOnlySubagent = $derived(
		getProviderDriver(composerDriver)?.readOnlySubagents === true && !!sessionState.currentParentId &&
		!currentSession?.sideThread,
	);
	const composerNotices: Partial<Record<SessionPermissionMode, string>> | undefined = $derived(composerPresentation?.composerNotice);
	const composerNotice = $derived(composerNotices?.[approvals.current?.mode ?? "ask"]);
	const supportsWorktree = $derived(composerInstance?.capabilities?.supportsWorktree ?? instanceState.providerCapabilities[composerDriver ?? ""]?.supportsWorktree);
	const usageReading = $derived(claudeAccounts.readingOf(accountId));
	let sendMenuOpen = $state(false);
	let switchingAccount = $state(false);
	const hasOtherClaudeAccount = $derived(claudeAccounts.hasAlternative(accountId));
	const sendAccounts = $derived(currentSession ? claudeAccounts.sendOptions(accountId) : []);
	const sendsAt = $derived.by(() => {
		if (usageReading?.status !== "limited") return undefined;
		const resets = planUsageWindows(usageReading)
			.filter((window) => window.utilization >= 100)
			.map((window) => Date.parse(window.resetsAt ?? ""))
			.filter((at) => at > clock.now);
		return resets.length > 0 ? Math.max(...resets) : undefined;
	});
	const sendPick = $derived.by(() => {
		const pick = composerDraft.sendPick;
		if (settingsPending || sendsAt === undefined || !hasOtherClaudeAccount) return undefined;
		if (pick?.mode === "at-reset" && pick.accountId === accountId) return pick;
		if (pick?.mode === "switch" && sendAccounts.some((account) => account.id === pick.accountId)) return pick;
		return undefined;
	});
	$effect(() => {
		if (!settingsPending && composerDraft.sendPick && !sendPick) composerDraft.sendPick = undefined;
	});
	const switchTarget = $derived(sendPick?.mode === "switch"
		? sendAccounts.find((account) => account.id === sendPick.accountId)
		: sendAccounts[0]);
	const sendMode = $derived.by(() => {
		if (sendsAt !== undefined) return sendPick?.mode ?? (usageState.limits.autoSwitch && switchTarget ? "switch" : "at-reset");
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
			? `Message${composerPresentation ? ` ${composerPresentation.label}` : ""}… sends at ${sendAtTime}`
			: currentSession?.settledAt != null ? "Message to un-settle…" :
			currentSession && isSessionSnoozed(currentSession, sessionState.now) ? "Message to wake…" :
			sessionViewState.compact ? "Reply…" :
			messageSurfacing.status.active ? "Reply… (↩ Reply on a message drops a reference here)" :
			composerPresentation ? `Reply to ${composerPresentation.label}…` : "Reply…",
	);

	// + opens a draft ready to type into.
	$effect(() => {
		const route = getCurrentRoute();
		if (route.page === "chat" && route.draft) untrack(() => textareaEl?.focus());
	});

	$effect(() => registerInputDraft(addToDraft));

	const commandMatch = $derived(extractCommandQuery(composerDraft.text, cursorPos));
	const commandMenuVisible = $derived(commandMatch !== null);
	const commandQuery = $derived(commandMatch?.query ?? "");
	const conduitCommandNames = new Set<string>(
		conduitCommands.flatMap((command) => [command.name, ...command.aliases]),
	);
	const availableCommands = $derived([
		...(supportsGoal ? [{ name: "goal", description: "Keep working until something is true", builtin: true }] : []),
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
			(!command.builtin || !conduitCommandNames.has(command.name)) && !(supportsGoal && command.name === "goal"),
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
	// The preview prepares the text exactly as sending does, attached file
	// contents included, so it only runs while open. The last result stays up
	// while the next one loads.
	let previewOpen = $state(false);
	let preview = $state<string>();
	$effect(() => {
		if (!previewOpen || !referenceView.references.length) return;
		let current = true;
		void withReferences(toProviderCommands(composerDraft.text.trim(), providerBuiltinNameSet), composerProjectSlug).then((text) => {
			if (current) preview = serializeReferences(text);
		});
		return () => {
			current = false;
		};
	});

	/** Known `/skill` and `$builtin` names, for inline recognition in the composer. */
	const commandNameSet = $derived(
		new Set([...discoveryState.commands.filter((c) => !c.builtin).map((c) => c.name), ...(supportsGoal ? ["goal"] : [])]),
	);
	const builtinNameSet = $derived(
		new Set(availableCommands.filter((c) => c.builtin).map((c) => c.name)),
	);
	const providerBuiltinNameSet = $derived(
		new Set([...discoveryState.commands.filter((c) => c.builtin && !conduitCommandNames.has(c.name)).map((c) => c.name), ...(supportsGoal ? ["goal"] : [])]),
	);

	const atQuery = $derived(extractAtQuery(composerDraft.text, cursorPos));
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
	const plainText = $derived(!referenceView.references.length && referenceView.text.length > HIGHLIGHT_MAX_CHARS);
	// Set when the draft crosses into plain text; revealCaret() consumes it.
	let enteredPlainText = false;
	$effect(() => {
		if (plainText) enteredPlainText = true;
	});

	const canSend = $derived(readingAttachments === 0 && !readOnlySubagent && turnControl.ready && (composerDraft.text.trim().length > 0 || pendingAttachments.length > 0));
	const sendButtonLabel = $derived(
		sendMode === "at-reset"
			? `Send at ${sendAtTime}`
			: sendMode === "switch" && switchTarget
				? `Send on ${switchTarget.name}`
			: permissionsState.pendingQuestions.some((question) => question.sessionId === sessionState.currentId)
				? "Reply"
				: working
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
		: steer === "ready" ? `${sendButtonLabel} · ⌘/Ctrl+Enter or ⌘/Ctrl+click to ${composerDraft.text.trimStart().startsWith("/") ? "stop the turn and run it" : "steer"}`
		: steer === "prompt_open" ? `${sendButtonLabel} · Answer the open prompt before steering`
		: sendButtonLabel,
	);
	const steerPending = $derived(currentChat().transcript?.pending.some((input) => input.state === "steering") ?? false);
	/** The last steer the server refused, shown beside the input box until the draft changes. */
	let steerRefusal = $state<{ sessionId: string; reason: SteerBlocker } | null>(null);
	let dismissedRefusal = $state.raw<typeof turnControl.refusal>(null);
	const visibleRefusal = $derived(
		steerRefusal?.sessionId === sessionState.currentId ? steerRefusal
			: turnControl.refusal !== dismissedRefusal ? turnControl.refusal : null,
	);
	const STEER_REFUSALS: Record<SteerBlocker, string> = {
		no_steering: "This provider can't steer.",
		prompt_open: "Answer the open prompt first.",
		model_differs: "The running turn uses a different model.",
		agent_differs: "The running turn uses a different agent.",
		variant_differs: "The running turn uses a different effort.",
		slash_command: "Commands can't steer; they queue.",
	};
	const contextWarning = $derived(isContextWarning(currentChat().contextPercent, composerPreferences.contextWarning));
	let contextDismissed = $state(false);
	let clearedGoalDismissed = $state(false);
	const contextDismissalKey = $derived(`conduit:context-warning-dismissed:${sessionState.currentId ?? "draft"}`);
	$effect(() => {
		const key = contextDismissalKey;
		try { contextDismissed = localStorage.getItem(key) === "true"; } catch { contextDismissed = false; }
	});
	$effect(() => {
		if (contextWarning || currentChat().loadLifecycle !== "ready") return;
		contextDismissed = false;
		try { localStorage.removeItem(contextDismissalKey); } catch { /* The current tab still rearms. */ }
	});
	$effect(() => {
		const key = clearKey;
		try { clearedGoalDismissed = key !== null && localStorage.getItem(`conduit:goal-cleared-dismissed:${key}`) === "true"; }
		catch { clearedGoalDismissed = false; }
	});
	function dismissClearedGoal() {
		clearedGoalDismissed = true;
		try { if (clearKey) localStorage.setItem(`conduit:goal-cleared-dismissed:${clearKey}`, "true"); }
		catch { /* Keep the in-memory dismissal. */ }
	}
	function dismissContextWarning() {
		contextDismissed = true;
		try { localStorage.setItem(contextDismissalKey, "true"); } catch { /* Keep the in-memory dismissal. */ }
	}
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

	function handleInput() {
		if (textareaEl) {
			cursorPos = referenceEditor.selection().start;
		}
		composerDraft.edited();
		void tick().then(revealCaret);
		steerRefusal = null;
		dismissedRefusal = turnControl.refusal;
	}

	/**
	 * Bring the caret's line into the composer's scroll window. The browser does
	 * this itself as part of an edit, but for some edits (IME commits, dictation,
	 * `insertText`) it does so before the mirror has grown the row to fit the new
	 * text, while the scroller is still too short to reach the caret, and nothing
	 * scrolls again once the row grows. So once the mirror has caught up, measure
	 * the caret with a probe laid out exactly like both layers and scroll to it.
	 * Past HIGHLIGHT_MAX_CHARS the textarea is its own scroller and the browser
	 * keeps the caret in it, so only the edit that crosses the limit needs help:
	 * it swaps scrollers, and the new one comes up at the top. A probe there lays
	 * the whole draft out once, so a caret at the end just takes the bottom.
	 */
	function revealCaret() {
		if (!textareaEl || (plainText && !enteredPlainText)) return;
		enteredPlainText = false;
		const { value, selectionEnd, clientWidth } = textareaEl;
		if (plainText && selectionEnd === value.length) {
			textareaEl.scrollTop = textareaEl.scrollHeight;
			return;
		}
		const scroller = plainText ? textareaEl : fieldScroller;
		if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
		const probe = document.createElement("div");
		probe.className = "composer-text-metrics";
		probe.style.cssText = `position: absolute; inset: 0 auto auto 0; width: ${clientWidth}px; box-sizing: border-box; visibility: hidden`;
		// The whole draft, so text after the caret wraps the caret's word as it does
		// in the field; an empty marker adds no break opportunity of its own.
		const caret = document.createElement("span");
		probe.append(value.slice(0, selectionEnd), caret, value.slice(selectionEnd));
		textareaEl.after(probe);
		const { lineHeight, paddingTop } = getComputedStyle(probe);
		// An empty marker's box is the line's top edge, or its glyph box inside text.
		const top = caret.getBoundingClientRect().top - (plainText ? textareaEl.scrollTop : 0);
		probe.remove();
		// The field's own padding as margin, so the caret's line never sits on the clip edge.
		const margin = parseFloat(paddingTop);
		const view = scroller.getBoundingClientRect();
		const below = top + parseFloat(lineHeight) + margin - view.bottom;
		const above = view.top - (top - margin);
		if (below > 0) scroller.scrollTop += below;
		else if (above > 0) scroller.scrollTop -= above;
	}

	function handleKeyup() {
		referenceEditor.select();
		if (textareaEl) {
			cursorPos = referenceEditor.selection().start;
		}
	}

	function handleClick() {
		referenceEditor.select();
		if (textareaEl) {
			cursorPos = referenceEditor.selection().start;
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
		if (referenceEditor.keydown(e)) return;
		if (e.key === "Escape" && isGoalCommand) {
			e.preventDefault();
			composerDraft.text = composerDraft.text.replace(/^[/$]goal\s*/, "");
			handleInput();
			cursorPos = composerDraft.text.length;
			return;
		}
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
		const draft = composerDraft.text;
		const images = pendingAttachments;
		switchingAccount = true;
		try {
			if (!(await switchSessionAccount({ sessionId, instanceId, expectedInstanceId }))) return false;
			await tick();
			// Navigation or edits during the handoff leave the draft for its owner.
			if (sessionState.currentId !== sessionId || composerProjectSlug !== projectSlug || composerDraft.text !== draft || pendingAttachments !== images) return false;
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
		const from = selection.scope;
		const parentSessionId = sessionState.currentId;
		const projectSlug = parentSessionId ? findSession(parentSessionId)?.projectSlug ?? getCurrentSlug() : null;
		if (!parentSessionId) {
			showToast("Open a session to start a Side Thread", { variant: "error" });
			return false;
		}
		// A bare command asks for the list rather than a new Side Thread.
		if (!question) {
			openSideThreads();
			clearComposer();
			return false;
		}
		const draftText = composerDraft.text;
		const draftImages = pendingAttachments;
		const draft = JSON.stringify([parentSessionId, draftText, draftImages.map((image) => image.dataUrl)]);
		if (sideThreadAttempt?.draft !== draft) sideThreadAttempt = { draft, inputId: crypto.randomUUID() };
		const { inputId } = sideThreadAttempt;
		startingSideThread = true;
		try {
			const images = draftImages.map((image) => image.dataUrl);
			const outcome = await send({
				from,
				sideThread: { sessionId: parentSessionId, title: question },
				delivery: "queue",
				inputId,
				text: serializeReferences(await withReferences(toProviderCommands(question, providerBuiltinNameSet), projectSlug)),
				...(images.length > 0 ? { images } : {}),
			});
			if (outcome.kind === "started") {
				sideThreadAttempt = undefined;
				const cleared = composerDraft.sideThreadSent(parentSessionId, draftText, pendingAttachments === draftImages);
				if (cleared.cleared) {
					if (cleared.active) cursorPos = 0;
					pendingAttachments = [];
				}
			}
			return outcome.kind === "started" || outcome.kind === "waiting";
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
		if (readingAttachments > 0 || readOnlySubagent || !turnControl.ready) return false;
		if (textOverride === undefined && pendingAttachments.some((attachment) => !attachment.dataUrl.startsWith("data:image/")) && !getProviderDriver(composerDriver)?.supportsFileAttachments) {
			attachmentError = "File attachments are available with Claude and OpenCode. Choose one of those harnesses before sending these files.";
			return false;
		}
		let text = textOverride ?? composerDraft.text.trim();
		if (!text && (textOverride !== undefined || pendingAttachments.length === 0)) return false;
		if (textOverride === undefined) {
			const match = text.match(/^\$(\S+)(?:\s+([\s\S]*))?$/);
			const command = conduitCommands.find((command) =>
				[command.name, ...command.aliases].some((name) => name === match?.[1]),
			);
			if (command?.handler === "startSideThread") return startSideThread(match?.[2]?.trim());
			text = toProviderCommands(text, providerBuiltinNameSet);
		}

		const messageText = textOverride === undefined ? serializeReferences(await withReferences(text, composerProjectSlug)) : text;

		// Send all attachments through the existing data URL field.
		const imageUrls = textOverride === undefined && pendingAttachments.length > 0
			? pendingAttachments.map((img) => img.dataUrl)
			: undefined;

		const sentFromSessionId = sessionState.currentId;
		const projectSlug = sentFromSessionId ? findSession(sentFromSessionId)?.projectSlug ?? getCurrentSlug() : getDraftProject();
		if (!sentFromSessionId && creatingSession) return false;
		if (!sentFromSessionId) creatingSession = true;
		try {
			let draft: Parameters<typeof rpc<"CreateSession">>[1] | undefined;
			if (!sentFromSessionId) {
				if (!projectSlug) {
					showToast("No active project", { variant: "error" });
					return false;
				}
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
				draft = { ...payload, draftText: composerDraft.text, ...(draftNewWorktree ? { newWorktree: true } : {}) };
				requestDraftPreWarm();
				draftSend.message = {
					type: "user", uuid: crypto.randomUUID(), text: messageText, createdAt: Date.now(),
					...(imageUrls ? {
						attachments: imageUrls.map((url) => {
							const { mime, name, size } = parseAttachmentDataUrl(url);
							return { id: crypto.randomUUID(), name: name ?? "Attachment", mime, url, size };
						}),
					} : {}),
				};
				draftSend.sessionId = null;
			}
			const unsentImages = pendingAttachments;
			if (!isProcessing()) requestScrollOnNextContent();
			steerRefusal = null;
			dismissedRefusal = null;
			const clearOnSend = textOverride === undefined && delivery !== "steer";
			const unsentDraft = composerDraft.sendStarted(clearOnSend);
			if (clearOnSend) {
				pendingAttachments = [];
				cursorPos = 0;
			}
			const destination = draft ? {
				draft,
				onCreated: (sessionId: string) => composerDraft.created(unsentDraft, sessionId),
			} : sentFromSessionId ? { sessionId: sentFromSessionId } : undefined;
			if (!destination) return false;
			const outcome = await send({
				text: messageText,
				delivery,
				...(imageUrls ? { images: imageUrls } : {}),
				...destination,
			});
			const sentToSessionId = sentFromSessionId ?? draftSend.sessionId;
			if (outcome.kind === "failed" || outcome.kind === "refused") {
				if (composerDraft.sendFailed(unsentDraft, sentToSessionId, textOverride === undefined, outcome.kind === "failed" && outcome.alreadySent === true)) {
					cursorPos = composerDraft.text.length;
					pendingAttachments = unsentImages;
				}
				return false;
			}
			if (composerDraft.sendSucceeded(sentToSessionId, delivery === "steer", textOverride === undefined)) {
				pendingAttachments = [];
				cursorPos = 0;
			}
			return true;
		} finally {
			if (!sentFromSessionId) creatingSession = false;
		}
	}

	function clearComposer() {
		pendingAttachments = [];
		attachmentError = "";
		composerDraft.clear();
		cursorPos = 0;
	}

	async function undoGoalClear() {
		const facts = goalFacts;
		const key = clearKey;
		if (facts?.ended !== "cleared" || !facts.endedGoal || facts.sessionId !== sessionState.currentId) return;
		if (await sendMessage(`/goal ${facts.endedGoal.condition}`)) undoneClearKey = key;
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

	function handleAttachFiles() {
		if (!getProviderDriver(composerDriver)?.supportsFileAttachments) {
			attachmentError = "File attachments are available with Claude and OpenCode. Choose one of those harnesses before attaching files.";
			return;
		}
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.multiple = true;
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	function handleAttachSetGoal(condition = "") {
		if (!discoveryState.currentTraits?.supportsGoalState) return;
		composerDraft.text = `$goal ${condition}`;
		cursorPos = composerDraft.text.length;
		requestAnimationFrame(() => {
			textareaEl?.focus();
			textareaEl?.setSelectionRange(composerDraft.text.length, composerDraft.text.length);
			handleInput();
		});
	}

	$effect(() => {
		function handleGoalAction(event: CustomEvent<GoalComposerAction>) {
			const { action, sessionId, condition } = event.detail;
			if (!discoveryState.currentTraits?.supportsGoalState || sessionId !== sessionState.currentId) return;
			switch (action) {
				case "pause": if (sessionState.currentId) void stop(sessionState.currentId); break;
				case "resume": void sendMessage("Continue."); break;
				case "clear": void sendMessage("/goal clear", "steer"); break;
				case "edit": handleAttachSetGoal(condition); break;
				case "new": handleAttachSetGoal(); break;
			}
		}
		window.addEventListener("composer:goal", handleGoalAction);
		return () => window.removeEventListener("composer:goal", handleGoalAction);
	});

	/** All picker entries share one attachment row and one send path. */
	async function processSelectedFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		const context = sessionModeContext;
		attachmentError = "";
		readingAttachments++;
		try {
			for (const file of Array.from(files)) {
				try {
					const { dataUrl, resized } = await prepareFileAttachment(file);
					if (context !== sessionModeContext) return;
					pendingAttachments = [...pendingAttachments, {
						id: crypto.randomUUID(),
						dataUrl,
						name: file.name,
						size: file.size,
					}];
					if (resized) {
						showToast(`"${file.name}" was resized to fit the 5 MB encoded size limit`, { variant: "warn" });
					}
				} catch (err) {
					if (context !== sessionModeContext) return;
					const message = err instanceof Error ? err.message : "Could not read the file.";
					attachmentError += `${attachmentError ? "\n" : ""}"${file.name}" could not be attached. ${message}`;
				}
			}
		} finally {
			readingAttachments--;
		}
	}

	/** Ask replies and queued edits use the same unsent composer draft. */
	function addToDraft(text: string, images: readonly string[] = []) {
		composerDraft.text = composerDraft.text.trim() ? `${composerDraft.text.trimEnd()}\n\n${text}` : text;
		handleInput();
		cursorPos = composerDraft.text.length;
		pendingAttachments = [
			...pendingAttachments,
			...images.map((dataUrl) => {
				const { mime, name, size } = parseAttachmentDataUrl(dataUrl);
				return { id: crypto.randomUUID(), dataUrl, name: name ?? (mime.startsWith("image/") ? "image" : "file"), size };
			}),
		];
		textareaEl?.focus();
	}

	function removePendingAttachment(id: string) {
		pendingAttachments = pendingAttachments.filter((img) => img.id !== id);
	}

	function handleCommandSelect(command: string) {
		// Replace the query region with the selected command text (e.g. "/skill " or "$compact ").
		// User can then type arguments and press Enter to send.
		let newCursorPos: number;
		if (commandMatch) {
			const before = composerDraft.text.slice(0, commandMatch.start);
			const after = composerDraft.text.slice(commandMatch.end);
			newCursorPos = commandMatch.start + command.length;
			composerDraft.text = before + command + after;
		} else {
			composerDraft.text = command;
			newCursorPos = command.length;
		}
		// Move cursor to end of inserted command and focus the textarea. tick, not a
		// frame: keys typed before the next frame would land before the moved caret.
		if (textareaEl) {
			textareaEl.focus();
			void tick().then(() => {
				if (textareaEl) {
					referenceEditor.focusRaw(newCursorPos);
					cursorPos = newCursorPos;
				}
			});
		}
	}

	function handleCommandClose() {
		if (commandMatch) {
			const before = composerDraft.text.slice(0, commandMatch.start);
			const after = composerDraft.text.slice(commandMatch.end);
			composerDraft.text = before + after;
		} else {
			composerDraft.text = "";
		}
	}

	function handleFileSelect(path: string) {
		if (!atQuery || !textareaEl) return;

		const before = composerDraft.text.slice(0, atQuery.start);
		const after = composerDraft.text.slice(atQuery.end);
		const insertion = buildMentionInsertion(path);
		composerDraft.text = before + insertion + after;

		// Move cursor to after the inserted path
		const newCursorPos = atQuery.start + insertion.length;
		requestAnimationFrame(() => {
			if (textareaEl) {
				textareaEl.focus();
				referenceEditor.focusRaw(newCursorPos);
				cursorPos = newCursorPos;
			}
		});
	}

	function handleFileMenuClose() {
		// Remove the @ trigger character
		if (atQuery) {
			const before = composerDraft.text.slice(0, atQuery.start);
			const after = composerDraft.text.slice(atQuery.end);
			composerDraft.text = before + after;
		}
	}

	// Navigate to parent session on ESC — works regardless of focus
	$effect(() => {
		function handleGlobalEsc(e: KeyboardEvent) {
			if (
				e.key === "Escape" &&
				!composerDraft.text.trim() &&
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
	<div data-testid="composer-settings-pending" role="status" class="flex items-center gap-2 px-1.5 text-xs text-text-dimmer font-sans whitespace-nowrap">
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

{#snippet phoneMore(rows: Snippet, trigger: Snippet<[{ props: Record<string, unknown>; attention?: boolean }]>, checkout?: Snippet, warning?: Snippet, attention = false)}
	{#snippet phoneTrigger({ props }: { props: Record<string, unknown> })}{@render trigger({ props, attention })}{/snippet}
	<Popover bind:open={composerMoreOpen} presentation="auto" title="Composer" side="top" trigger={phoneTrigger} data-testid="composer-more-sheet" class="px-[16px]">
		{@render rows()}
		<PermissionModeSelector variant="row" />
		{@render checkout?.()}
		{@render warning?.()}
	</Popover>
{/snippet}

{#snippet composerPhoneControls(rows: Snippet, trigger: Snippet<[{ props: Record<string, unknown>; attention?: boolean }]>) }
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
				loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { sessionId: session.id }) : undefined}
				onmove={(path) => rpc("MoveSessionWorkspace", { sessionId: session.id, path })}
				onrecreate={() => rpc("RecreateSessionWorktree", { sessionId: session.id })}
				oncontinue={() => rpc("ContinueSessionInMainFolder", { sessionId: session.id })}
				ondismiss={(path) => rpc("DismissWorkspaceHint", { sessionId: session.id, path })}
				onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { sessionId: session.id, branchName }) : undefined}
			>
				{#snippet children(attention, checkout, warning)}
					{@render phoneMore(rows, trigger, checkout, warning, attention)}
				{/snippet}
			</GitIdentity>
		{/key}
	{:else}
		{@render phoneMore(rows, trigger)}
	{/if}
{/snippet}

<!-- While the textarea is focused the keyboard covers the home indicator, but iOS
     keeps env(safe-area-inset-bottom) at full size, leaving a dead gap above the
     keyboard. Drop the inset then. Restore it only once the keyboard has slid away:
     tapping a composer button blurs the textarea on mousedown, and restoring the
     inset at once lifts the button out from under the finger before the click. -->
<div
	id="input-area"
	{@attach publishComposerClearance}
	data-compact={sessionViewState.compact}
	class="shrink-0 px-[32px] pt-[8px] transition-[padding-bottom] duration-0 delay-250 has-[textarea:focus]:delay-0 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] has-[textarea:focus]:pb-[22px] max-md:px-[12px] max-md:pt-[6px] max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)] max-md:has-[textarea:focus]:pb-[8px]"
>
	<div id="input-wrapper" bind:this={composerWrapperEl} bind:clientWidth={sessionViewState.composerWidth} class="max-w-[760px] mx-auto relative">
		<!-- The listbox shares the composer's measured edges, including phone gutters. -->
		{#if commandMenuVisible}
			<div id="command-menu-wrap" class="relative w-full">
				<CommandMenu
					bind:this={commandMenuRef}
					bind:activeIndex={commandMenuActiveIndex}
					listboxId={commandListboxId}
					query={commandQuery}
					visible={commandMenuVisible}
					commands={[...menuCommands]}
					contextPercent={currentChat().contextPercent}
					trigger={commandMatch?.trigger ?? "/"}
					onSelect={handleCommandSelect}
					onClose={handleCommandClose}
				/>
			</div>
		{/if}
		<!-- Subagent context bar (above input area) -->
		<SubagentBackBar bind:this={subagentBackBarRef} />
		{#if readOnlySubagent}
			<p data-testid="subagent-readonly-notice" class="px-[6px] pt-2 text-[11px] text-text-muted">{composerPresentation?.subagentNotice}</p>
		{:else}

		{#if !sessionState.currentId && routeSessionId === null && sessionViewState.compact}
			<div class="pb-1.5"><NewSessionContext bind:worktree={draftWorktree} bind:newWorktree={draftNewWorktree} bind:worktreeBase={draftWorktreeBase} bind:modeChosen={draftModeChosen} sessionModeDefault={draftSessionMode} focusComposer={() => textareaEl?.focus()} /></div>
		{/if}

		{#if goal.phase === "checking"}
			<div data-testid="composer-checking-goal" class="flex items-center gap-[7px] px-[16px] pb-[9px] text-[12.5px] text-status-goal">
				<Icon name="loader-circle" size={13} class="animate-spin" /><b class="font-semibold">Checking goal</b><span class="min-w-0 truncate text-text-muted">· {goalFacts?.goal?.condition}</span>
			</div>
		{/if}
		{#if isGoalCommand}
			<ComposerStrip tone="goal" data-testid="composer-goal-hint" class="flex items-center gap-[8px]">
				<Icon name="target" size={16} class="shrink-0 text-status-goal" />
				<div class="min-w-0 flex-1">Claude keeps working until this is true, and checks after each turn.
					<small class="block text-[12px] text-text-muted">{#if goalFacts?.goal?.judgeModel}{getModelDisplayName(goalFacts.goal.judgeModel)} judges · {/if}Esc to cancel</small>
				</div>
			</ComposerStrip>
		{/if}

		{#if goal.phase === "met" && goalFacts && !isGoalMetDismissed(goalFacts)}
			<ComposerStrip tone="success" data-testid="composer-goal-met" class="flex items-center gap-[8px]">
				<Icon name="circle-check" size={16} class="shrink-0 text-status-green" />
				<div class="min-w-0 flex-1"><b class="font-semibold text-text">Goal met</b> · {goalFacts.endedGoal?.condition ?? goalFacts.endedGoal?.lastReason ?? ""}
					<small class="block text-[12px] text-text-muted">Checked {goalFacts.endedAt === undefined ? "just now" : new Date(goalFacts.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}{goalFacts.endedGoal?.turnCount === undefined ? "" : ` · ${goalFacts.endedGoal.turnCount} turns`}{goal.subtitle.slice("Goal met".length)}</small>
				</div>
				<Button variant="secondary" size="composer-chip" data-testid="composer-goal-met-details" onclick={() => { goalDetails.open = true; }}>Details</Button>
				<Button variant="ghost" size="composer-icon" iconOnly icon="x" iconSize={14} ariaLabel="Dismiss" onclick={() => { if (goalFacts) dismissGoalMet(goalFacts); }} />
			</ComposerStrip>
		{:else if showClearedGoal && !clearedGoalDismissed}
			<ComposerStrip data-testid="composer-goal-cleared" class="flex items-center gap-[8px]">
				<Icon name="target" size={16} class="shrink-0" />
				<span class="min-w-0 flex-1">Goal cleared</span>
				<Button variant="secondary" size="composer-chip" disabled={!goalFacts?.endedGoal} onclick={undoGoalClear}>Undo</Button>
				<Button variant="ghost" size="composer-icon" iconOnly icon="x" iconSize={14} ariaLabel="Dismiss goal cleared" onclick={dismissClearedGoal} />
			</ComposerStrip>
		{/if}

		<UsageWarningStrip session={currentSession} projectSlug={composerProjectSlug} />

		{#if contextWarning && !compacting && !contextDismissed}
			<ComposerStrip tone="ask" data-testid="composer-context-warning" class="flex items-center gap-[8px]">
				<Icon name="gauge" size={16} class="shrink-0 text-status-ask" />
				<span class="min-w-0 flex-1"><b class="font-semibold text-text">Context {Math.round(currentChat().contextPercent)}% full.</b> Compact soon to keep replies sharp.</span>
				<Button variant="ask" size="composer-chip" data-testid="composer-context-compact" onclick={() => sendMessage("/compact")}>Compact</Button>
				<Button variant="ghost" size="composer-icon" iconOnly icon="x" iconSize={14} ariaLabel="Dismiss context warning" onclick={dismissContextWarning} />
			</ComposerStrip>
		{/if}

		{#if !currentChat().transcript?.pending.length && currentSession?.limitRecovery && !currentSession.limitRecovery.switched}
			<UsageLimitStrip limitRecovery={currentSession.limitRecovery} sessionId={currentSession.id} projectSlug={currentSession.projectSlug} />
		{/if}

		<PendingInputTray
			inputs={currentChat().transcript?.pending ?? []}
			paused={currentChat().transcript?.paused ?? false}
			sendsAt={pendingSendsAt}
			limitRecovery={currentSession?.limitRecovery ?? undefined}
			sessionId={currentSession?.id}
			projectSlug={currentSession?.projectSlug}
			{steer}
			onEdit={addToDraft}
			onSteerRefused={(reason) => { if (sessionState.currentId) steerRefusal = { sessionId: sessionState.currentId, reason }; }}
		/>

		{#if visibleRefusal}
			<ComposerStrip tone="ask" data-testid="composer-steer-refused" role="status" class="flex items-center gap-[8px]">
				<Icon name="info" size={14} class="shrink-0 text-status-amber" />
				<span class="flex-1 min-w-0"><b class="font-semibold text-status-amber">Not steered.</b> {STEER_REFUSALS[visibleRefusal.reason]}</span>
				<Button variant="ghost" size="content" tone="muted" hoverFill="none" iconOnly icon="x" iconSize={12} ariaLabel="Dismiss" class="size-5 shrink-0" onclick={() => { steerRefusal = null; dismissedRefusal = turnControl.refusal; }} />
			</ComposerStrip>
		{/if}

		{#if attachmentError}
			<ComposerStrip tone="risk" role="alert" data-testid="attachment-error">
				<div class="flex items-start gap-2">
					<Icon name="file" size={14} class="shrink-0 text-error" />
					<span class="min-w-0 flex-1 whitespace-pre-line break-words">{attachmentError}</span>
					<Button variant="ghost" size="content" tone="muted" iconOnly icon="x" iconSize={12} ariaLabel="Dismiss attachment error" class="size-5 shrink-0" onclick={() => { attachmentError = ""; }} />
				</div>
			</ComposerStrip>
		{/if}
		<ComposerFrame id="input-row" compact={sessionViewState.compact} words={composerPreferences.controls === "words"} goal={goal.border}>
			{#if pendingAttachments.length > 0}
				<PastePreview images={pendingAttachments} onRemove={removePendingAttachment} />
			{/if}
			<TwoRowComposerLayout id="input-bottom" data-testid="composer-layout" splitFooter={composerPreferences.controls === "icons"} singleRow={composerPreferences.controls === "words"}>
				{#snippet field()}
					<!-- Textarea row.
					     The composer grows with its text and then scrolls, and both of those
					     are CSS here rather than JS: the mirror sizes the row, this container
					     caps and scrolls it, and the textarea is stretched over the mirror at
					     the full content height so it never scrolls on its own. One scroll
					     position for the whole composer means the caret cannot end up on a
					     different line from the text it sits in. The one JS piece is
					     revealCaret(), for edits the browser reveals before the row grows.
					     `scrollbar-gutter: stable` keeps a scrollbar appearing from narrowing
					     the textarea but not the mirror, which would wrap them differently. -->
					<div class="max-h-[120px] overflow-y-auto [scrollbar-gutter:stable] max-md:[scrollbar-width:none]" bind:this={fieldScroller}>
						<!-- Past HIGHLIGHT_MAX_CHARS the mirror renders nothing, so it can no
						     longer size the row: pin the row to the cap and let the textarea
						     scroll itself. Safe only because the mirror is blank in that mode,
						     so there is still just one scroll position in play. -->
						<div class="relative {plainText ? 'h-[120px]' : ''}" style:min-height={`max(${composerPreferences.controls === "words" ? 24 : sessionViewState.compact ? 34 : 36}px, var(--composer-placeholder-height, 0px))`}>
							<SkillHighlightBackdrop
								text={plainText ? "" : composerDraft.text}
								onremove={referenceEditor.remove}
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
								bind:value={() => referenceView.text, referenceEditor.input}
								bind:element={textareaEl}
								onbeforeinput={referenceEditor.beforeInput}
								onselect={referenceEditor.select}
								onfocus={() => {
									composerFocused = true;
									requestSessionPreWarm(sessionState.currentId);
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

					{#if referenceView.references.length}
						<div data-testid="surfacing-ref-preview">
							<Disclosure look="preview" density="tight" expanded={previewOpen} onToggle={() => (previewOpen = !previewOpen)}>What {composerPresentation?.label ?? "the agent"} receives</Disclosure>
							{#if previewOpen && preview !== undefined}
								{@const lines = preview.split("\n")}
								<!-- Reference lines lead, one each; their `Re …:` prefix is bold. -->
								<pre class="mx-[12px] mb-[8px] whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.6] text-text-secondary">{#each lines as line, index (index)}{#if index < referenceView.references.length}<b class="font-semibold text-text">{line.slice(0, line.indexOf(': "') + 1)}</b>{line.slice(line.indexOf(': "') + 1)}{:else}{line}{/if}{index < lines.length - 1 ? "\n" : ""}{/each}</pre>
							{/if}
						</div>
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
						<AttachMenu onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} onFiles={handleAttachFiles} onSetGoal={() => handleAttachSetGoal()} />
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
							class="flex w-full items-center min-w-0 gap-[2px]"
						>
							<!-- Harness instance + model picker -->
							<InstanceModelPicker phoneControls={composerPhoneControls} />

							<!-- Approvals (permission mode) selector -->
							<PermissionModeSelector />
							<span class="grow"></span>
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
										loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { sessionId: session.id }) : undefined}
										onmove={(path) => rpc("MoveSessionWorkspace", { sessionId: session.id, path })}
										onrecreate={() => rpc("RecreateSessionWorktree", { sessionId: session.id })}
										oncontinue={() => rpc("ContinueSessionInMainFolder", { sessionId: session.id })}
										ondismiss={(path) => rpc("DismissWorkspaceHint", { sessionId: session.id, path })}
										onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { sessionId: session.id, branchName }) : undefined}
									/>
								{/key}
							{/if}
						</div>
					{/if}
				{/snippet}
				{#snippet send()}
					{#snippet sendAtLabel()}
						{#if !sessionViewState.compact}<span data-testid="composer-send-at-label">Send at {sendAtTime}</span>{/if}
					{/snippet}
					<!-- Send / Stop buttons. While working, send only shows once there is
					     something to steer with; otherwise stop stands alone. -->
					{#if !working || canSend}
					{#if hasSendMenu}
					<ComposerSendGroup>
						<Button
							variant="ghost"
							size="content"
							tone="inherit"
							hoverFill="none"
							disabledStyle="undimmed"
							icon={sendMode === "switch" ? "arrow-up" : "clock"}
							iconSize={13}
							id="send"
							data-goal={isGoalCommand ? "true" : "false"}
							data-send-mode={sendMode}
							type="button"
							class="send-btn h-full gap-[6px] px-[12px] text-[13px] font-semibold touch-manipulation"
							disabled={!canSend || switchingAccount}
							title={sendButtonTitle}
							ariaLabel={sendButtonLabel}
							onclick={handleSendClick}
						>
							{#if sendMode === "switch" && switchTarget}
								{#if !sessionViewState.compact}<span data-testid="composer-send-switch-prefix">Send on</span>{/if}
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
								<Button {...props} variant="ghost" size="content" tone="inherit" hoverFill="none" iconOnly icon="chevron-down" iconSize={11} ariaLabel="Send options" data-testid="composer-send-menu-trigger" disabled={switchingAccount} class="h-full shrink-0 touch-manipulation" />
							{/snippet}
							<MenuItem density="compact" data-testid="composer-send-menu-reset" data-selected={sendMode === "at-reset" ? "true" : undefined} disabled={switchingAccount} class="rounded-[7px] {sendMode === 'at-reset' ? 'bg-border-chip' : ''}" onselect={() => { if (accountId) composerDraft.sendPick = { mode: "at-reset", accountId }; }}>
								<Icon name="clock" size={13} class="shrink-0 text-status-red" />
								<span class="flex-1">Send at {sendAtTime}</span>
								<span class="font-mono text-[10.5px] text-text-dimmer">{claudeAccounts.nameOf(accountId)}</span>
							</MenuItem>
							{#each sendAccounts as option (option.id)}
								<MenuItem density="compact" data-testid="composer-send-menu-account" data-account={option.id} data-selected={sendMode === "switch" && switchTarget?.id === option.id ? "true" : undefined} disabled={switchingAccount} class="rounded-[7px] {sendMode === 'switch' && switchTarget?.id === option.id ? 'bg-border-chip' : ''}" onselect={() => { composerDraft.sendPick = { mode: "switch", accountId: option.id }; }}>
									<AccountDot instanceId={option.id} size={7} />
									<span class="flex-1">Send now on {option.name}</span>
									<span class="font-mono text-[10.5px] text-text-dimmer">{option.fullest.kind === "five_hour" ? "5h" : "wk"} {Math.round(option.fullest.utilization)}%</span>
								</MenuItem>
							{/each}
							<div data-testid="composer-send-menu-note" class="mt-[3px] border-t border-border px-[6px] pt-[5px] pb-[3px] font-mono text-[10.5px] text-text-dimmer whitespace-normal">Another account takes over the session, as Switch account does.</div>
						</Menu>
					</ComposerSendGroup>
					{:else}
					{#if sendMode === "at-reset" && sessionViewState.compact}
						<Button variant="inverse" size="composer-action" iconOnly icon="clock" iconSize={16} id="send" data-goal={isGoalCommand ? "true" : "false"} data-send-mode={sendMode} disabled={!canSend} title={sendButtonTitle} ariaLabel={sendButtonLabel} onclick={handleSendClick} touchTarget class="send-btn" />
					{:else if sendMode === "at-reset"}
						<Button variant="inverse" size="composer-action" icon="clock" iconSize={16} id="send" data-goal={isGoalCommand ? "true" : "false"} data-send-mode={sendMode} disabled={!canSend} title={sendButtonTitle} ariaLabel={sendButtonLabel} onclick={handleSendClick} touchTarget class="send-btn">
							{@render sendAtLabel()}
						</Button>
					{:else if isGoalCommand}
						<Button variant="goal" size="composer-action" icon="target" iconSize={16} id="send" data-goal="true" data-send-mode={sendMode} disabled={!canSend} title={sendButtonTitle} ariaLabel="Set goal" onclick={handleSendClick} touchTarget class="send-btn">Set goal</Button>
					{:else}
						<Button variant="inverse" size="composer-action" iconOnly icon="arrow-up" iconSize={17} id="send" data-goal="false" data-send-mode={sendMode} disabled={!canSend} title={sendButtonTitle} ariaLabel={sendButtonLabel} onclick={handleSendClick} touchTarget class="send-btn" />
					{/if}
					{/if}
					{/if}
					{#if working}
						<Button variant="inverse" size="composer-action" id="stop" title={steerPending ? "Stop generating · A pending steer still runs" : "Stop generating"} ariaLabel="Stop generating" onclick={() => { if (sessionState.currentId) void stop(sessionState.currentId); }} touchTarget class="ml-[3px]">
							<i data-testid="stop-square" class="block size-[10px] rounded-[2px] bg-current"></i>
						</Button>
					{/if}
				{/snippet}
			</TwoRowComposerLayout>
		</ComposerFrame>
		{#if composerPreferences.controls === "words"}
			<div
				data-testid="composer-words-row"
				class="flex min-h-[36px] items-center justify-between gap-[12px] px-[14px] pt-[9px] text-[12px] text-text-muted whitespace-nowrap"
			>
				{#if settingsPending}
					{@render settingsStatus()}
				{:else}
				<div in:fade={{ duration: 180 }} data-testid="composer-words-left" class="inline-flex min-w-0 items-center gap-[5px]" class:flex-1={sessionViewState.composerTier === "phone"}>
					<InstanceModelPicker variant="words" phoneControls={composerPhoneControls}>
						{#snippet phoneMode()}<PermissionModeSelector variant="summary" />{/snippet}
					</InstanceModelPicker>
					{#if sessionViewState.composerTier !== "phone" && (composerTraits?.composerModeControl ?? "permission-mode") === "permission-mode"}
						<span aria-hidden="true" class="text-border-chip">·</span>
						<PermissionModeSelector variant="words" />
					{/if}
				</div>
				{#if !sessionViewState.compact}<div in:fade={{ duration: 180 }} data-testid="composer-words-right" class="inline-flex min-w-[56px] flex-[0_1000000_auto] items-center justify-end gap-[5px]">
					{#if currentSession}
						{@const session = currentSession}
						{#if composerDirectory && sessionViewState.composerTier !== "phone"}
							{#key session.id}
								<GitIdentity
									presentation="word"
									directory={composerDirectory}
									git={composerGit}
									workspaceCause={session.workspace?.cause}
									workspaceMissing={session.workspaceMissing}
									workspaceMismatch={session.workspaceMismatch}
									workspaceHint={session.workspaceHint}
									loadWorktrees={supportsWorktree !== false ? () => rpc("ListWorktrees", { sessionId: session.id }) : undefined}
									onmove={(path) => rpc("MoveSessionWorkspace", { sessionId: session.id, path })}
									onrecreate={() => rpc("RecreateSessionWorktree", { sessionId: session.id })}
									oncontinue={() => rpc("ContinueSessionInMainFolder", { sessionId: session.id })}
									ondismiss={(path) => rpc("DismissWorkspaceHint", { sessionId: session.id, path })}
									onrenamebranch={session.canRenameBranch ? (branchName) => rpc("RenameSessionBranch", { sessionId: session.id, branchName }) : undefined}
								/>
							{/key}
						{/if}
						{#if currentChat().contextPercent > 0}
							{#if composerDirectory && sessionViewState.composerTier !== "phone"}<span aria-hidden="true" class="text-border-chip">·</span>{/if}
							<span data-testid="composer-word-context-usage" data-warning={contextWarning ? "true" : undefined} class:text-status-amber={contextWarning} class="shrink-0">{Math.round(currentChat().contextPercent)}%</span>
						{/if}
					{/if}
				</div>{/if}
				{/if}
			</div>
		{/if}
		{#if working}
			<p data-testid="composer-next-turn-note" class="px-[16px] pt-[8px] text-[12px] text-text-muted">Model and mode changes apply from the <span class="font-medium text-text-secondary">next turn</span>.</p>
		{/if}
		{#if composerNotice}
			<p data-testid="composer-provider-notice" class="px-[6px] pt-2 text-[11px] text-text-muted">{composerNotice}</p>
		{/if}
		{#if !sessionState.currentId && routeSessionId === null && !sessionViewState.compact}
			<div class="pt-2"><NewSessionContext bind:worktree={draftWorktree} bind:newWorktree={draftNewWorktree} bind:worktreeBase={draftWorktreeBase} bind:modeChosen={draftModeChosen} sessionModeDefault={draftSessionMode} focusComposer={() => textareaEl?.focus()} /></div>
		{/if}
		{/if}
	</div>
</div>

<style>
	#input-area[data-compact="true"] { padding: 6px 12px calc(env(safe-area-inset-bottom, 0px) + 8px); }
	#input-area[data-compact="true"]:has(:global(textarea:focus)) { padding-bottom: 8px; }
</style>
