<!-- Scrollable message container with auto-scroll and scroll-to-bottom button. -->
<!-- Renders history messages, live chat messages, and inline permission/question cards. -->
<!-- Preserves #messages ID for E2E. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import { untrack } from "svelte";
	import { currentChat, isProcessing, consumeScrollRequest } from "../../stores/chat.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { dismissCutOffRpc } from "../../transport/ws-rpc-client.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { sessionGoals } from "../../stores/goal.svelte.js";
	import { splitAtForkPoint } from "../../utils/fork-split.js";
	import ForkContextBlock from "./ForkContextBlock.svelte";
	import ForkDivider from "./ForkDivider.svelte";
	import {
		uiState,
		selectRewindMessage,
		showToast,
	} from "../../stores/ui.svelte.js";
	import { permissionsState, getLocalPermissions } from "../../stores/permissions.svelte.js";
	import { createScrollController } from "../../stores/scroll-controller.svelte.js";
	import {
		noteSessionChanged,
		noteUserScroll,
		publishAtBottom,
		sessionViewState,
	} from "../../stores/session-view.svelte.js";
	import { economics, forkMessageIdAtReply, lastResult, segmentTurns, type Turn } from "../../utils/turns.js";
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
	import TextButton from "../ui/TextButton.svelte";
	import { retryFeedsNow } from "../../transport/supervise.js";
	import { transcriptFeed } from "../../stores/transcript.svelte.js";

	let messagesEl: HTMLDivElement | undefined = $state();
	let { topClearance = 0 }: { topClearance?: number } = $props();
	let sentinelEl: HTMLElement | undefined = $state();

	const scrollCtrl = createScrollController(
		() => currentChat().loadLifecycle,
		noteUserScroll,
	);

	let handledFollowRequest = sessionViewState.followRequest;
	$effect(() => {
		const request = sessionViewState.followRequest;
		if (request === handledFollowRequest) return;
		handledFollowRequest = request;
		untrack(() => scrollCtrl.requestFollow());
	});

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
		const sessionId = sessionState.currentId;
		scrollCtrl.resetForSession();
		untrack(() => noteSessionChanged(sessionId));
	});

	// Publish for chrome outside the transcript (e.g. the session bar) so the app
	// never grows a second, differently-tuned definition of "at the bottom".
	// Hydration states count as pinned, otherwise the bar flaps on session open.
	$effect(() => {
		const state = scrollCtrl.state;
		publishAtBottom(
			state === "following" || state === "loading",
		);
	});

	// Container resizes can change the bottom gap without a scroll event.
	$effect(() => {
		const scroller = messagesEl;
		if (!scroller) return;
		const observer = new ResizeObserver(() => scrollCtrl.onContainerResize());
		observer.observe(scroller);
		return () => observer.disconnect();
	});

	// The transcript's top padding follows topClearance (ChatLayout sets the
	// CSS variable). Chromium does not scroll-anchor on a scroller's own padding
	// change, so keep a detached reading position in place by hand. Svelte runs
	// this after the DOM update and before paint, so it lands in the same frame.
	let appliedClearance: number | undefined;
	$effect(() => {
		const scroller = messagesEl;
		if (!scroller) return;
		const delta = appliedClearance === undefined ? 0 : topClearance - appliedClearance;
		appliedClearance = topClearance;
		if (delta !== 0 && untrack(() => scrollCtrl.isDetached)) scroller.scrollTop += delta;
		untrack(() => scrollCtrl.onContainerResize());
	});

	// Scroll to bottom when the transcript becomes ready.
	$effect(() => {
		if (currentChat().loadLifecycle === "ready") {
			scrollCtrl.onNewContent();
		}
	});

	// Auto-scroll when content changes (messages, permissions).
	// Guards:
	// - Skip during prepend (scroll preservation handles that case).
	// - Only auto-scroll when session is actively producing content
	//   (processing or streaming) OR when an explicit
	//   scroll request was made (e.g. error messages set this before
	//   phaseToIdle kills the isProcessing guard). On inactive sessions,
	//   background events (cross-tab user_message, permission state) must
	//   NOT snap to bottom.
	// NOTE: isProcessing() and consumeScrollRequest() are checked via
	// untrack() so they act as guards (checked but not tracked). The effect
	// only re-runs when actual content changes — not on every toggle.
	$effect(() => {
		const _len = currentChat().messages.length;
		// A detail upsert can grow the final bubble without changing the count.
		const _latest = currentChat().messages.at(-1);
		const _permLen = permissionsState.pendingPermissions.length;
		const isActive = untrack(() => isProcessing());
		const scrollRequested = untrack(() => consumeScrollRequest());
		if (!awaitingPrepend && (isActive || scrollRequested)) {
			scrollCtrl.onNewContent();
		}
	});

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

	const scrollButtonText = $derived(
		isProcessing() ? "↓ New activity" : "↓ Latest",
	);

	const turns = $derived(segmentTurns(currentChat().messages, isProcessing(), currentChat().turnEpoch));
	const localPermissions = $derived(getLocalPermissions(sessionState.currentId));
	const transcriptToolIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const message of currentChat().messages) {
			if (message.type === "tool") ids.add(message.id);
		}
		return ids;
	});
	// Pending questions outlive session switches so family replays survive;
	// only the viewed family's belong in this transcript. An optimistic switch
	// renders before its family arrives, so a family without the current
	// session is someone else's.
	const familyIds = $derived.by(() => {
		const currentId = sessionState.currentId;
		const ids = new Set(sessionState.familySessions.map((session) => session.id));
		return currentId && ids.has(currentId) ? ids : new Set([currentId]);
	});
	const orphanQuestions = $derived(
		permissionsState.pendingQuestions.filter(
			(question) =>
				familyIds.has(question.sessionId) &&
				!transcriptToolIds.has(question.toolId) &&
				(!question.toolUseId || !transcriptToolIds.has(question.toolUseId)),
		),
	);

	// Fork context: detect if current session is a user fork
	const activeSession = $derived(findSession(sessionState.currentId ?? ""));
	const forkMessageId = $derived(activeSession?.forkPointMessageId ?? activeSession?.forkMessageId ?? sessionState.currentFork?.forkMessageId);
	const forkPointTimestamp = $derived(activeSession?.forkPointTimestamp ?? sessionState.currentFork?.forkPointTimestamp);
	const isFork = $derived(!!forkMessageId || !!forkPointTimestamp);
	const cutOffMessageId = $derived(activeSession?.limitRecovery?.cutOffMessageId);
	// The tag leaves when the server clears the cut-off; nothing is hidden locally.
	function dismissCutOff(): void {
		const sessionId = activeSession?.id;
		const projectSlug = activeSession?.projectSlug ?? getCurrentSlug();
		if (!sessionId || !projectSlug) return;
		dismissCutOffRpc({ projectSlug, sessionId, originId: getBrowserClientId() })
			.catch(() => showToast("Couldn't dismiss the cut-off", { variant: "error" }));
	}
	const forkSplit = $derived(
		isFork
			? splitAtForkPoint(
					currentChat().messages,
					forkMessageId,
					forkPointTimestamp,
				)
			: null,
	);
	const parentSession = $derived(
		sessionState.currentParentId ? findSession(sessionState.currentParentId) : null,
	);
	// A fork renders two transcripts; only the current half can be live.
	const inheritedTurns = $derived(
		forkSplit ? segmentTurns(forkSplit.inherited, false) : [],
	);
	const currentTurns = $derived(
		forkSplit ? segmentTurns(forkSplit.current, isProcessing(), currentChat().turnEpoch) : [],
	);
	const goal = $derived(
		discoveryState.currentProviderId === "claude" ? sessionGoals.get(sessionState.currentId ?? "")?.goal : null,
	);
	const goalNoticeTurnId = $derived.by(() => {
		if (!goal) return null;
		const visibleTurns = forkSplit ? currentTurns : turns;
		const latestFirst = [...visibleTurns].reverse();
		// The set fact follows its user prompt. Persisted timestamps keep that
		// position when later turns arrive or this transcript is loaded again.
		const anchor = latestFirst.find((turn) => turn.user?.text.trim() === `/goal ${goal.condition}` && (turn.user.createdAt === undefined || turn.user.createdAt <= goal.setAt))
			?? latestFirst.find((turn) => turn.user?.createdAt !== undefined && turn.user.createdAt <= goal.setAt);
		if (anchor) return anchor.id;
		// An older goal must not acquire the newest turn as its start. Wait
		// until paging reaches its prompt, or the transcript's actual beginning.
		const chat = currentChat();
		return chat.transcript && chat.transcript.hwm !== null && !chat.historyHasMore ? null : undefined;
	});
	const transcript = $derived(currentChat().transcript);
	const feed = $derived(transcriptFeed(transcript));
	const hasRows = $derived((transcript?.rows.length ?? 0) > 0);
	// A cold pane has not heard from the feed, so it cannot yet claim the start.
	const startConfirmed = $derived(transcript != null && transcript.hwm !== null);

	// A touch on the view marks the session seen only while this turn's end is
	// on screen (utils/attention.ts).
	const newestEndedTurnId = $derived(
		(forkSplit && forkSplit.inherited.length > 0 ? [...inheritedTurns, ...currentTurns] : turns)
			.filter((turn) => !turn.live).at(-1)?.id,
	);

