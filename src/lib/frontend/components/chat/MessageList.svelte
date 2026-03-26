<!-- ─── Message List ────────────────────────────────────────────────────────── -->
<!-- Scrollable message container with auto-scroll and scroll-to-bottom button. -->
<!-- Renders history messages, live chat messages, and inline permission/question cards. -->
<!-- Preserves #messages ID for E2E. -->

<script lang="ts">
	import { untrack } from "svelte";
	import { chatState, historyState, isProcessing } from "../../stores/chat.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { splitAtForkPoint } from "../../utils/fork-split.js";
	import ForkContextBlock from "./ForkContextBlock.svelte";
	import ForkDivider from "./ForkDivider.svelte";
	import {
		uiState,
		selectRewindMessage,
	} from "../../stores/ui.svelte.js";
	import { permissionsState, getLocalPermissions } from "../../stores/permissions.svelte.js";
	import { createScrollController } from "../../stores/scroll-controller.svelte.js";
	import type {
		AssistantMessage as AssistantMsg,
		ThinkingMessage,
		ToolMessage,
		UserMessage as UserMsg,
		ResultMessage,
		SystemMessage as SystemMsg,
	} from "../../types.js";
	import UserMessage from "./UserMessage.svelte";
	import AssistantMessage from "./AssistantMessage.svelte";
	import ThinkingBlock from "./ThinkingBlock.svelte";
	import ToolItem from "./ToolItem.svelte";
	import SkillItem from "./SkillItem.svelte";
	import ToolGroupCard from "./ToolGroupCard.svelte";
	import { groupMessages, type GroupedMessage, type ToolGroup } from "../../utils/group-tools.js";
	import ResultBar from "./ResultBar.svelte";
	import SystemMessage from "./SystemMessage.svelte";
	import PermissionCard from "../permissions/PermissionCard.svelte";
	import QuestionCard from "./QuestionCard.svelte";
	import HistoryLoader from "./HistoryLoader.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";


	let messagesEl: HTMLDivElement | undefined = $state();
	let sentinelEl: HTMLElement | undefined = $state();

	// ─── Scroll controller ────────────────────────────────────────────────────

	const scrollCtrl = createScrollController(
		() => chatState.loadLifecycle,
	);

	// Attach/detach the controller to the scroll container
	$effect(() => {
		if (messagesEl) {
			scrollCtrl.attach(messagesEl);
			return () => scrollCtrl.detach();
		}
	});

	// Reset scroll state on session switch
	$effect(() => {
		const _sid = sessionState.currentId; // track session changes
		scrollCtrl.resetForSession();
	});

	// Scroll to bottom when loadLifecycle transitions to "ready" after settling.
	// This handles the case where deferred markdown rendering adds height after
	// the settle loop completes. The settle loop scrolls during "committed",
	// but the final scroll-to-bottom on "ready" ensures we're at the very bottom.
	$effect(() => {
		if (chatState.loadLifecycle === "ready") {
			scrollCtrl.onNewContent();
		}
	});

	// Auto-scroll when content changes (messages, permissions, questions).
	// Guards:
	// - Skip during prepend (scroll preservation handles that case).
	// - Only auto-scroll when session is actively producing content
	//   (processing or streaming) OR when the scroll controller is settling
	//   (post-replay, deferred markdown rendering). On inactive sessions,
	//   background events (cross-tab user_message, permission state) must
	//   NOT snap to bottom.
	// NOTE: isProcessing() is checked via untrack() so it acts as a guard
	// (checked but not tracked). The effect only re-runs when actual content
	// changes — not on every processing/streaming toggle.
	$effect(() => {
		const _len = chatState.messages.length;
		const _permLen = permissionsState.pendingPermissions.length;
		const _qLen = permissionsState.pendingQuestions.length;
		const isActive = untrack(() => isProcessing());
		const isSettling = untrack(() => scrollCtrl.state === "settling");
		if (!awaitingPrepend && (isActive || isSettling)) {
			scrollCtrl.onNewContent();
		}
	});

	// ─── Scroll preservation for history prepend ────────────────────────────

	// Flag to suppress auto-scroll during prepend — MUST be $state for $effect tracking
	let awaitingPrepend = $state(false);
	let prevScrollHeight = 0;
	let prevScrollTop = 0;

	// Derived first-message UUID — changes only on prepend or session switch,
	// NOT on appends or content updates. This prevents the $effect.pre from
	// firing spuriously when message html/status fields change.
	const firstMessageUuid = $derived(
		chatState.messages.length > 0 ? chatState.messages[0]?.uuid : "",
	);

	// Track previous state for prepend detection
	let prevFirstUuid = "";
	let prevMessageCount = 0;
	let prevSessionId = $state("");

	// Capture scroll state BEFORE DOM update using $effect.pre
	$effect.pre(() => {
		const currentSessionId = sessionState.currentId ?? "";
		const currentFirstUuid = firstMessageUuid;
		const currentCount = chatState.messages.length;

		// Session changed — reset tracking, skip prepend detection
		if (currentSessionId !== prevSessionId) {
			prevSessionId = currentSessionId;
			prevFirstUuid = currentFirstUuid;
			prevMessageCount = currentCount;
			return;
		}

		// Prepend detected within same session: first UUID changed AND count increased
		if (
			prevFirstUuid &&
			currentFirstUuid &&
			currentFirstUuid !== prevFirstUuid &&
			currentCount > prevMessageCount &&
			messagesEl
		) {
			awaitingPrepend = true;
			prevScrollHeight = messagesEl.scrollHeight;
			prevScrollTop = messagesEl.scrollTop;
		}

		prevFirstUuid = currentFirstUuid;
		prevMessageCount = currentCount;
	});

	// Restore scroll position AFTER DOM update (delegate to controller)
	$effect(() => {
		if (awaitingPrepend && messagesEl) {
			scrollCtrl.onPrepend(prevScrollHeight, prevScrollTop);
			awaitingPrepend = false;
		}
	});

	// ─── Rewind mode click delegation ──────────────────────────────────────────

	function handleRewindClick(e: MouseEvent) {
		if (!uiState.rewindActive) return;

		// Find the closest message element with a data-uuid attribute
		const target = e.target as HTMLElement;
		const msgEl = target.closest("[data-uuid]") as HTMLElement | null;
		if (msgEl) {
			e.preventDefault();
			e.stopPropagation();
			const uuid = msgEl.dataset.uuid ?? null;
			selectRewindMessage(uuid);
		}
	}

	// ─── Scroll button text ────────────────────────────────────────────────────

	const scrollButtonText = $derived(
		isProcessing() ? "↓ New activity" : "↓ Latest",
	);

	const groupedMessages: GroupedMessage[] = $derived(groupMessages(chatState.messages));
	const localPermissions = $derived(getLocalPermissions(sessionState.currentId));

	// Fork context: detect if current session is a user fork
	const activeSession = $derived(findSession(sessionState.currentId ?? ""));
	const isFork = $derived(!!activeSession?.forkMessageId);
	const forkSplit = $derived(
		isFork && activeSession?.forkMessageId
			? splitAtForkPoint(chatState.messages, activeSession.forkMessageId)
			: null,
	);
	const parentSession = $derived(
		activeSession?.parentID ? findSession(activeSession.parentID) : null,
	);
	// Memoize grouped messages for fork rendering
	const inheritedGrouped = $derived(
		forkSplit ? groupMessages(forkSplit.inherited) : [],
	);
	const currentGrouped = $derived(
		forkSplit ? groupMessages(forkSplit.current) : [],
	);

	/** All pending questions are rendered at the bottom of the message list.
	 *  Active questions are NOT rendered inline by ToolItem (to prevent them from
	 *  appearing between text segments when the LLM calls the question tool mid-stream).
	 *  Once resolved, the read-only summary renders inline at the tool's position. */
