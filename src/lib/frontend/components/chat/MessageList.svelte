<!-- Scrollable message container with auto-scroll and scroll-to-bottom button. -->
<!-- Renders history messages, live chat messages, and inline permission/question cards. -->
<!-- Preserves #messages ID for E2E. -->

<script module lang="ts">
	const reportedMissingPrompts = new Set<string>();
</script>

<script lang="ts">
	import TranscriptJump from "../ui/TranscriptJump.svelte";
	import Icon from "../ui/Icon.svelte";
	import { untrack } from "svelte";
	import type { ChatMessage } from "../../types.js";
	import {
		consumeScrollRequest,
		createEmptySessionMessages,
		currentChat,
		draftSendIn,
		getSessionPhase,
		isLlmActive,
		isProcessing,
		insertInputDraft,
		sessionMessages,
	} from "../../stores/chat.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { findSession, rootBackgroundTasks, sessionState } from "../../stores/session.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { discoveryState, getSessionDriver } from "../../stores/discovery.svelte.js";
	import { sessionGoals } from "../../stores/goal.svelte.js";
	import { splitAtForkPoint } from "../../utils/fork-split.js";
	import ForkContextBlock from "./ForkContextBlock.svelte";
	import ForkDivider from "./ForkDivider.svelte";
	import {
		uiState,
		selectRewindMessage,
	} from "../../stores/ui.svelte.js";
	import { permissionsState, getLocalPermissions } from "../../stores/permissions.svelte.js";
	import { createScrollController } from "../../stores/scroll-controller.svelte.js";
	import {
		noteScrollGesture,
		noteSessionChanged,
		publishAtBottom,
		sessionViewState,
	} from "../../stores/session-view.svelte.js";
	import {
		economics,
		forkMessageIdAtReply,
		LAUNCH_SETTLE_MS,
		lastResult,
		liveLaunchedTasks,
		segmentTurns,
		type Turn,
	} from "../../utils/turns.js";
	import UserMessage from "./UserMessage.svelte";
	import AssistantMessage from "./AssistantMessage.svelte";
	import TurnActivity from "./TurnActivity.svelte";
	import { insertComposerReference } from "../input/composer-reference.svelte.js";
	import RunningPill from "./RunningPill.svelte";
	import TurnEconomics from "./TurnEconomics.svelte";
	import ToolItem from "./ToolItem.svelte";
	import SystemMessage from "./SystemMessage.svelte";
	import PermissionCard from "../permissions/PermissionCard.svelte";
	import QuestionCard from "./QuestionCard.svelte";
	import HistoryLoader from "./HistoryLoader.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TranscriptDivider from "../ui/TranscriptDivider.svelte";
	import ContinuationDivider from "./ContinuationDivider.svelte";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import type { SessionResume } from "../../../contracts/limit-recovery.js";
	import { formatSnoozeTime } from "../../utils/format.js";
	import { retryFeedsNow } from "../../transport/supervise.js";
	import { transcriptFeed } from "../../stores/transcript.svelte.js";

	const END_OF_TRANSCRIPT = "end";
	let messagesEl: HTMLDivElement | undefined = $state();
	let { topClearance = 0, sessionId }: {
		topClearance?: number;
		sessionId?: string;
	} = $props();
	const instanceId = $props.id();
	const primary = $derived(sessionId === undefined);
	const viewedSessionId = $derived(sessionId ?? sessionState.currentId);
	const messagesId = $derived(primary ? "messages" : `messages-${instanceId}`);
	const emptyChat = createEmptySessionMessages();
	const chat = $derived(
		primary ? currentChat() : sessionMessages.get(sessionId ?? "") ?? emptyChat,
	);
	const processing = $derived(
		primary ? isProcessing() : isLlmActive(getSessionPhase(viewedSessionId ?? ""), chat.loadLifecycle),
	);
	let sentinelEl: HTMLElement | undefined = $state();
	// Rows, pills and strips share when this view last observed each live task.
	const taskListedAt = new Map<string, number>();
	let taskSessionId: string | null | undefined;
	let previousTaskIds: readonly string[] = [];
	let taskNow = $state(Date.now());
	const liveTasks = $derived.by(() => {
		const id = viewedSessionId;
		if (id !== taskSessionId) {
			taskListedAt.clear();
			previousTaskIds = [];
			taskSessionId = id;
		}
		const tasks = rootBackgroundTasks(id ?? "");
		const now = Date.now();
		const ids = new Set(tasks.map((task) => task.id));
		// The outcome can trail removal from the live list. Start its grace here,
		// rather than making every finished turn subscribe to the ticking clock.
		for (const id of previousTaskIds) {
			if (!ids.has(id)) taskListedAt.set(id, now);
		}
		for (const task of tasks) taskListedAt.set(task.id, now);
		previousTaskIds = [...ids];
		return tasks;
	});
	$effect(() => {
		const tasks = liveTasks;
		const ids = new Set(tasks.map((task) => task.id));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = () => {
			const now = Date.now();
			taskNow = now;
			let next = Number.POSITIVE_INFINITY;
			for (const [id, at] of taskListedAt) {
				const until = at + LAUNCH_SETTLE_MS;
				if (!ids.has(id) && until > now) next = Math.min(next, until);
			}
			if (Number.isFinite(next)) timer = setTimeout(refresh, next - now);
		};
		refresh();
		return () => clearTimeout(timer);
	});

	const scrollCtrl = createScrollController(() => chat.loadLifecycle);

	let handledFollowRequest = sessionViewState.followRequest;
	$effect(() => {
		if (!primary) return;
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
		const id = viewedSessionId;
		scrollCtrl.resetForSession();
		if (primary) untrack(() => noteSessionChanged(id));
	});

	// Publish for chrome outside the transcript (e.g. the session bar) so the app
	// never grows a second, differently-tuned definition of "at the bottom".
	// Hydration states count as pinned, otherwise the bar flaps on session open.
	$effect(() => {
		if (!primary) return;
		const state = scrollCtrl.state;
		publishAtBottom(
			state === "following" || state === "loading",
		);
	});

	// The bar follows the reader's gesture, not scrollTop: the bar's own resize
	// moves scrollTop (see topClearance below), so reading direction off scroll
	// events would let each toggle trigger the next.
	$effect(() => {
		const scroller = messagesEl;
		if (!scroller || !primary) return;
		const note = (delta: number) => {
			if (scroller.scrollHeight > scroller.clientHeight) noteScrollGesture(delta > 0 ? "down" : "up");
		};
		let touchY: number | undefined;
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY !== 0) note(event.deltaY);
		};
		const onTouchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY;
		};
		// A small dead zone keeps a tap or a wobbling thumb from toggling the bar.
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			if (touchY === undefined || y === undefined || Math.abs(touchY - y) < 10) return;
			note(touchY - y);
			touchY = y;
		};
		scroller.addEventListener("wheel", onWheel, { passive: true });
		scroller.addEventListener("touchstart", onTouchStart, { passive: true });
		scroller.addEventListener("touchmove", onTouchMove, { passive: true });
		return () => {
			scroller.removeEventListener("wheel", onWheel);
			scroller.removeEventListener("touchstart", onTouchStart);
			scroller.removeEventListener("touchmove", onTouchMove);
		};
	});

	// Container resizes can change the bottom gap without a scroll event.
	// Border box, because the default content box also shrinks when the top
	// clearance padding grows, and that is handled below without a snap.
	$effect(() => {
		const scroller = messagesEl;
		if (!scroller) return;
		const observer = new ResizeObserver(() => scrollCtrl.onContainerResize());
		observer.observe(scroller, { box: "border-box" });
		return () => observer.disconnect();
	});

	// The transcript's top padding follows topClearance (ChatLayout sets the
	// CSS variable). Chromium does not scroll-anchor on a scroller's own padding
	// change, so keep the reading position in place by hand. Only a reader at
	// the very bottom stays pinned there (shifting would double-count, as the
	// browser already clamps scrollTop when the padding shrinks). A reader just
	// above the bottom still counts as following, but the bar resizing is not
	// new content to follow, so they are shifted, not snapped. Svelte runs this
	// after the DOM update and before paint, so it lands in the same frame.
	let appliedClearance: number | undefined;
	$effect(() => {
		const scroller = messagesEl;
		if (!scroller) return;
		const delta = appliedClearance === undefined ? 0 : topClearance - appliedClearance;
		appliedClearance = topClearance;
		if (delta === 0) return;
		if (untrack(() => scrollCtrl.isPinned)) scrollCtrl.onContainerResize();
		else scroller.scrollTop += delta;
	});

	// Scroll to bottom when the transcript becomes ready.
	$effect(() => {
		if (chat.loadLifecycle === "ready") {
			scrollCtrl.onNewContent();
		}
	});

	// Auto-scroll when content changes (messages, permissions).
	// Guards:
	// - Skip during prepend (scroll preservation handles that case).
	// - Only auto-scroll when the reader was parked at the very bottom, the
	//   session is actively producing content (processing or streaming), or an
	//   explicit scroll request was made (e.g. error messages set this before
	//   phaseToIdle kills the isProcessing guard). On inactive sessions, a
	//   reader sitting just above the bottom must NOT be snapped down by
	//   background events (another tab's message, permission state).
	// NOTE: processing and consumeScrollRequest() are checked via
	// untrack() so they act as guards (checked but not tracked). The effect
	// only re-runs when actual content changes — not on every toggle.
	$effect(() => {
		const _len = chat.messages.length;
		// A detail upsert can grow the final bubble without changing the count.
		const _latest = chat.messages.at(-1);
		const _permLen = primary ? permissionsState.pendingPermissions.length : localPermissions.length;
		const _questionLen = primary ? 0 : orphanQuestions.length;
		const isActive = untrack(() => processing);
		const scrollRequested = untrack(() => primary && consumeScrollRequest());
		if (!awaitingPrepend && (isActive || scrollRequested || scrollCtrl.isPinned)) {
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
	const firstMessageUuid = $derived(chat.messages[0]?.uuid ?? "");

	// Track previous state for prepend detection
	let prevFirstUuid = "";
	let prevMessageCount = 0;
	let prevSessionId = $state("");

	// Capture scroll state BEFORE DOM update using $effect.pre
	$effect.pre(() => {
		const currentSessionId = viewedSessionId ?? "";
		const currentFirstUuid = firstMessageUuid;
		const currentCount = chat.messages.length;

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
		if (!primary || !uiState.rewindActive) return;

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

	const showJump = $derived(scrollCtrl.isDetached);

	// Keep finished turns' props stable when only a later part changes.
	function turnProjection() {
		let previous = new Map<string, Turn>();
		const same = (a: readonly ChatMessage[], b: readonly ChatMessage[]) =>
			a.length === b.length && a.every((item, i) => item === b[i]);
		return (messages: ChatMessage[], processing: boolean): Turn[] => {
			const next = segmentTurns(messages, processing).map((turn) => {
				const held = previous.get(turn.id);
				return held && held.user === turn.user && held.live === turn.live &&
					same(held.notices, turn.notices) &&
					held.segments.length === turn.segments.length &&
					turn.segments.every((segment, i) => {
						const old = held.segments[i];
						return old && old.end === segment.end && old.handBack === segment.handBack &&
							same(old.activity, segment.activity) && same(old.reply, segment.reply);
					}) ? held : turn;
			});
			previous = new Map(next.map((turn) => [turn.id, turn]));
			return next;
		};
	}
	const projectTurns = turnProjection();
	const projectInheritedTurns = turnProjection();
	const projectCurrentTurns = turnProjection();
	const turns = $derived(projectTurns(chat.messages, processing));
	const emptyLiveTurn = $derived<Turn | undefined>(
		processing && chat.loadLifecycle === "ready" && turns.length === 0
			? { id: `turn-${viewedSessionId ?? instanceId}`, segments: [{ activity: [], reply: [] }], notices: [], live: true }
			: undefined,
	);
	$effect(() => {
		if (!processing || chat.loadLifecycle !== "ready" || turns.at(-1)?.user) return;
		const sessionId = viewedSessionId;
		if (!sessionId) return;
		const key = JSON.stringify([sessionId, turns.at(-1)?.id ?? null]);
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
	const localPermissions = $derived(getLocalPermissions(viewedSessionId));
	const transcriptToolIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const message of chat.messages) {
			if (message.type === "tool") ids.add(message.id);
		}
		return ids;
	});
	// Pending questions outlive session switches so family replays survive;
	// only the viewed family's belong in this transcript. An optimistic switch
	// renders before its family arrives, so a family without the current
	// session is someone else's.
	const familyIds = $derived.by(() => {
		// A secondary pane owns only its child's orphan cards, not the family's.
		if (!primary) return new Set([viewedSessionId]);
		const currentId = viewedSessionId;
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
	const activeSession = $derived(findSession(viewedSessionId ?? ""));
	const providerId = $derived(getInstanceById(activeSession?.accountId ?? "")?.driver);
	const forkMessageId = $derived(activeSession?.forkPointMessageId ?? activeSession?.forkMessageId ?? (primary ? sessionState.currentFork?.forkMessageId : undefined));
	const forkPointTimestamp = $derived(activeSession?.forkPointTimestamp ?? (primary ? sessionState.currentFork?.forkPointTimestamp : undefined));
	const isFork = $derived(!!forkMessageId || !!forkPointTimestamp);
	const cutOffMessageId = $derived(activeSession?.limitRecovery?.cutOffMessageId);
	// The tag leaves when the server clears the cut-off; nothing is hidden locally.
	function dismissCutOff(): void {
		const sessionId = activeSession?.id;
		const projectSlug = activeSession?.projectSlug;
		if (!sessionId || !projectSlug) return;
		rpc("DismissCutOff", { sessionId, originId: getBrowserClientId() })
			.catch(toastFailure("Couldn't dismiss the cut-off"));
	}
	const forkSplit = $derived(
		isFork
			? splitAtForkPoint(
					chat.messages,
					forkMessageId,
					forkPointTimestamp,
				)
			: null,
	);
	// The fork point and lineage arrive together, so a row with a fork point
	// and no lineage outlived its Source; until then the announcement stands in.
	const forkedFrom = $derived(
		activeSession?.forkPointMessageId || activeSession?.forkMessageId || activeSession?.forkPointTimestamp
			? activeSession?.forkedFrom
			: primary ? sessionState.currentFork?.forkedFrom : undefined,
	);
	const sourceSession = $derived(forkedFrom ? findSession(forkedFrom) : null);
	// A fork renders two transcripts; only the current half can be live.
	const inheritedTurns = $derived(
		projectInheritedTurns(forkSplit?.inherited ?? [], false),
	);
	const currentTurns = $derived(
		projectCurrentTurns(forkSplit?.current ?? [], processing),
	);
	// Each continuation leaves a divider before the first reply-side message
	// created at or after it, or after the last message until one arrives. An
	// activity panel renders as one collapsed row, so a divider that falls inside
	// one goes before the whole panel. Keyed by the uuid it renders before.
	const resumeDividers = $derived.by(() => {
		const dividers = new Map<string, SessionResume[]>();
		const resumes = activeSession?.resumes ?? [];
		if (resumes.length === 0) return dividers;
		const slots = (forkSplit ? [...inheritedTurns, ...currentTurns] : turns).flatMap((turn) =>
			turn.segments.flatMap((segment) => [
				...(segment.activity[0] ? [{ key: segment.activity[0].uuid, parts: segment.activity }] : []),
				...segment.reply.map((reply) => ({ key: reply.uuid, parts: [reply] })),
			]),
		);
		for (const resume of resumes) {
			const key = slots.find((slot) => slot.parts.some((part) => (part.createdAt ?? -Infinity) >= resume.at))?.key ?? END_OF_TRANSCRIPT;
			dividers.set(key, [...(dividers.get(key) ?? []), resume]);
		}
		return dividers;
	});
	const goal = $derived(
		!primary || discoveryState.currentTraits?.supportsGoalState ? sessionGoals.get(viewedSessionId ?? "")?.goal : null,
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
		return chat.transcript && chat.transcript.hwm !== null && !chat.historyHasMore ? null : undefined;
	});
	const transcript = $derived(chat.transcript);
	const feed = $derived(transcriptFeed(transcript));
	const hasRows = $derived((transcript?.rows.length ?? 0) > 0);
	// Turns render from chat.messages, which can still hold items from before the
	// transcript reset. A cold open shows only the skeleton, never those leftovers.
	const coldOpen = $derived(feed === "catchingUp" && !hasRows);
	// A draft's first send shows until its new session places it, so the pane
	// is not empty and never skeletons over it.
	const firstSend = $derived(primary ? draftSendIn(sessionState.currentId) : null);
	// A cold pane has not heard from the feed, so it cannot yet claim the start.
	const startConfirmed = $derived(transcript != null && transcript.hwm !== null);

	// A touch on the view marks the session seen only while this turn's end is
	// on screen (utils/attention.ts).
	const newestEndedTurnId = $derived(
		(forkSplit && forkSplit.inherited.length > 0 ? [...inheritedTurns, ...currentTurns] : turns)
			.filter((turn) => !turn.live).at(-1)?.id,
	);
	const latestTurnId = $derived((forkSplit ? currentTurns.at(-1) ?? inheritedTurns.at(-1) : turns.at(-1))?.id);

</script>

<!-- Focusable so keyboard users can scroll it and `u` can target the open session. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	id={messagesId}
	data-session-id={viewedSessionId}
	role="region"
	aria-label="Transcript"
	tabindex="0"
	class="flex-1 overflow-y-auto pt-5 pb-3 relative"
	style="-webkit-overflow-scrolling: touch;"
	bind:this={messagesEl}
>
	<!-- History sentinel (triggers lazy-loading of older messages) -->
	<div id={primary ? "history-sentinel" : `${messagesId}-history-sentinel`} class="h-1" bind:this={sentinelEl}></div>

	<!-- Headless loader (no visual output) -->
	<HistoryLoader {sentinelEl} {sessionId} scrollRoot={primary ? undefined : messagesEl} />

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
	{#if (startConfirmed || firstSend) && !chat.historyHasMore && !chat.historyLoading && !isFork}
		<div class="history-beginning flex flex-col items-center py-4 text-text-dimmer text-xs">
			<div class="w-8 h-px bg-border mb-2"></div>
			<span>Beginning of session</span>
		</div>
	{/if}

	<!-- Loading indicator (was in HistoryView) -->
	{#if chat.historyLoading}
		<div class="history-loading flex items-center justify-center py-3 text-text-dimmer text-xs gap-2">
			<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} />
			<span>Loading history...</span>
		</div>
	{/if}

	<!-- Turn rendering snippet (shared between fork and normal paths) -->
	{#snippet turnItem(turn: Turn)}
		<div data-live-turn={turn.live ? "" : undefined}>
		{#if turn.user}
			<div class="msg-container" class:rewind-point={primary && uiState.rewindActive}>
				<UserMessage message={turn.user} onDismissCutOff={turn.user.messageId !== undefined && turn.user.messageId === cutOffMessageId ? dismissCutOff : undefined} />
			</div>
		{/if}
		{#if goal && turn.id === goalNoticeTurnId}
			{@render goalNotice()}
		{/if}
		{#each turn.segments as segment, i}
			{@const final = i === turn.segments.length - 1}
			{#if segment.activity[0]}
				{@render resumed(segment.activity[0].uuid)}
			{/if}
			{#if segment.activity.length > 0 || (final && turn.live)}
				{@const reply = segment.reply[0]}
				<TurnActivity latestTurn={turn.id === latestTurnId} newestSettledTurn={turn.id === newestEndedTurnId} {turn} {segment} {final} {liveTasks} {taskListedAt} {taskNow} sessionId={viewedSessionId ?? undefined} {providerId}
					onjump={scrollCtrl.requestJump}
					onReplyToAsk={(reference, text) => { if (viewedSessionId) insertComposerReference(reference, viewedSessionId); if (text) insertInputDraft(text); }}
					forkMessageId={reply ? forkMessageIdAtReply(turn, reply) : undefined}
					model={turn.user?.modelExecution?.actualModel ?? turn.user?.modelExecution?.requestedModel} />
			{/if}
			<!-- Notices sit between the final work and reply: they are lifted out of
			     the activity log so a failure is never hidden behind a collapsed panel. -->
			{#if final}
				{#each turn.notices as notice (notice.uuid)}
					<div class="msg-container">
						<SystemMessage message={notice} driver={viewedSessionId ? getSessionDriver(viewedSessionId) : undefined} />
					</div>
				{/each}
			{/if}
			{#each segment.reply as reply (reply.uuid)}
				{@render resumed(reply.uuid)}
				<div class="msg-container" class:rewind-point={primary && uiState.rewindActive}>
					<AssistantMessage {sessionId} {providerId} message={reply} forkMessageId={forkMessageIdAtReply(turn, reply)}
						hideHeader={reply === segment.reply[0] && (segment.activity.length > 0 || (final && turn.live))}
						model={turn.user?.modelExecution?.actualModel ?? turn.user?.modelExecution?.requestedModel} />
				</div>
			{/each}
			{#if segment.handBack}
				<div class="max-w-[820px] mx-auto px-[14px] md:px-[32px]">
					<div class="md:ml-[42px]"><ToolItem message={segment.handBack} /></div>
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
				<div class="max-w-[820px] mx-auto px-[14px] md:px-[32px]">
					<div class="result-bar @container md:ml-[42px] -mt-[18px] mb-[26px]">
						<RunningPill count={liveLaunchedTasks(turn, liveTasks, liveTasks.length > 0 && turn.live ? clock.now : taskNow, taskListedAt).size} />
						<TurnEconomics economics={bill} showDuration />
					</div>
				</div>
			</div>
		{/if}
		{#if turn.id === newestEndedTurnId}
			<div data-turn-end aria-hidden="true"></div>
		{/if}
		</div>
	{/snippet}

	{#snippet resumed(key: string)}
		{#each resumeDividers.get(key) ?? [] as resume, i (i)}
			{#if resume.from !== undefined && resume.from !== resume.instanceId && activeSession}
				<ContinuationDivider {resume} sessionId={activeSession.id} />
			{:else}
				<TranscriptDivider data-testid="transcript-divider" class="max-w-[760px] mx-auto px-5">
					↻ Resumed on <b>{getInstanceById(resume.instanceId)?.name ?? resume.instanceId}</b>{resume.reason === "user" ? " · retried by you" : resume.reason === "reset" ? ` after reset · ${formatSnoozeTime(resume.at)}` : ""}
				</TranscriptDivider>
			{/if}
		{/each}
	{/snippet}

	{#snippet goalNotice()}
		{#if goal}
			<div data-testid="session-goal-notice" class="max-w-[760px] mx-auto mb-3 px-5 flex items-start gap-1.5 text-[11px] text-status-goal">
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
	<div onclick={primary && uiState.rewindActive ? handleRewindClick : undefined} inert={feed !== "live"} hidden={coldOpen}>
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
			sourceTitle={sourceSession?.title ?? "parent session"}
			sourceId={forkedFrom}
		/>

		{#each currentTurns as turn (turn.id)}
			{@render turnItem(turn)}
		{/each}
	{:else}
		{#each turns as turn (turn.id)}
			{@render turnItem(turn)}
		{/each}
	{/if}
	{@render resumed(END_OF_TRANSCRIPT)}
	</div>
	{#if firstSend}
		<div class="msg-container">
			<UserMessage message={firstSend} />
		</div>
	{/if}
	{#if emptyLiveTurn}
		{@render turnItem(emptyLiveTurn)}
	{/if}

	<!-- Cold open: turn-shaped placeholders fill the pane, bottom-anchored where
	     the newest messages land; extra turns clip off the top. -->
	{#if coldOpen && !firstSend}
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

	<!-- Pending permission requests for the viewed session. -->
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

	<!-- Zero-height rail keeps the floating action out of transcript geometry. -->
	<div class="sticky bottom-[10px] h-0 flex justify-center z-5" hidden={!showJump}>
		<TranscriptJump
			id={primary ? "scroll-btn" : `${messagesId}-scroll-btn`}
			data-testid={processing ? "jump-to-live" : "jump-to-latest"}
			live={processing}
			class="-translate-y-full"
			title={processing ? "Jump to live" : "Scroll to bottom"}
			onclick={() => scrollCtrl.requestFollow()}
		/>
	</div>
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
