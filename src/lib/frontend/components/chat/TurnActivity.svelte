<!-- The turn head keeps counts and duration above a shared activity strip.
     Skills, task status and the bill stay in the step log or duration hover.
     Resting on the turn prefetches tool details; a strip tap opens its log row. -->
<script module lang="ts">
	export type RunLabel =
		| { kind: "working" }
		| { kind: "woken"; task?: string }
		| { kind: "stopping"; stuck?: boolean };
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from "svelte";
	import type { ComponentProps, Snippet } from "svelte";
	import type { SessionResume } from "../../../contracts/limit-recovery.js";
	import { assertNever } from "../../../utils.js";
	import SurfacingAskContext, { type AskState } from "./SurfacingAskContext.svelte";
	import type { CategorySet } from "../../../contracts/category-set.js";
	import type { MessageSurfacingStatus, MessageSurfacingPreferences } from "../../../contracts/message-surfacing.js";
	import { numberTurnMessages } from "../../../turn-message-numbers.js";
	import { TurnRecapState } from "../../stores/turn-recap.svelte.js";
	import SurfacingSummary from "./SurfacingSummary.svelte";
	import { messageSurfacing, sessionJevEnabled } from "../../stores/message-surfacing.svelte.js";
	import { createTurnPanel, landTurnTarget, type TurnPanelState } from "../../stores/turn-panel.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { stopCounts } from "../../utils/turn-stops.js";
	import { canOpenSurfaceMessage, surfaceTurn, surfaceKey, type CardSelection, type SurfaceLevel, type SurfacePart, type SurfacePin } from "../../utils/surface-turn.js";
	import SurfacingCard, { type ReadState, type SurfacingRegions } from "./SurfacingCard.svelte";
	import { MARK_GLYPHS, SurfacingFeedback } from "../../stores/surfacing-feedback.svelte.js";
	import SurfacingMarkActions from "./SurfacingMarkActions.svelte";
	import SurfacingMarkWhy from "./SurfacingMarkWhy.svelte";
	import { insertComposerReference, messageReplies, removeComposerReference, type ReplyReference } from "../input/composer-reference.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { reveal } from "../../stores/reveal.svelte.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { shownCut, toolDetails } from "../../stores/tool-details.js";
	import type { BackgroundTask } from "../../../shared-types.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	import {
		countsPhrase,
		currentStepLabel,
		economics,
		fmtDuration,
		liveLaunchedTasks,
		plural,
		stepCaption,
		stepDurations,
		stripLayout,
		type Segment,
		type Turn,
		type TurnLogEntry,
		turnStats,
		workingTime,
	} from "../../utils/turns.js";
	import ActivityRow from "./ActivityRow.svelte";
	import ActivityStrip from "./ActivityStrip.svelte";
	import MinimisedTurn from "./MinimisedTurn.svelte";
	import TurnLog from "./TurnLog.svelte";
	import TurnShowBar from "./TurnShowBar.svelte";
	import RunningPill from "./RunningPill.svelte";
	import TurnEconomics from "./TurnEconomics.svelte";
	import AssistantHeader from "./AssistantHeader.svelte";

	let { turn, segment, final, entries, renderResume, runLabel = { kind: "working" }, liveTasks = [], taskListedAt = new Map<string, number>(), taskNow = Date.now(), sessionId, forkMessageId, model, providerId, onsummarize, onjump, numbered = false, latestTurn = true, newestSettledTurn = latestTurn, surfacing, surfacingRegions = {}, onSurfacingShortcut, onMessagesRead, onReplyToAsk, hasRecap = false, panel = createTurnPanel({
		get sessionId() { return sessionId; }, get turn() { return turn; },
		get jev() { return surfacingActive; }, get processing() { return turn.live; },
		get latestTurn() { return latestTurn; }, get newestSettledTurn() { return newestSettledTurn; },
		get status() { return surfacingConfig.status; }, get categorySet() { return surfacingConfig.categorySet; },
	}) }: {
		panel?: TurnPanelState;
		turn: Turn;
		runLabel?: RunLabel;
		segment: Segment;
		final: boolean;
		entries?: readonly TurnLogEntry[];
		renderResume?: Snippet<[SessionResume]>;
		liveTasks?: readonly BackgroundTask[];
		taskListedAt?: ReadonlyMap<string, number>;
		taskNow?: number;
		sessionId?: string | undefined;
		forkMessageId?: string | undefined;
		model?: string | undefined;
		providerId?: string | undefined;
		onsummarize?: (() => void) | undefined;
		onjump?: (() => void) | undefined;
		numbered?: boolean;
		latestTurn?: boolean;
		newestSettledTurn?: boolean;
		surfacing?: { status: MessageSurfacingStatus; categorySet: CategorySet };
		surfacingRegions?: SurfacingRegions;
		hasRecap?: boolean;
		onSurfacingShortcut?: (key: string) => boolean | undefined;
		onMessagesRead?: (partIds: readonly string[], read: boolean) => Promise<void>;
		onReplyToAsk?: (reference: ReplyReference, text?: string) => void;
	} = $props();

	const fullLog = $derived(panel.view.kind === "open" && panel.view.view.kind === "show" && panel.view.view.stop === "log");
	type StripInteraction = Parameters<NonNullable<ComponentProps<typeof ActivityStrip>["oninteraction"]>>[0];
	type CardSlot = NonNullable<ComponentProps<typeof ActivityStrip>["cardSlot"]>;
	let stripInteraction = $state<StripInteraction>({ hovered: null, scrubbing: false });
	let stripWidth = $state(0);
	let citedStep = $state<string | null>(null);
	let panelEl = $state<HTMLDivElement | undefined>();
	let headTooltip = $state(false);

	const settledNow = Date.now();
	const now = $derived(final && turn.live ? clock.now : settledNow);

	const stats = $derived(turnStats(segment));
	const durations = $derived(stepDurations(segment, turn, final, now));
	const duration = $derived(workingTime(turn, now));
	const bill = $derived(economics(turn, now));
	const running = $derived(liveLaunchedTasks(turn, liveTasks, liveTasks.length > 0 && turn.live ? clock.now : taskNow, taskListedAt));
	const phrase = $derived(countsPhrase(stats));
	const logEntries = $derived(entries ?? segment.activity.map((part, index): TurnLogEntry => ({ kind: "step", uuid: part.uuid, index, part })));
	const live = $derived(panel.phase !== "settled");
	function runText(label: RunLabel): string {
		switch (label.kind) {
			case "working": return "Working";
			case "woken": return label.task ?? "Woken";
			case "stopping": return label.stuck ? "Still stopping" : "Stopping";
			default: return assertNever(label);
		}
	}
	const numberedMessages = $derived(numberTurnMessages(segment.activity.flatMap((part) => part.type === "assistant" ? [part] : [])));
	function messageNumber(index: number): number | undefined {
		const part = segment.activity[index];
		// A live message Jev has yet to number keeps its icon: a predicted number
		// shifts if another message persists first, and citations would drift.
		if (part?.type !== "assistant" || (surfacingActive && turn.live && part.surfacingOrdinal == null)) return undefined;
		return numbered || surfacingActive || summariesOn ? numberedMessages.find(({ uuid }) => uuid === part.uuid)?.surfacingOrdinal : undefined;
	}

	const surfacingConfig = $derived(surfacing ?? messageSurfacing);
	const surfacingActive = $derived(sessionJevEnabled(sessionId ? findSession(sessionId) : undefined, surfacingConfig.status));
	const level = $derived(panel.saved);
	const recap = new TurnRecapState();
	let asks = $state<Record<string, AskState>>({});
	/** The Ask a citation left, offered back on the cited message's card. */
	let askReturn = $state<{ ask: SurfacePin; cited: string } | null>(null);
	function setupFor(pin: SurfacePin): SurfacePart | null {
		const parts = [...segment.activity, ...segment.reply];
		const index = parts.findIndex((part) => part.uuid === pin.part.uuid);
		return parts.slice(0, Math.max(0, index)).reverse().find((part): part is SurfacePart => part.type === "assistant" && !!part.rawText.trim()) ?? null;
	}
	async function explainAsk(pin: SurfacePin) {
		const uuid = pin.part.uuid;
		if (!sessionId || !storeTurnId || !pin.part.partId || asks[uuid]?.kind === "ready" || Object.values(asks).some(({ kind }) => kind === "loading")) return;
		asks[uuid] = { kind: "loading" };
		try {
			const explanation = await rpc("ExplainAsk", { sessionId, turnId: storeTurnId, partId: pin.part.partId });
			asks[uuid] = { kind: "ready", explanation };
		} catch (error) {
			asks[uuid] = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
		}
	}
	/** The event store keys a turn by its user message id; turn.id is that row's transcript uuid. */
	const storeTurnId = $derived(turn.storeId ?? turn.user?.messageId);
	const phone = $derived(sessionViewState.compact);
	let summaryOpen = $state<{ storeId: string; open: boolean } | null>(null);
	let summarySettingsError = $state("");
	let summarySaving = $state(false);
	let citedOrdinal = $state<number | null>(null);
	const summarySettings = $derived(surfacingConfig.status.recap);
	const summariesOn = $derived(surfacingConfig.status.summariesEnabled && summarySettings.model !== "off");
	const summaryEnabled = $derived(summariesOn && final && !!sessionId && !!storeTurnId);
	const summaryLabel = $derived(recap.generating ? "✦ Summarizing…" : "✦ Summary");
	$effect(() => {
		const id = storeTurnId;
		const session = sessionId;
		const active = summaryEnabled;
		const watch = latestTurn;
		// A turn can settle while its asynchronous automatic recap is still running.
		if (active && session && id) return untrack(() => recap.connect(session, id, watch));
		return;
	});
	let selection = $state<CardSelection>({ kind: "auto" });
	let readState = $state<ReadState>({ kind: "idle" });
	// A card is auto-read at most once per mount, so an explicit Unread sticks.
	const autoReadAttempts = new Set<string>();
	let readCardEl = $state<HTMLElement>();
	let readCardOnScreen = $state(false);
	let pageVisible = $state(false);
	let keyBuffer = $state("");
	const feedback = new SurfacingFeedback(() => sessionId, () => surfacingConfig.categorySet, (place) => {
		void tick().then(() => {
			const target = place === "card" ? panelEl?.querySelector<HTMLElement>('[data-testid="surfacing-msg-card"]') : panelEl?.querySelector<HTMLElement>(`[data-testid="${place}"] button`);
			target?.focus({ preventScroll: true });
		});
	}, pick, (uuid) => { const part = segment.activity.find((part) => part.uuid === uuid); return part?.type === "assistant" ? part : undefined; });
	onDestroy(() => feedback.dispose());
	const counts = $derived(stopCounts({ ...turn, segments: turn.segments.map((segment) => ({
		...segment, activity: segment.activity.map((part) => part.type === "assistant" ? feedback.annotate(part) : part), reply: segment.reply.map((part) => feedback.annotate(part)),
	})) }, surfacingConfig.categorySet, live));
	const surface = $derived(surfaceTurn({
		parts: segment.activity.map((part) => part.type === "assistant" ? feedback.annotate(part) : part), turnParts: numberedMessages.map((part) => feedback.annotate(part)),
		positions: stripLayout(segment, turn, final, now, stripWidth), categorySet: surfacingConfig.categorySet,
		level, view: panel.view.kind === "open" ? panel.view.view : null, live, latestTurn, latestBlock: final, hasRecap: hasRecap || (summaryEnabled && recap.versions.length > 0 && !recap.error), citedOrdinal, selection: stripInteraction.scrubbing && stripInteraction.hovered ? { kind: "picked", uuid: stripInteraction.hovered } : panel.target?.kind === "message" ? { kind: "picked", uuid: panel.target.uuid } : selection, start: turn.user?.createdAt ?? segment.activity[0]?.createdAt ?? 0,
	}));
	const summaryNew = $derived(surface.numbers.filter(({ number }) => number > (recap.versions.at(-1)?.lastOrdinal ?? 0)).length);
	const minimised = $derived(panel.view.kind === "collapsed");
	const cardSlot = $derived.by((): CardSlot => {
		if (!surfacingActive) return { kind: "none" };
		if (panel.view.kind === "collapsed") {
			const card = surface.messages.find((pin) => pin.part.uuid === stripInteraction.hovered);
			return card ? { kind: "preview", card } : { kind: "none" };
		}
		return surface.card ? { kind: "selected", card: surface.card } : { kind: "none" };
	});
	// A collapsed Jev turn previews in its strip, so only open strips caption the head.
	const hovered = $derived(minimised && surfacingActive ? -1 : segment.activity.findIndex((part) => part.uuid === stripInteraction.hovered));
	const summaryVisible = $derived((!surfacingActive || !minimised) && summaryEnabled && (summaryOpen && summaryOpen.storeId === storeTurnId ? summaryOpen.open : (!phone && !turn.live && latestTurn && (recap.versions.length > 0 || recap.generating || !!recap.error))));
	function toggleMinimised() {
		if (panel.view.kind === "collapsed") panel.open();
		else panel.collapse();
		void tick().then(() => panelEl?.querySelector<HTMLElement>('[data-testid="surfacing-card"]')?.focus({ preventScroll: true }));
	}
	// Track scalars so the live strip's clock cannot restart the read dwell.
	const readTarget = $derived(cardSlot.kind === "selected" && cardSlot.card.read === false ? cardSlot.card.part.uuid : null);
	const readText = $derived(cardSlot.kind === "selected" ? cardSlot.card.part.rawText : "");
	$effect(() => {
		const changed = () => { pageVisible = document.visibilityState === "visible"; };
		changed();
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	});
	$effect(() => {
		if (!readCardEl) { readCardOnScreen = false; return; }
		const observer = new IntersectionObserver((entries) => {
			const entry = entries.at(-1);
			readCardOnScreen = !!entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
		});
		observer.observe(readCardEl);
		return () => observer.disconnect();
	});
	// An unread card is read after 1s continuously visible, on screen and not scrubbed past.
	$effect(() => {
		const target = readTarget;
		void readText;
		if (!target || !pageVisible || !readCardOnScreen || stripInteraction.scrubbing || readState.kind === "saving" || autoReadAttempts.has(target)) return;
		const timer = setTimeout(() => {
			const card = untrack(() => cardSlot.kind === "selected" ? cardSlot.card : null);
			if (card?.part.uuid === target && document.visibilityState === "visible" && readCardOnScreen && !stripInteraction.scrubbing) readMessage(card, true);
		}, 1000);
		return () => clearTimeout(timer);
	});
	/** `uuid` names the card a failure belongs to; bulk saves default to the open card, or the turn when folded. */
	async function writeRead(partIds: readonly string[], read: boolean, uuid = cardSlot.kind === "selected" ? cardSlot.card.part.uuid : turn.id) {
		if (readState.kind === "saving" || !partIds.length || (!sessionId && !onMessagesRead)) return;
		readState = { kind: "saving", uuid };
		try {
			if (onMessagesRead) await onMessagesRead(partIds, read);
			else if (sessionId) await rpc("SetMessagesRead", { sessionId, partIds: [...partIds], read });
			readState = { kind: "idle" };
		} catch {
			readState = { kind: "failed", uuid, message: "Couldn't save read state. Try again." };
		}
	}
	function readMessage(pin: SurfacePin, read: boolean) {
		autoReadAttempts.add(pin.part.uuid);
		if (pin.part.partId) void writeRead([pin.part.partId], read, pin.part.uuid);
	}

	function pick(pin: SurfacePin) {
		void reveal({ sessionId, uuid: pin.part.uuid });
	}
	function acknowledgeMessage(seq: number) {
		if (panel.pending?.seq !== seq || panel.target?.kind !== "message") return;
		selection = { kind: "picked", uuid: panel.target.uuid };
		panel.ack(seq);
	}
	function toggleSummary() {
		if (!storeTurnId) return;
		const visible = summaryVisible;
		if (minimised && surfacingActive) panel.open();
		summaryOpen = { storeId: storeTurnId, open: !visible };
	}
	function closeSummary() {
		if (storeTurnId) summaryOpen = { storeId: storeTurnId, open: false };
	}
	function retrySummary() {
		generateSummary(recap.retry?.scope ?? (recap.versions.length && summaryNew > 0 ? "new" : "whole"), recap.retry?.sourceVersion);
	}
	function generateSummary(scope: "whole" | "new", sourceVersion?: number) {
		if (!sessionId || !storeTurnId || !summaryEnabled) return;
		summaryOpen = { storeId: storeTurnId, open: true };
		void recap.generate(sessionId, storeTurnId, scope, sourceVersion);
	}
	async function updateSummarySettings(patch: Partial<MessageSurfacingPreferences["recap"]>) {
		summarySaving = true;
		summarySettingsError = "";
		try {
			const status = await rpc("UpdateMessageSurfacing", { recap: patch });
			messageSurfacing.status = status;
		} catch (error) {
			summarySettingsError = error instanceof Error ? error.message : String(error);
		} finally { summarySaving = false; }
	}
	async function citeSummary(ordinal: number) {
		citedOrdinal = ordinal;
		const target = numberedMessages.find((part) => part.surfacingOrdinal === ordinal);
		if (!target) return;
		await reveal({ sessionId, uuid: target.uuid });
	}
	/** Without Jev, hovering a citation marks its step on the activity strip. */
	function hoverCitation(ordinal: number | null) {
		const uuid = numberedMessages.find((part) => part.surfacingOrdinal === ordinal)?.uuid;
		citedStep = uuid ?? null;
	}
	function selectLevel(next: SurfaceLevel) {
		panel.show(next);
		selection = { kind: "latest" };
	}
	function followLatest() { selection = { kind: "latest" }; }
	const replies = $derived(messageReplies(sessionId));
	// Reply toggles: a message already replied to in the draft takes its reference back out.
	function messageReference(pin: Pick<SurfacePin, "label" | "glyph" | "time" | "part" | "builtinCategory">, ordinal: number, excerpt?: string): ReplyReference {
		return { kind: excerpt === undefined ? "message" : "excerpt", ordinal, category: pin.label, builtinCategory: pin.builtinCategory, glyph: pin.glyph, time: pin.time, text: excerpt ?? pin.part.rawText };
	}
	function replyTo(pin: Pick<SurfacePin, "number" | "label" | "glyph" | "time" | "part" | "builtinCategory">, excerpt?: string) {
		if (!sessionId || pin.number === undefined) return;
		const replied = excerpt === undefined ? replies.get(pin.number) : undefined;
		if (replied !== undefined) removeComposerReference(sessionId, replied);
		else insertComposerReference(messageReference(pin, pin.number, excerpt), sessionId);
	}
	function foldMessage() {
		selection = { kind: "folded" };
		void tick().then(() => panelEl?.querySelector<HTMLElement>('[data-testid="surfacing-scrub"]')?.focus({ preventScroll: true }));
	}
	function revealMessage(part: SurfacePart | null) {
		if (part) void reveal({ sessionId, uuid: part.uuid });
	}
	function surfaceCommand(event: KeyboardEvent) {
		const target = event.target;
		if (!event.defaultPrevented && event.key === "Escape" && feedback.pending) { event.preventDefault(); feedback.cancel(); return; }
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (target instanceof HTMLInputElement && target.type !== "checkbox") || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
		const { buffer, command } = surfaceKey(keyBuffer, event.key);
		if (surfacingActive) keyBuffer = buffer;
		if (command?.kind === "fold" && summaryVisible) {
			event.stopPropagation();
			// Native dialog cancel owns the phone sheet's dismissal.
			if (!phone) { event.preventDefault(); closeSummary(); }
			return;
		}
		if (!surfacingActive) {
			if (command?.kind === "collapse") { event.preventDefault(); toggleMinimised(); return; }
			if (command?.kind === "summary" && summaryEnabled) { event.preventDefault(); toggleSummary(); }
			return;
		}
		if (!buffer && !command && !["+", "-", "−"].includes(event.key)) return;
		// Plain session shortcuts bubble to SessionBar; focused-turn keys own them first.
		event.preventDefault();
		const card = cardSlot.kind === "selected" ? cardSlot.card : null;
		if (buffer || onSurfacingShortcut?.(event.key) || feedback.command(event.key, card) || !command) return;
		switch (command.kind) {
			case "step": { const pin = surface[command.to]; if (pin) pick(pin); return; }
			case "number": {
				const target = surface.numbers.find(({ number }) => number === command.n);
				if (target) revealMessage(target.part);
				return;
			}
			case "ask": revealMessage(surface.openAsk); return;
			case "unread": revealMessage(surface.nextUnread?.part ?? null); return;
			case "summary": if (summaryEnabled) toggleSummary(); return;
			case "toggleRead": if (card?.read !== undefined) readMessage(card, !card.read); return;
			case "reply": if (card) replyTo(card); return;
			case "fold": foldMessage(); return;
			case "collapse": toggleMinimised(); return;
			default: assertNever(command);
		}
	}
	function stripJump(id: string) {
		const index = segment.activity.findIndex((part) => part.uuid === id);
		if (index < 0) return;
		const pin = surfacingActive ? surface.pins.find((pin) => pin.part.uuid === id) : undefined;
		if (pin) pick(pin);
		else void jumpTo(index);
	}
	function stripChanged(interaction: StripInteraction) { stripInteraction = interaction; }

	const PREFETCH_REST_MS = 2_000;

	let onScreen = $state(false);
	$effect(() => {
		if (!panelEl) return;
		let live = true;
		const observer = new IntersectionObserver((entries) => {
			if (live) onScreen = entries.at(-1)?.isIntersecting ?? false;
		});
		observer.observe(panelEl);
		return () => {
			live = false;
			observer.disconnect();
		};
	});

	const tools = $derived(segment.activity.flatMap((part) => (part.type === "tool" ? [part] : [])));
	// What the finished tools have to load. A change restarts the rest, so a tool
	// that finishes on screen, or whose cut result arrives, is fetched too.
	const toLoad = $derived(
		tools
			.filter(({ status }) => status === "completed" || status === "error")
			.map((tool) => `${tool.id}:${shownCut(tool)}`)
			.join(),
	);
	$effect(() => {
		if (!onScreen) return;
		void toLoad;
		const resting = setTimeout(() => {
			const projectSlug = getCurrentSlug();
			const sessionId = getCurrentSessionId();
			if (projectSlug && sessionId) toolDetails.wantSoon({ projectSlug, sessionId }, tools);
		}, PREFETCH_REST_MS);
		return () => clearTimeout(resting);
	});

	async function jumpTo(i: number) {
		const part = segment.activity[i];
		if (!part) return;
		await reveal({ sessionId, uuid: part.uuid });
	}