</script>

<div
	id="messages"
	class="flex-1 overflow-y-auto pt-5 pb-3 relative"
	style="-webkit-overflow-scrolling: touch;"
	bind:this={messagesEl}
>
	<!-- History sentinel (triggers lazy-loading of older messages) -->
	<div id="history-sentinel" class="h-1" bind:this={sentinelEl}></div>

	<!-- Headless loader (no visual output) -->
	<HistoryLoader {sentinelEl} />

	<!-- Beginning of session marker (was in HistoryView) -->
	{#if !historyState.hasMore && !historyState.loading && !isFork}
		<div class="history-beginning flex flex-col items-center py-4 text-text-dimmer text-xs">
			<div class="w-8 h-px bg-border mb-2"></div>
			<span>Beginning of session</span>
		</div>
	{/if}

	<!-- Loading indicator (was in HistoryView) -->
	{#if historyState.loading}
		<div class="history-loading flex items-center justify-center py-3 text-text-dimmer text-xs gap-2">
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} />
			<span>Loading history...</span>
		</div>
	{/if}

	<!-- Message rendering snippet (shared between fork and normal paths) -->
	{#snippet messageItem(msg: GroupedMessage)}
		{#if msg.type === "user"}
			<div class="msg-container" class:rewind-point={uiState.rewindActive}>
				<UserMessage message={msg as UserMsg} />
			</div>
		{:else if msg.type === "assistant"}
			<div class="msg-container" class:rewind-point={uiState.rewindActive}>
				<AssistantMessage message={msg as AssistantMsg} />
			</div>
		{:else if msg.type === "thinking"}
			<div class="msg-container">
				<ThinkingBlock message={msg as ThinkingMessage} />
			</div>
		{:else if msg.type === "tool-group"}
			<div class="msg-container">
				<ToolGroupCard group={msg as ToolGroup} />
			</div>
		{:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
			<div class="msg-container">
				<SkillItem message={msg as ToolMessage} />
			</div>
		{:else if msg.type === "tool"}
			<div class="msg-container">
				<ToolItem message={msg as ToolMessage} />
			</div>
		{:else if msg.type === "result"}
			<div class="msg-container">
				<ResultBar message={msg as ResultMessage} />
			</div>
		{:else if msg.type === "system"}
			<div class="msg-container">
				<SystemMessage message={msg as SystemMsg} />
			</div>
		{/if}
	{/snippet}

	<!-- Single render loop for ALL messages (click delegation for rewind mode) -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div onclick={uiState.rewindActive ? handleRewindClick : undefined}>
	{#if forkSplit && forkSplit.inherited.length > 0}
		<ForkContextBlock>
			{#each inheritedGrouped as msg (msg.uuid)}
				{@render messageItem(msg)}
			{/each}
		</ForkContextBlock>

		<ForkDivider
			parentTitle={parentSession?.title ?? "parent session"}
			parentId={activeSession?.parentID ?? ""}
		/>

		{#each currentGrouped as msg, i (msg.uuid)}
			{@render messageItem(msg)}
		{/each}
	{:else}
		{#each groupedMessages as msg, i (msg.uuid)}
			{@render messageItem(msg)}
		{/each}
	{/if}
	</div>

	<!-- Pending permission requests (only for current session) -->
	{#each localPermissions as perm (perm.id)}
		<div class="max-w-[760px] mx-auto mb-3 px-5">
			<PermissionCard request={perm} />
		</div>
	{/each}

	<!-- Pending user questions (always rendered at bottom, not inline) -->
	{#each permissionsState.pendingQuestions as question (question.toolId)}
		<div class="max-w-[760px] mx-auto mb-3 px-5">
			<QuestionCard request={question} />
		</div>
	{/each}

	<!-- Scroll-to-bottom button -->
	<button
		id="scroll-btn"
		class="sticky bottom-3 left-1/2 -translate-x-1/2 bg-bg-alt border border-border rounded-full px-4 py-1.5 text-xs text-text-secondary cursor-pointer z-5 font-sans hover:bg-bg-surface"
		class:hidden={!scrollCtrl.isDetached}
		title="Scroll to bottom"
		onclick={() => scrollCtrl.requestFollow()}
	>
		{scrollButtonText}
	</button>
</div>