</script>

<!-- Focusable so keyboard users can scroll it and `u` can target the open session. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	id="messages"
	role="region"
	aria-label="Transcript"
	tabindex="0"
	class="flex-1 overflow-y-auto pt-5 pb-3 relative"
	style="-webkit-overflow-scrolling: touch;"
	bind:this={messagesEl}
>
	<!-- History sentinel (triggers lazy-loading of older messages) -->
	<div id="history-sentinel" class="h-1" bind:this={sentinelEl}></div>

	<!-- Headless loader (no visual output) -->
	<HistoryLoader {sentinelEl} />

	<!-- Zero-height sticky rail so the pill floats over the transcript without
	     pushing it down; the lift parks it in the top padding so at rest
	     it clears the first row. The pill fades in late, so fast switches never show it. -->
	{#if feed !== "live" && (hasRows || feed === "failing")}
		<div class="sticky top-4 z-10 h-0 flex items-start justify-center">
			<div
				class="feed-pill -translate-y-3 flex items-center gap-2 bg-bg-alt border border-border rounded-full px-3 py-0.5 text-xs text-text-secondary font-sans shadow-sm"
				class:feed-pill-delayed={feed !== "failing"}
				role="status"
				data-testid="transcript-feed-pill"
			>
				{#if feed === "failing"}
					<span>Couldn't refresh</span>
					<span aria-hidden="true" class="text-text-dimmer">·</span>
					<TextButton tone="accent" onclick={retryFeedsNow}>Retry</TextButton>
				{:else}
					<span>Catching up</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Beginning of session marker (was in HistoryView) -->
	{#if startConfirmed && !currentChat().historyHasMore && !currentChat().historyLoading && !isFork}
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
				<UserMessage message={turn.user} onDismissCutOff={turn.user.messageId !== undefined && turn.user.messageId === cutOffMessageId ? dismissCutOff : undefined} />
			</div>
		{/if}
		{#if goal && turn.id === goalNoticeTurnId}
			{@render goalNotice()}
		{/if}
		{#each turn.segments as segment, i}
			{@const final = i === turn.segments.length - 1}
			{#if segment.activity.length > 0 || (i > 0 && final && turn.live)}
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
					<AssistantMessage message={reply} forkMessageId={forkMessageIdAtReply(turn, reply)} />
				</div>
			{/each}
			{#if segment.handBack}
				<div class="max-w-[760px] mx-auto px-5">
					<ToolItem message={segment.handBack} />
				</div>
			{/if}
		{/each}
		<!-- A final segment that did work carries its bill on the strip. A text-only
		     final segment has no ledger, so it renders the same bill on its own line —
		     one formatter for both, rather than a second dialect of the same facts.
		     .result-bar is an E2E selector; .turn-meta rides on TurnEconomics. -->
		{#if lastResult(turn) && turn.segments.at(-1)?.activity.length === 0 && (turn.segments.length === 1 || !turn.live)}
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
		{#if turn.id === newestEndedTurnId}
			<div data-turn-end aria-hidden="true"></div>
		{/if}
	{/snippet}

	{#snippet goalNotice()}
		{#if goal}
			<div data-testid="session-goal-notice" class="max-w-[760px] mx-auto mb-3 px-5 flex items-start gap-1.5 text-[11px] text-status-violet">
				<Icon name="target" size={12} class="shrink-0 mt-[2px]" />
				<span class="whitespace-pre-wrap break-words min-w-0">Goal set · {goal.condition}</span>
			</div>
		{/if}
	{/snippet}

	<!-- Single render loop for ALL messages (click delegation for rewind mode) -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- Inert until synchronized: answering, forking or rewinding against a
	     transcript that is still catching up would act on stale content. -->
	<div onclick={uiState.rewindActive ? handleRewindClick : undefined} inert={feed !== "live"}>
	{#if goal && goalNoticeTurnId === null}
		{@render goalNotice()}
	{/if}
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

	<!-- Cold open: turn-shaped placeholders fill the pane, bottom-anchored where
	     the newest messages land; extra turns clip off the top. -->
	{#if feed === "catchingUp" && !hasRows}
		<div
			class="transcript-skeleton absolute inset-x-0 top-5 bottom-3 overflow-hidden max-w-[760px] mx-auto px-5 flex flex-col justify-end gap-6"
			aria-hidden="true"
			data-testid="transcript-skeleton"
		>
			<!-- Enough turns to cover a tall monitor; varied line widths read as prose. -->
			{#each { length: 12 }, i}
				<div class="flex flex-col gap-3 shrink-0">
					<div class="h-14 rounded-lg border border-border bg-bg-alt motion-safe:animate-pulse"></div>
					{#each [["w-4/5", "w-3/5"], ["w-11/12", "w-4/5", "w-2/5"], ["w-3/4", "w-1/2"]][i % 3] as width}
						<div class="h-4 {width} rounded-md bg-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}

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

<style>
	/* The delays are the whole point: a switch that synchronizes first never
	   shows either element. 250ms for a warm pane's pill, 150ms for a cold
	   pane's skeleton, per the switching-visuals decision (3A). */
	.feed-pill-delayed {
		animation: session-fade-in 150ms ease-out 250ms both;
	}
	.transcript-skeleton {
		animation: session-fade-in 150ms ease-out 150ms both;
		/* Softens the turn clipped at the top edge. */
		mask-image: linear-gradient(to bottom, transparent, black 4rem);
	}
</style>
