<!-- ─── Message List ────────────────────────────────────────────────────────── -->
<!-- Scrollable message container with auto-scroll and scroll-to-bottom button. -->
<!-- Renders history messages, live chat messages, and inline permission/question cards. -->
<!-- Preserves #messages ID for E2E. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { untrack } from "svelte";
	import { currentChat, isProcessing, consumeScrollRequest } from "../../stores/chat.svelte.js";
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
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { economics, segmentTurns, type Turn } from "../../utils/turns.js";
	import UserMessage from "./UserMessage.svelte";
	import AssistantMessage from "./AssistantMessage.svelte";
	import TurnActivity from "./TurnActivity.svelte";
	import TurnEconomics from "./TurnEconomics.svelte";
	import ToolItem from "./ToolItem.svelte";
	import SystemMessage from "./SystemMessage.svelte";
	import PermissionCard from "../permissions/PermissionCard.svelte";
	import QuestionCard from "./QuestionCard.svelte";
	import HistoryLoader from "./HistoryLoader.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";

	let messagesEl: HTMLDivElement | undefined = $state();
	let sentinelEl: HTMLElement | undefined = $state();

	// ─── Scroll controller ────────────────────────────────────────────────────

	const scrollCtrl = createScrollController(
		() => currentChat().loadLifecycle,
	);

	// Attach/detach the controller to the scroll container
	$effect(() => {
		if (messagesEl) {
			scrollCtrl.attach(messagesEl);
			return () => scrollCtrl.detach();
		}
		return undefined;
	});

	// Reset scroll state on session switch
	$effect(() => {
		const _sid = sessionState.currentId; // track session changes
		scrollCtrl.resetForSession();
	});

	// Publish for chrome outside the transcript (e.g. the session bar) so the app
	// never grows a second, differently-tuned definition of "at the bottom".
	// Hydration states count as pinned, otherwise the bar flaps on session open.
	$effect(() => {
		const state = scrollCtrl.state;
		sessionViewState.atBottom =
			state === "following" || state === "settling" || state === "loading";
	});

	// Scroll to bottom when loadLifecycle transitions to "ready" after settling.
	// This handles the case where deferred markdown rendering adds height after
	// the settle loop completes. The settle loop scrolls during "committed",
	// but the final scroll-to-bottom on "ready" ensures we're at the very bottom.
	$effect(() => {
		if (currentChat().loadLifecycle === "ready") {
			scrollCtrl.onNewContent();
		}
	});

	// Auto-scroll when content changes (messages, permissions).
	// Guards:
	// - Skip during prepend (scroll preservation handles that case).
	// - Only auto-scroll when session is actively producing content
	//   (processing or streaming) OR when the scroll controller is settling
	//   (post-replay, deferred markdown rendering) OR when an explicit
	//   scroll request was made (e.g. error messages set this before
	//   phaseToIdle kills the isProcessing guard). On inactive sessions,
	//   background events (cross-tab user_message, permission state) must
	//   NOT snap to bottom.
	// NOTE: isProcessing() and consumeScrollRequest() are checked via
	// untrack() so they act as guards (checked but not tracked). The effect
	// only re-runs when actual content changes — not on every toggle.
	$effect(() => {
		const _len = currentChat().messages.length;
		const _permLen = permissionsState.pendingPermissions.length;
		const isActive = untrack(() => isProcessing());
		const isSettling = untrack(() => scrollCtrl.state === "settling");
		const scrollRequested = untrack(() => consumeScrollRequest());
		if (!awaitingPrepend && (isActive || isSettling || scrollRequested)) {
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
	const firstMessageUuid = $derived(currentChat().messages[0]?.uuid ?? "");

	// Track previous state for prepend detection
	let prevFirstUuid = "";
	let prevMessageCount = 0;
	let prevSessionId = $state("");

	// Capture scroll state BEFORE DOM update using $effect.pre
	$effect.pre(() => {
		const currentSessionId = sessionState.currentId ?? "";
		const currentFirstUuid = firstMessageUuid;
		const currentCount = currentChat().messages.length;

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
			const uuid = msgEl.dataset["uuid"] ?? null;
			selectRewindMessage(uuid);
		}
	}

	// ─── Scroll button text ────────────────────────────────────────────────────

	const scrollButtonText = $derived(
		isProcessing() ? "↓ New activity" : "↓ Latest",
	);

	const turns = $derived(segmentTurns(currentChat().messages, isProcessing()));
	const localPermissions = $derived(getLocalPermissions(sessionState.currentId));
	const transcriptToolIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const message of currentChat().messages) {
			if (message.type === "tool") ids.add(message.id);
		}
		return ids;
	});
	const orphanQuestions = $derived(
		permissionsState.pendingQuestions.filter(
			(question) =>
				!transcriptToolIds.has(question.toolId) &&
				(!question.toolUseId || !transcriptToolIds.has(question.toolUseId)),
		),
	);

	// Fork context: detect if current session is a user fork
	const activeSession = $derived(findSession(sessionState.currentId ?? ""));
	const isFork = $derived(!!activeSession?.forkMessageId || !!activeSession?.forkPointTimestamp);
	const forkSplit = $derived(
		isFork
			? splitAtForkPoint(
					currentChat().messages,
					activeSession?.forkMessageId,
					activeSession?.forkPointTimestamp,
				)
			: null,
	);
	const parentSession = $derived(
		activeSession?.parentID ? findSession(activeSession.parentID) : null,
	);
	// A fork renders two transcripts; only the current half can be live.
	const inheritedTurns = $derived(
		forkSplit ? segmentTurns(forkSplit.inherited, false) : [],
	);
	const currentTurns = $derived(
		forkSplit ? segmentTurns(forkSplit.current, isProcessing()) : [],
	);

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
	{#if !currentChat().historyHasMore && !currentChat().historyLoading && !isFork}
		<div class="history-beginning flex flex-col items-center py-4 text-text-dimmer text-xs">
			<div class="w-8 h-px bg-border mb-2"></div>
			<span>Beginning of session</span>
		</div>
	{/if}

	<!-- Loading indicator (was in HistoryView) -->
	{#if currentChat().historyLoading}
		<div class="history-loading flex items-center justify-center py-3 text-text-dimmer text-xs gap-2">
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} />
			<span>Loading history...</span>
		</div>
	{/if}

	<!-- Turn rendering snippet (shared between fork and normal paths) -->
	{#snippet turnItem(turn: Turn)}
		{#if turn.user}
			<div class="msg-container" class:rewind-point={uiState.rewindActive}>
				<UserMessage message={turn.user} />
			</div>
		{/if}
		{#each turn.segments as segment, i}
			{@const final = i === turn.segments.length - 1}
			{#if segment.activity.length > 0}
				<TurnActivity {turn} {segment} {final} />
			{/if}
			<!-- Notices sit between the final work and reply: they are lifted out of
			     the activity log so a failure is never hidden behind a collapsed panel. -->
			{#if final}
				{#each turn.notices as notice (notice.uuid)}
					<div class="msg-container">
						<SystemMessage message={notice} />
					</div>
				{/each}
			{/if}
			{#each segment.reply as reply (reply.uuid)}
				<div class="msg-container" class:rewind-point={uiState.rewindActive}>
					<AssistantMessage message={reply} />
				</div>
			{/each}
			{#if segment.handBack}
				<div class="max-w-[760px] mx-auto px-5">
					<ToolItem message={segment.handBack} />
				</div>
			{/if}
		{/each}
		<!-- A turn that did work carries its bill on the strip. A tool-less question
		     and answer has no ledger, so it renders the same bill on its own line —
		     one formatter for both, rather than a second dialect of the same facts.
		     .result-bar is an E2E selector; .turn-meta rides on TurnEconomics. -->
		{#if turn.result && turn.segments.every((segment) => segment.activity.length === 0)}
			<!-- `now` only matters for a live turn, and this branch needs a result. -->
			{@const bill = economics(turn, Date.now())}
			<div class="msg-container">
				<!-- Same query container as the ledger, so the bill sheds the gauge and
				     the token counts in the same order rather than overflowing. -->
				<div class="result-bar @container max-w-[760px] mx-auto mt-1 mb-5 px-5">
					<TurnEconomics economics={bill} showDuration />
				</div>
			</div>
		{/if}
	{/snippet}

	<!-- Single render loop for ALL messages (click delegation for rewind mode) -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div onclick={uiState.rewindActive ? handleRewindClick : undefined}>
	{#if forkSplit && forkSplit.inherited.length > 0}
		<ForkContextBlock>
			{#each inheritedTurns as turn (turn.id)}
				{@render turnItem(turn)}
			{/each}
		</ForkContextBlock>

		<ForkDivider
			parentTitle={parentSession?.title ?? "parent session"}
			parentId={activeSession?.parentID ?? ""}
		/>

		{#each currentTurns as turn (turn.id)}
			{@render turnItem(turn)}
		{/each}
	{:else}
		{#each turns as turn (turn.id)}
			{@render turnItem(turn)}
		{/each}
	{/if}
	</div>

	<!-- Pending permission requests (only for current session) -->
	{#each localPermissions as perm (perm.id)}
		<div class="max-w-[760px] mx-auto mb-3 px-5">
			<PermissionCard request={perm} />
		</div>
	{/each}

	<!-- Keep questions answerable when their tool message has not reached the transcript. -->
	{#each orphanQuestions as question (question.toolId)}
		<div class="max-w-[760px] mx-auto mb-3 px-5">
			<QuestionCard request={question} />
		</div>
	{/each}

	<!-- Scroll-to-bottom button -->
	<Button
		variant="ghost"
		size="content"
		layout="flow"
		tone="inherit"
		hoverFill="surface"
		id="scroll-btn"
		class="sticky bottom-3 left-1/2 -translate-x-1/2 bg-bg-alt border border-border rounded-full px-4 py-1.5 text-xs text-text-secondary z-5 font-sans {scrollCtrl.isDetached ? '' : 'hidden'}"
		title="Scroll to bottom"
		onclick={() => scrollCtrl.requestFollow()}
	>
		{scrollButtonText}
	</Button>
</div>