</script>

{#snippet markLabel(pin: SurfacePin)}
	{#if pin.part.surfacingMark}
		{@const mark = pin.part.surfacingMark}
		<span class="max-w-full break-words text-[12px] font-medium" style:color={mark.direction === "raise" ? "var(--color-success)" : mark.direction === "retype" ? "var(--color-accent)" : "var(--color-text-secondary)"} data-testid="surfacing-mark-label">{MARK_GLYPHS[mark.direction ?? "raise"]} you{mark.reason ? ` · ${mark.reason}` : ""}</span>
	{/if}
{/snippet}

{#snippet markHead(pin: SurfacePin)}
	{@render surfacingRegions.cardHead?.(pin)}
	{@render markLabel(pin)}
{/snippet}
{#snippet markFoot(pin: SurfacePin)}
	{@render surfacingRegions.cardFoot?.(pin)}
	<SurfacingMarkActions {pin} {feedback} canSave={!!sessionId} />
{/snippet}
{#snippet askContext(pin: SurfacePin)}
	{@render surfacingRegions.cardContext?.(pin)}
	{#if pin.category === "ask" && !pin.pending}
		<SurfacingAskContext setup={setupFor(pin)} view={surface} start={turn.user?.createdAt ?? 0} ask={asks[pin.part.uuid]}
			enabled={!!sessionId && !!pin.part.partId && summariesOn}
			onexplain={() => { void explainAsk(pin); }} oncite={(part) => { askReturn = { ask: pin, cited: part.uuid }; revealMessage(part); }}
			onReplyToAsk={(text) => { if (pin.number !== undefined) onReplyToAsk?.(messageReference(pin, pin.number), text); }} />
	{:else if askReturn?.cited === pin.part.uuid && surface.openAsk?.uuid === askReturn.ask.part.uuid}
		{@const ask = askReturn.ask}
		<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="mt-[8px] h-[24px] rounded-full px-[9px] text-[12px] font-medium bg-status-ask/18 text-status-ask" data-testid="ask-back" onclick={() => { pick(ask); askReturn = null; }}>↩ Back to ? #{ask.part.surfacingOrdinal}</Button>
	{/if}
{/snippet}
{#snippet markWhy(pin: SurfacePin)}
	{@render surfacingRegions.why?.(pin)}
	<SurfacingMarkWhy {pin} {feedback} categorySet={surfacingConfig.categorySet} />
{/snippet}
{#snippet markBelow(view: ReturnType<typeof surfaceTurn>, cite: (partId: string | null) => void)}
	{@render surfacingRegions.belowStrip?.(view, cite)}
	{#if feedback.toast}
		<div role="status" class="mark-toast" data-testid="surfacing-mark-toast"><span>{feedback.toast.text}</span><Button variant="ghost" size="content" tone="inherit" class="rounded-full px-[10px] h-[24px] max-md:h-[32px] bg-inverse-text/12 font-semibold" data-testid="surfacing-toast-undo" disabled={feedback.saving} onclick={() => feedback.undo()}>Undo</Button></div>
	{/if}
	{#if feedback.error && !feedback.pending}<p role="alert" class="mt-[6px] text-[12px] text-error">{feedback.error}</p>{/if}
	{#if summaryEnabled}{@render summaryPanel(view, (ordinal) => { citedOrdinal = ordinal; cite(view.numbers.find(({ number }) => number === ordinal)?.part.uuid ?? null); })}{/if}
{/snippet}

<!-- Phones open the summary from its own row under the strip; wider screens use the head chip. -->
{#snippet summaryPanel(view: ReturnType<typeof surfaceTurn>, onhover: (ordinal: number | null) => void)}
	<Button variant="ghost" size="content" align="start" tone="default" touchTarget class="md:hidden w-full mt-[10px] mb-[10px] h-[38px] rounded-[11px] bg-bg pl-[12px] pr-[8px] gap-[8px] text-[14px] font-medium" data-testid="surfacing-summary-generate" aria-expanded={summaryVisible} onclick={toggleSummary}>
		<span class="mr-auto">{summaryLabel}</span>{#if recap.versions.length && summaryNew > 0}<span class="text-accent font-mono text-[12px]">{summaryNew} new</span>{/if}<Icon name="chevron-right" size={14} class="text-text-dimmer" />
	</Button>
	<SurfacingSummary versions={recap.versions} selected={recap.current} open={summaryVisible} {phone} {live} {view}
		plainCitations={!surfacingActive}
		start={turn.user?.createdAt ?? segment.activity[0]?.createdAt ?? 0} settings={summarySettings}
		generating={recap.generating} error={recap.error} settingsError={summarySettingsError} saving={summarySaving}
		onclose={closeSummary} onversion={(version) => recap.selected = version} ongenerate={generateSummary} onretry={retrySummary}
		onsettings={updateSummarySettings} oncite={citeSummary} {replies}
		onreply={(ordinal, excerpt) => { const cited = view.numbers.find(({ number }) => number === ordinal); if (cited) replyTo(cited, excerpt); }}
		onquote={(excerpt) => { if (sessionId) insertComposerReference({ kind: "recap-excerpt", text: excerpt }, sessionId); }} {onhover} foot={surfacingActive ? summaryMarkRead : undefined} />
{/snippet}

{#snippet summaryMarkRead(view: ReturnType<typeof surfaceTurn>)}
	{#if view.unreadPartIds.length}<Button variant="ghost" size="content" tone="secondary" touchTarget class="h-[24px] rounded-full bg-chip px-[10px] font-sans text-[12px] font-medium" disabled={readState.kind === "saving"} data-testid="surfacing-mark-read" onclick={() => { void writeRead(view.unreadPartIds, true); }}>✓ Mark {view.unreadPartIds.length} read</Button>{/if}
{/snippet}

<div bind:this={panelEl} data-turn-id={turn.id} data-minimised={minimised} role={surfacingActive || summaryEnabled ? "group" : undefined} aria-label={surfacingActive || summaryEnabled ? "Turn activity" : undefined} onkeydown={surfaceCommand} class="turn-activity max-w-[820px] mx-auto px-[14px] md:px-[32px] mt-[6px] mb-[14px]">
	<AssistantHeader message={segment.reply[0]} {sessionId} {forkMessageId} {model} {providerId} createdAt={segment.reply.length > 0 ? undefined : segment.activity[0]?.createdAt} />
	<div class="md:ml-[42px]">
		<!-- The active turn is a keyboard navigation group; inactive turns add no tab stop. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div role={surfacingActive ? "group" : undefined} tabindex={surfacingActive ? 0 : undefined} aria-label={surfacingActive ? "Turn messages" : undefined} onkeydown={surfacingActive ? surfaceCommand : undefined} data-testid={surfacingActive ? "surfacing-card" : undefined} class="turn-head-card @container rounded-[14px] border border-border bg-turn-bg">
			<div class="px-[12px] pt-[10px] pb-[2px] md:pb-[9px]">
			<div data-testid={live ? "turn-live-head" : undefined} class="flex items-center gap-[6px] min-w-0">
				<Tooltip bind:open={() => hovered >= 0 || headTooltip, (open) => { headTooltip = open; }}>
					{#snippet trigger({ props })}
						{@const headPhrase = phone && (surfacingActive || minimised) ? plural(stats.skills, "skill") : phrase}
						<Button {...props} variant="ghost" size="content" tone="inherit" hoverFill="none" align="start" touchTarget
							class="turn-activity-toggle gap-[6px] text-[13px] min-w-0" data-testid="surfacing-minimise-toggle" ariaLabel={minimised ? "Expand turn" : "Collapse turn"} aria-expanded={!minimised}
							onclick={toggleMinimised}>
							<Icon name={minimised ? "chevron-right" : "chevron-down"} size={14} class="shrink-0 text-text-dimmer" />
							{#if live}<Icon name="loader-circle" size={13} class="animate-spin shrink-0 text-accent" />
							{/if}
							<span class="text-[14px] font-semibold text-text">{live ? runText(runLabel) : "Worked"}</span>
							{#if live && !turn.user}
								<span class="text-[12px] text-text-dimmer" data-testid="turn-live-elapsed">(no prompt to time from)</span>
							{:else if duration !== undefined}
								<span class="turn-duration font-mono text-[12px] text-text-dimmer shrink-0" data-testid={live ? "turn-live-elapsed" : undefined}>{live && duration < 1000 ? "0s" : fmtDuration(duration)}</span>
							{/if}
							{#if headPhrase}<span class="truncate text-[12px] text-text-muted">· {headPhrase}</span>{/if}
						</Button>
					{/snippet}
					<div class="max-w-[340px] flex flex-col gap-[6px] text-[12px]">
						{#if hovered >= 0}<span>{stepCaption(segment, turn, final, hovered, now)}</span>{:else if live}<span>{currentStepLabel(segment)}</span>{/if}
						{#if phrase}<span>{phrase}</span>{/if}
						{#if stats.compactions > 0}<span>Context compacted{stats.compactions > 1 ? ` ×${stats.compactions}` : ""}</span>{/if}
						{#if stats.failed > 0}<span>{stats.failed} failed</span>{/if}
						{#if final}<RunningPill count={running.size} />{/if}
					</div>
				</Tooltip>
				{#if surfacingActive || summaryEnabled}
					<div class="surface-head-chips" data-surfacing-region="head-chips">
						{#if surfacingActive && surface.openAsk}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="shrink-0 h-[24px] rounded-full px-[9px] font-mono text-[12px] font-medium bg-status-ask/18 text-status-ask" data-testid="surfacing-ask-chip" onclick={() => revealMessage(surface.openAsk)}>? #{surface.openAsk.surfacingOrdinal}</Button>{/if}
						{#if surfacingActive && surface.hasReadState}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="shrink-0 h-[24px] rounded-full px-[9px] font-mono text-[12px] font-medium {surface.unreadCount ? 'bg-accent/18 text-accent' : 'bg-chip text-text-secondary'}" data-testid="surfacing-head-unread" onclick={() => revealMessage(surface.nextUnread?.part ?? null)}>{surface.unreadCount ? `${surface.unreadCount} unread` : "All read ✓"}</Button>{/if}
						{#if surfacingActive}{@render surfacingRegions.headChips?.(surface)}{/if}
						{#if summaryEnabled}<Button variant="ghost" size="content" tone="default" hoverFill="none" touchTarget class="{minimised && surfacingActive ? '' : 'max-md:hidden'} shrink-0 h-[24px] rounded-full px-[9px] text-[13px] leading-[normal] font-medium bg-chip" data-testid="surfacing-summary-generate" aria-expanded={summaryVisible} onclick={toggleSummary}>{#if minimised && surfacingActive}<span class="max-md:sr-only">{summaryLabel}</span><span class="md:hidden" aria-hidden="true">✦</span>{:else}{summaryLabel}{/if}{#if recap.versions.length && summaryNew > 0}<span class="text-accent {minimised && surfacingActive ? 'max-md:hidden' : ''}">· {summaryNew} new</span>{/if}</Button>{/if}
					</div>
				{/if}
					{#if onsummarize}<span class="hidden md:contents"><Button variant="accent-soft" size="content" touchTarget class="rounded-full px-[10px] py-[4px] text-[12px] shrink-0" onclick={onsummarize}>✦ Summary</Button></span>{/if}
			</div>
			{#if minimised && surfacingActive}
				<MinimisedTurn>
					{#snippet strip(preview: Snippet<[SurfacePin]>)}<ActivityStrip bind:width={stripWidth} {turn} {segment} {final} {now} {running} {phone} {cardSlot} markers={{ kind: "dots", dots: surface.messages }} openAsk={surface.openAsk} {preview} onpick={pick} oninteraction={stripChanged} />{/snippet}
				</MinimisedTurn>
			{:else if surfacingActive}
				<SurfacingCard view={surface} card={cardSlot.kind === "selected" ? cardSlot.card : null} {counts} {live} pending={panel.pending} onland={acknowledgeMessage} scrubbing={stripInteraction.scrubbing} regions={{ ...surfacingRegions, cardHead: markHead, cardContext: askContext, cardFoot: markFoot, why: markWhy, belowStrip: markBelow }}
					{readState} bind:cardEl={readCardEl} onread={readMessage}
					markReadInAxis={!summaryEnabled} onmarkread={() => { void writeRead(surface.unreadPartIds, true); }}
					onreply={replyTo} replied={cardSlot.kind === "selected" && cardSlot.card.number !== undefined && replies.has(cardSlot.card.number)}
					onpick={pick} onlevel={selectLevel}
					onfold={foldMessage} onfollow={followLatest} oncommand={surfaceCommand}>
					{#snippet strip(cited: string | null, card: Snippet)}
						<ActivityStrip bind:width={stripWidth} {turn} {segment} {final} {now} {running} {phone} {cited} {card} {cardSlot} markers={{ kind: "pins", pins: surface.pins, selected: cardSlot.kind === "selected" ? cardSlot.card.part.uuid : null }} openAsk={surface.openAsk} belowLevel={surface.belowLevel} sliderText={surface.sliderText} oninteraction={stripChanged} onpick={pick} onjump={stripJump} oncommand={surfaceCommand} />
					{/snippet}
				</SurfacingCard>
			{:else}
			<!-- The phone strip is a 44px tap target with its 4px bar centred; a summary row
			     under it overlaps that empty area so it sits midway between bar and card edge. -->
			<div class="md:mt-[7px] {summaryEnabled ? 'max-md:-mb-[18px]' : ''}">
				<ActivityStrip bind:width={stripWidth} {turn} {segment} {final} {now} {running} active={citedStep} oninteraction={stripChanged} onjump={stripJump} />
			</div>
			{#if summaryEnabled}{@render summaryPanel(surface, hoverCitation)}{/if}
			{/if}
			{#if onsummarize && !minimised}
				<Button variant="ghost" size="content" tone="default" align="start" touchTarget class="md:hidden w-full -mt-[8px] mb-[10px] h-[38px] rounded-[11px] bg-bg pl-[12px] pr-[8px] gap-[8px] text-[14px] font-medium" onclick={onsummarize}>
					<span>✦ Summary</span><Icon name="chevron-right" size={14} class="ml-auto text-text-dimmer" />
				</Button>
			{/if}
		</div>
		<TurnLog class="step-log border-t border-border bg-bg px-[12px] py-[6px]" mode={minimised ? "collapsed" : fullLog ? "shown" : "hidden"} phase={panel.phase} pending={panel.pending} stepCount={counts.log} entries={logEntries}>
			{#snippet row(entry: TurnLogEntry)}
				{@const i = entry.index}
				{#if entry.kind === "resumed"}
					{@render renderResume?.(entry.resume)}
				{:else}
				{@const part = entry.part}
				{@const latestLiveStep = live && i === segment.activity.length - 1}
				{@const category = surfacingActive && part.type === "assistant" ? surface.messages.find((message) => message.part.uuid === part.uuid) : undefined}
				<div class="focus:bg-selection focus:outline-none" data-log-part={part.uuid} use:landTurnTarget={{ pending: panel.pending, target: { kind: "step", id: part.uuid }, ack: panel.ack, beforeScroll: onjump }} tabindex="-1" data-testid={part.type === "tool" && (part.status === "running" || part.status === "pending" || (latestLiveStep && part.result === undefined && part.status !== "error" && !part.isError)) ? "turn-running" : undefined}>
					<ActivityRow {part} {liveTasks} {taskListedAt} runningTasks={running} live={latestLiveStep} duration={durations?.[i]} messageNumber={part.type === "assistant" ? messageNumber(i) : undefined} messageCategory={category} onmessage={category && canOpenSurfaceMessage(category.part, live) ? () => pick(category) : undefined} />
				</div>
				{/if}
			{/snippet}
			{#snippet footer()}
				<div class="flex flex-wrap items-center gap-[10px] py-[8px] text-[12px] text-text-muted">
					{#if stats.compactions > 0}<span class="compaction-marker">compacted{stats.compactions > 1 ? ` ×${stats.compactions}` : ""}</span>{/if}
					{#if stats.failed > 0}<span class="text-error">{stats.failed} failed</span>{/if}
					{#if final}<RunningPill count={running.size} /><TurnEconomics economics={bill} />{/if}
				</div>
			{/snippet}
		</TurnLog>
		{#if !minimised}<TurnShowBar {panel} {counts} onlevelchange={followLatest} />{/if}
		</div>
	</div>
</div>

<style>
	.surface-head-chips { display:contents; }
	.turn-activity[data-minimised="true"] .turn-duration { min-width:0; flex-shrink:1; overflow:hidden; text-overflow:ellipsis; }
	.mark-toast { display:flex; align-items:center; gap:10px; width:fit-content; max-width:100%; min-height:34px; margin:10px auto 2px; padding:4px 5px 4px 14px; border-radius:999px; background:var(--color-inverse-bg); color:var(--color-inverse-text); font-size:13px; box-shadow:0 8px 24px rgb(0 0 0 / .22); }
</style>
