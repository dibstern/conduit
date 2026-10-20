<!-- Single session entry in the sidebar list. Shows title, context, status/time, -->
<!-- the three-dot menu, and supports inline rename. -->

<script module lang="ts">
	import type { SessionAttention } from "../../types.js";

	type Density = "comfortable" | "dense";

	// One word per actionable tier; idle keeps only a quiet glyph and says
	// nothing, so a quiet list stays quiet. The word on screen is what the row
	// wants from you; the spoken form
	// is a state, because a screen reader reads a link's label as a description
	// of the row rather than as a button.
	export const ATTENTION_DISPLAY: Record<
		SessionAttention,
		{
			word: string;
			spoken: string;
			colour: string;
			/** Blocking states get a line icon; the rest share the dither grid. */
			glyph: { icon: "triangle-alert" | "message-square" | "octagon-alert" } | { dither: "working" | "monitoring" | "done" | "idle" };
		}
	> = {
		"needs-approval": {
			word: "Approve",
			spoken: "Needs approval",
			colour: "text-status-ask",
			glyph: { icon: "triangle-alert" },
		},
		"needs-reply": {
			word: "Reply",
			spoken: "Needs reply",
			colour: "text-status-ask",
			glyph: { icon: "message-square" },
		},
		error: {
			word: "Failed",
			spoken: "Failed",
			colour: "text-error",
			glyph: { icon: "octagon-alert" },
		},
		working: {
			// The spinner already says working,
			// and the right column shows elapsed time instead, which is the only
			// thing that changes while a turn runs. `word` is therefore the
			// pill's text and its presence is what decides pill-vs-time.
			word: "",
			spoken: "Working",
			colour: "text-session-working",
			glyph: { dither: "working" },
		},
		monitoring: {
			// A word, not elapsed time, because the wait has no expected end.
			word: "Monitoring",
			spoken: "Monitoring",
			colour: "text-session-monitoring",
			glyph: { dither: "monitoring" },
		},
		"done-unread": {
			word: "",
			spoken: "Done, unread",
			colour: "text-session-done",
			glyph: { dither: "done" },
		},
		idle: {
			word: "",
			spoken: "",
			colour: "text-session-idle",
			glyph: { dither: "idle" },
		},
	};

</script>

<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { sessionAttention } from "../../stores/session.svelte.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Icon from "../ui/Icon.svelte";
	import SessionRow from "../ui/SessionRow.svelte";
	import SessionStatusGlyph from "../ui/SessionStatusGlyph.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import SessionRenameInput from "./SessionRenameInput.svelte";
	import ProjectMark from "../ui/ProjectMark.svelte";
	import { isSessionWoken } from "../../stores/session.svelte.js";
	import { getWokenSessionText } from "../../utils/session-lifecycle.js";
	import { getSessionActionState, getSwipeStage, LONG_PRESS_DELAY_MS, MOVEMENT_SLOP_PX } from "../../utils/swipe.js";
	import { onDestroy } from "svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";

	let {
		session,
		projectLabel,
		projectAccent = 1,
		href = "",
		active = false,
		renaming: isRenaming = false,
		selectMode = false,
		selected = false,
		density = "comfortable",
		settled = false,
		snoozed = false,
		branch,
		settledAt,
		snoozedUntilText,
		now = Date.now(),
		pinned = false,
		onswitchsession,
		ontoggleselection,
		oncontextmenu: oncontextmenuProp,
		onsettle,
		onmarkread,
		onpin,
		onsnooze,
		onunsnooze,
		oncommitsnooze,
		heldSessionId,
		onholdchange,
		menuOpen = false,
		onrenamestart,
		onrenameend,
	}: {
		session: SessionInfo;
		// `| undefined` because the list passes it unconditionally before the
		// attached project's slug is available.
		projectLabel?: string | undefined;
		projectAccent?: number;
		href?: string;
		active?: boolean;
		renaming?: boolean;
		selectMode?: boolean;
		selected?: boolean;
		density?: Density;
		settled?: boolean;
		snoozed?: boolean;
		branch?: string | undefined;
		settledAt?: string | undefined;
		snoozedUntilText?: string | undefined;
		now?: number;
		pinned?: boolean;
		onswitchsession?: (id: string) => void;
		ontoggleselection?: (id: string) => void;
		oncontextmenu?: (session: SessionInfo, anchor: HTMLElement, trigger?: "touch") => void;
		onsettle?: (id: string, next: boolean) => void;
		onmarkread?: (id: string) => void;
		onpin?: (id: string, next: boolean) => void;
		onsnooze?: (id: string) => void;
		onunsnooze?: (id: string) => void;
		oncommitsnooze?: (id: string) => void;
		heldSessionId?: string | null;
		onholdchange?: (id: string | null) => void;
		/** This row's action menu is open: keep its anchor and commands on screen. */
		menuOpen?: boolean;
		/**
		 * Asks the list to put this row in rename mode. The list owns that state
		 * because a row is rebuilt when its session changes status group, and a
		 * rename held here would end mid-typing.
		 */
		onrenamestart?: () => void;
		onrenameend?: () => void;
	} = $props();

	const CLICK_SUPPRESSION_MS = 450;
	const NATIVE_CONTEXT_MENU_SUPPRESSION_MS = 1_000;

	let moreBtnEl: HTMLButtonElement | HTMLAnchorElement | undefined =
		$state(undefined);
	let rowEl: HTMLAnchorElement | undefined = $state();
	let offset = $state(0);
	let dragging = $state(false);
	let heldDirection = $state<"settle" | "snooze" | null>(null);
	let activePointer: number | null = null;
	let startX = 0;
	let startY = 0;
	let gesture: "pending" | "horizontal" | "scroll" = "pending";
	let longPressTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressClick = false;
	let suppressTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressNativeContextMenu = false;
	// The sheet opens under a finger that is still down. Its release would
	// otherwise reach the sheet as mousedown and click at the lift point,
	// focusing or running whichever item is now under it.
	let consumeTouchEnd = false;

	const displayTitle = $derived(session.title || "New Session");
	// A title that changes while the row is on screen (auto-name or rename)
	// plays the gleam once. The row's first render must not, or every row would
	// shine on page load, so the previous title is tracked outside state.
	let renderedTitle: string | undefined;
	let gleamingTitle = $state<string>();
	$effect(() => {
		if (renderedTitle !== undefined && displayTitle !== renderedTitle) gleamingTitle = displayTitle;
		renderedTitle = displayTitle;
	});
	const gleaming = $derived(gleamingTitle === displayTitle);
	// How far a clipped title has to travel for its end to show, measured when
	// the pointer enters because that is when the hover marquee starts.
	let titleEl = $state<HTMLElement>();
	let marqueeShift = $state(0);
	const actions = $derived(getSessionActionState(session, now));
	const swipeStage = $derived.by(() => {
		const stage = getSwipeStage(offset, rowEl?.getBoundingClientRect().width ?? 0);
		return offset > 0 && actions.settleDisabledReason && stage === "commit" ? "reveal" : stage;
	});
	const swipeDirection = $derived(offset > 0 ? "settle" : "snooze");
	const swipeAllowed = $derived(canSwipe(swipeDirection));
	const canMarkRead = $derived(!settled && !actions.settled && !snoozed && !actions.snoozed && onmarkread != null);
	const shelfRow = $derived(settled || snoozed);
	const timeText = $derived((snoozedUntilText ?? settledAt ?? formatTimeAgo(session.updatedAt, new Date(now)))
		.replace(/ ago$/, "").replace("Yesterday", "1d").replace("just now", "now"));
	const woken = $derived(isSessionWoken(session, now) && !snoozed);
	const wokeReason = $derived(session.wokenAt != null ? (session.wokeBecause ?? "time") : "time");
	const wokeText = $derived(getWokenSessionText(session));
	const wokeColour = $derived(
		wokeReason === "approval" ? "bg-warning/10 text-warning" :
		wokeReason === "question" ? "bg-status-ask/10 text-status-ask" :
		wokeReason === "error" ? "bg-error/10 text-error" :
		wokeReason === "turn" ? "bg-success/10 text-success" : "bg-accent-bg text-accent",
	);
	const contextText = $derived(
		[projectLabel, branch].filter((part) => part).join(" \u00B7 "),
	);

	// The server derives the tier in one place and the row only reads it. It is
	// deliberately not re-derived from `processing`, the local phase or the
	// pending counts: a second derivation could disagree with the section this
	// row is filed under, and two answers on one screen is worse than either.
	const attention = $derived(sessionAttention(session));
	const status = $derived(ATTENTION_DISPLAY[attention]);
	const titleClass = $derived(attention === "idle" || shelfRow
		? "font-normal text-text-secondary"
		: "font-medium text-text");
	const picked = $derived(selectMode && selected);
	const selectionControlClass = $derived.by(() => {
		if (active) return selected ? "text-accent" : "text-text-muted";
		return selected ? "text-accent" : "text-text-muted";
	});

	// Status first, per the design reference. A screen reader user scanning the
	// list hears what a row wants before its title. This overrides the row's own
	// text as the accessible name, which is why title, project and time are
	// repeated here.
	const ariaLabel = $derived(
		[
			settled ? "Settled" : snoozed ? "Snoozed" : status.spoken,
			pinned ? "Pinned" : "",
			displayTitle,
			contextText,
			timeText,
			woken ? wokeText : "",
		]
			.filter((part) => part)
			.join(", "),
	);

	function handleClick(e: MouseEvent) {
		if (e.defaultPrevented) return;
		if (heldDirection) { e.preventDefault(); e.stopPropagation(); closeHold(); return; }
		if (!onswitchsession) return;
		e.preventDefault();
		if (!isRenaming) onswitchsession(session.id);
	}

	function suppressGestureClick(e: MouseEvent) {
		if (!suppressClick && !heldDirection) return;
		e.preventDefault();
		e.stopPropagation();
		// The click trailing the gesture that opened a hold must not close it.
		if (suppressClick) suppressClick = false;
		else closeHold();
	}

	function armClickSuppression() {
		suppressClick = true;
		if (suppressTimer) clearTimeout(suppressTimer);
		suppressTimer = setTimeout(
			() => { suppressClick = false; },
			CLICK_SUPPRESSION_MS,
		);
	}

	function closeHold(notify = true) {
		heldDirection = null;
		offset = 0;
		if (notify) onholdchange?.(null);
	}

	$effect(() => {
		if (heldSessionId !== undefined && heldSessionId !== session.id && heldDirection) closeHold(false);
	});

	// Registered only while a tray is held, so idle rows add no document
	// listeners. A tap outside closes the tray and does nothing else.
	$effect(() => {
		const area = rowEl?.parentElement;
		if (!heldDirection || !area) return;
		return dismiss(area, { onDismiss: () => closeHold(), consumeClick: true }).destroy;
	});

	function clearLongPress() {
		if (longPressTimer) clearTimeout(longPressTimer);
		longPressTimer = undefined;
	}

	function canSwipe(direction: "settle" | "snooze") {
		return direction === "settle"
			? actions.settleDisabledReason == null || canMarkRead
			: actions.snoozeVisible && (actions.snoozed || actions.snoozeDisabledReason == null);
	}

	function stopPointer() {
		window.removeEventListener("pointermove", movePointer);
		window.removeEventListener("pointerup", finishPointer);
		window.removeEventListener("pointercancel", cancelPointer);
		clearLongPress();
		activePointer = null;
		dragging = false;
	}

	function startPointer(event: PointerEvent) {
		if (event.pointerType !== "touch" || selectMode || isRenaming || !oncontextmenuProp || (event.target as Element).closest("button")) return;
		if (activePointer !== null) return;
		if (heldDirection) { closeHold(); armClickSuppression(); return; }
		activePointer = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		gesture = "pending";
		longPressTimer = setTimeout(() => {
			if (activePointer === null || gesture !== "pending") return;
			suppressNativeContextMenu = true;
			setTimeout(
				() => { suppressNativeContextMenu = false; },
				NATIVE_CONTEXT_MENU_SUPPRESSION_MS,
			);
			openFromLongPress();
		}, LONG_PRESS_DELAY_MS);
		window.addEventListener("pointermove", movePointer);
		window.addEventListener("pointerup", finishPointer);
		window.addEventListener("pointercancel", cancelPointer);
	}

	function openFromLongPress() {
		consumeTouchEnd = true;
		if (rowEl) oncontextmenuProp?.(session, rowEl, "touch");
		stopPointer();
	}

	function movePointer(event: PointerEvent) {
		if (event.pointerId !== activePointer) return;
		const dx = event.clientX - startX;
		const dy = event.clientY - startY;
		if (gesture === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) > MOVEMENT_SLOP_PX) {
			clearLongPress();
			gesture = Math.abs(dy) > Math.abs(dx) ? "scroll" : "horizontal";
		}
		if (gesture === "scroll") { stopPointer(); return; }
		if (gesture !== "horizontal") return;
		dragging = true;
		const allowed = canSwipe(dx > 0 ? "settle" : "snooze");
		offset = allowed ? dx : Math.sign(dx) * Math.min(Math.abs(dx) * 0.2, 24);
	}

	function finishPointer(event: PointerEvent) {
		if (event.pointerId !== activePointer) return;
		const wasHorizontal = gesture === "horizontal";
		const direction = offset > 0 ? "settle" : "snooze";
		const stage = canSwipe(direction) ? swipeStage : "none";
		stopPointer();
		if (!wasHorizontal) return;
		armClickSuppression();
		if (stage === "commit") {
			runSwipeAction(direction, true);
			offset = 0;
		} else if (stage === "reveal") {
			heldDirection = direction;
			offset = direction === "settle" ? (canMarkRead ? (actions.settleDisabledReason ? 74 : 148) : 88) : -88;
			onholdchange?.(session.id);
		} else offset = 0;
	}

	function cancelPointer(event: PointerEvent) {
		if (event.pointerId !== activePointer) return;
		stopPointer();
		offset = 0;
	}

	function runSwipeAction(direction: "settle" | "snooze", commit: boolean) {
		if (direction === "settle") {
			if (!actions.settleDisabledReason) onsettle?.(session.id, !(settled || actions.settled));
		} else if (snoozed || actions.snoozed) onunsnooze?.(session.id);
		else if (actions.snoozeVisible && !actions.snoozeDisabledReason) {
			if (commit) oncommitsnooze?.(session.id);
			else onsnooze?.(session.id);
		}
		closeHold();
	}

	onDestroy(() => { stopPointer(); if (suppressTimer) clearTimeout(suppressTimer); });

	function handleMoreClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (moreBtnEl) {
			oncontextmenuProp?.(session, moreBtnEl);
		}
	}

	function handleSelectionToggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		ontoggleselection?.(session.id);
	}

	function handleDblClick(e: MouseEvent) {
		if (selectMode || !onrenamestart) return;
		e.preventDefault();
		e.stopPropagation();
		onrenamestart();
	}

	function swipeVerb(direction: "settle" | "snooze"): string {
		if (direction === "settle") return settled || actions.settled ? "Un-settle" : "Settle";
		return snoozed || actions.snoozed ? "Unsnooze" : "Snooze";
	}

	function swipeToneClass(direction: "settle" | "snooze", stage: string): string {
		if (stage === "commit") return direction === "settle" ? "bg-success text-bg" : "bg-status-snoozed text-bg";
		return direction === "settle" ? "bg-success/15 text-success" : "bg-status-snoozed/15 text-status-snoozed";
	}

	function swipeIcon(verb: string): "check" | "moon" | "undo" {
		if (verb === "Settle") return "check";
		if (verb === "Snooze") return "moon";
		return "undo";
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="@container relative overflow-hidden rounded-panel session-swipe-wrapper">
	{#if (dragging && swipeStage !== "none" && swipeAllowed) || heldDirection}
		{@const direction = heldDirection ?? swipeDirection}
		{@const verb = swipeVerb(direction)}
		{@const stage = heldDirection ? "reveal" : swipeStage}
		{#if direction === "settle" && stage === "reveal" && canMarkRead}
			<div class="absolute inset-0 flex items-stretch font-sans text-xs font-semibold">
				{#if !actions.settleDisabledReason}
					<Button
						variant="ghost"
						size="content"
						layout="flow"
						tone="inherit"
						hoverFill="none"
						data-testid="session-swipe-settle"
						data-stage={stage}
						ariaLabel="Settle {displayTitle}"
						class="flex w-[74px] shrink-0 flex-col items-center justify-center gap-1 bg-success/15 text-success"
						onclick={(event) => { event.preventDefault(); event.stopPropagation(); if (heldDirection) runSwipeAction("settle", false); }}
					>
						<Icon name="check" size={16} />
						Settle
					</Button>
				{/if}
				<Button
					variant="ghost"
					size="content"
					layout="flow"
					tone="inherit"
					hoverFill="none"
					data-testid={session.unread ? "session-swipe-mark-read" : "session-swipe-mark-unread"}
					ariaLabel="Mark {session.unread ? 'read' : 'unread'} {displayTitle}"
					class="flex w-[74px] shrink-0 flex-col items-center justify-center gap-1 bg-accent/15 text-accent"
					onclick={(event) => { event.preventDefault(); event.stopPropagation(); if (heldDirection) { onmarkread?.(session.id); closeHold(); } }}
				>
					<Icon name={session.unread ? "circle" : "circle-dot"} size={16} />
					{session.unread ? "Read" : "Unread"}
				</Button>
			</div>
		{:else}
		<Button
			variant="ghost"
			size="content"
			layout="flow"
			tone="inherit"
			hoverFill="none"
			data-testid="session-swipe-action"
			data-stage={stage}
			ariaLabel="{verb} {displayTitle}"
			class="absolute inset-0 {direction === 'settle' ? 'justify-start' : 'justify-end'} flex items-center gap-1 px-3 font-sans text-sm font-medium {swipeToneClass(direction, stage)}"
			onclick={(event) => { event.preventDefault(); event.stopPropagation(); if (heldDirection) runSwipeAction(heldDirection, false); }}
		>
			<Icon name={swipeIcon(verb)} size={16} />
			{stage === "commit" ? `Release to ${verb.toLowerCase()}` : verb}
		</Button>
		{/if}
	{/if}
<SessionRow
	bind:element={rowEl}
	href={href || undefined}
	{active}
	selected={picked}
	{selectMode}
	{density}
	{dragging}
	{offset}
	data-session-id={session.id}
	aria-label={ariaLabel}
	onclick={handleClick}
	onclickcapture={suppressGestureClick}
	onpointerdown={startPointer}
	onpointerenter={() => { marqueeShift = titleEl ? titleEl.scrollWidth - titleEl.clientWidth : 0; }}
	oncontextmenu={(event) => {
		if (selectMode || !oncontextmenuProp) return;
		event.preventDefault();
		if (suppressNativeContextMenu) { suppressNativeContextMenu = false; return; }
		if (activePointer !== null) { openFromLongPress(); return; }
		oncontextmenuProp(session, event.currentTarget);
	}}
	ontouchend={(event) => {
		if (consumeTouchEnd) event.preventDefault();
		consumeTouchEnd = false;
	}}
	ontouchcancel={() => { consumeTouchEnd = false; }}
>
	<!-- Selection circle (select mode) -->
	{#if selectMode}
		<!--
			No `tone`/`hoverFill` member fits: the colour is a four-way expression on
			two booleans and there is no hover change at all, so both axes emit
			nothing and the expression below owns the group uncontested.

			`role="checkbox"` rather than `aria-pressed`: this is one row's membership
			in a multi-select, which is what a checkbox means, and the circle/
			circle-check glyph is already drawing a checkbox. The name carries the
			title because a screen reader hears this control twenty times in a list
			and "Select session" twenty times over identifies nothing.
		-->
		<Button
			variant="ghost"
			size="content"
			tone="inherit"
			hoverFill="none"
			role="checkbox"
			aria-checked={selected}
			ariaLabel="Select {displayTitle}"
			class="col-start-1 row-start-1 {contextText ? 'row-span-2' : ''} self-stretch shrink-0 w-[44px] min-h-[44px] md:min-h-0 rounded duration-100 {selectionControlClass}"
			onclick={handleSelectionToggle}
		>
			<Icon name={selected ? "circle-check" : "circle"} size={18} />
		</Button>
	{:else}
		<span class="col-start-1 row-start-1 self-center">
			<SessionStatusGlyph {attention} {settled} {snoozed} />
		</span>
	{/if}

	<!-- Title line -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		class="session-item-title col-start-2 row-start-1 flex items-center gap-1.5 overflow-hidden font-sans {titleClass}"
		ondblclick={handleDblClick}
	>
		{#if isRenaming}
			<SessionRenameInput
				{session}
				variant="row"
				class="min-h-[44px] md:min-h-0"
				onend={() => onrenameend?.()}
			/>
		{:else}
			<!-- Keyed so a second rename mid-gleam restarts it on a fresh element.
			     The outer span clips; the inner one is what the hover marquee
			     moves, so the clip stays put and reveals the title's end. The
			     marquee waits for the gleam: both are `animation`, so hovering
			     would cut the gleam short and replay it on leave. -->
			{#key displayTitle}
				{@const marquee = !gleaming && marqueeShift > 0}
				<span
					bind:this={titleEl}
					class="session-title-inner inline-block overflow-hidden text-ellipsis whitespace-nowrap min-w-0 {gleaming ? 'session-title-gleam motion-reduce:animate-none' : ''} {marquee ? 'group-hover:text-clip' : ''}"
					onanimationend={() => { gleamingTitle = undefined; }}
					><span
						class={marquee ? "group-hover:inline-block group-hover:session-title-marquee" : undefined}
						style:--marquee-shift={marquee ? `${-marqueeShift}px` : undefined}
						style:--marquee-dur={marquee ? `${Math.max(2, marqueeShift / 38)}s` : undefined}
						>{displayTitle}</span
					></span
				>
			{/key}
		{/if}
		{#if session.archivedAt != null}
			<Badge data-testid="session-archived-badge" class="leading-none">Archived</Badge>
		{/if}
		{#if pinned}
			<span class="shrink-0 text-status-pinned" title="Pinned session">
				<Icon name="pin" size={11} />
			</span>
		{/if}

	</span>

	{#if contextText}
		<span
			class="session-item-context col-start-2 col-span-2 row-start-2 flex items-center gap-[5px] text-[12.5px] md:text-[11.5px] leading-[17px] text-text-dimmer overflow-hidden whitespace-nowrap font-sans"
		>
			{#if projectLabel}<ProjectMark accent={projectAccent} />{/if}
			<span class="shrink-0">{projectLabel}</span>
			{#if branch}<code class="min-w-0 truncate font-mono text-[11px]">{branch}</code>{/if}
		</span>
	{/if}

	<!-- Kept while renaming: the status tells you the session is still working
	     while you type. Shelf rows only show a time here, so they give the
	     space to the field, as they do with the project label. -->
	{#if !shelfRow || !isRenaming}

		<div
			class="col-start-3 row-start-1 flex items-center gap-[5px] shrink-0 text-[11px] text-text-dimmer tabular-nums whitespace-nowrap font-mono"
		>
			<!-- Status word. Hidden from the accessible name because aria-label above
			     already leads with it; announcing it twice per row is noise. -->
			{#if status.word && !shelfRow}
				<span class="{isRenaming ? '' : 'md:group-hover:hidden md:group-focus-within:hidden'} {menuOpen && !isRenaming ? 'md:hidden' : ''}" aria-hidden="true">
					{#if attention === "needs-approval" || attention === "needs-reply"}
						<Badge variant="ask" size="status" shape="pill" class="session-item-status font-sans">{status.word}</Badge>
					{:else}
						<span class="session-item-status font-sans {status.colour}">{status.word}</span>
					{/if}
				</span>
			{:else}
				<span class="session-item-meta {isRenaming ? '' : 'md:group-hover:hidden md:group-focus-within:hidden'} {menuOpen && !isRenaming ? 'md:hidden' : ''}" title={settled && session.settledAutomatically ? "Settled automatically" : undefined}>{settled && session.settledAutomatically ? `Auto · ${timeText}` : timeText}</span>
			{/if}
			{#if woken}
				<span
					data-testid="session-woke-pill"
					class="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 font-sans text-xs font-medium {wokeColour}"
				>{wokeText}</span>
			{/if}

			<!-- Desktop commands replace the time on hover and keyboard focus. -->
			{#if !selectMode && oncontextmenuProp && !isRenaming}
				<span class="hidden md:group-hover:inline-flex md:group-focus-within:inline-flex {menuOpen ? 'md:inline-flex' : ''} items-center" data-testid="session-row-actions">
					<!-- Below 210px only the ellipsis stays, and its menu carries every one of these commands. -->
					<span class="contents @max-[210px]:hidden">
						<Button variant="ghost" size="row-action" tone="secondary" hoverFill="sidebar"
							data-testid={settled || actions.settled ? "session-act-unsettle" : "session-act-settle"}
							ariaLabel="{settled || actions.settled ? 'Un-settle' : 'Settle'} {displayTitle}"
							title={actions.settleDisabledReason ?? (settled || actions.settled ? "Un-settle (s)" : "Settle (s)")}
							disabled={actions.settleDisabledReason != null}
							onclick={(event) => { event.preventDefault(); event.stopPropagation(); onsettle?.(session.id, !(settled || actions.settled)); }}
						><Icon name={settled || actions.settled ? "undo" : "check"} size={13} /></Button>
						{#if actions.snoozeVisible}
							{#if snoozed || actions.snoozed}
								<Button variant="ghost" size="row-action" tone="secondary" hoverFill="sidebar"
									data-testid="session-act-unsnooze" ariaLabel="Unsnooze {displayTitle}" title="Unsnooze (z)"
									onclick={(event) => { event.preventDefault(); event.stopPropagation(); onunsnooze?.(session.id); }}
								><Icon name="undo" size={13} /></Button>
							{:else}
								<Button variant="ghost" size="row-action" tone="secondary" hoverFill="sidebar"
									data-testid="session-act-snooze" ariaLabel="Snooze {displayTitle}"
									title={actions.snoozeDisabledReason ?? "Snooze (z)"} disabled={actions.snoozeDisabledReason != null}
									onclick={(event) => { event.preventDefault(); event.stopPropagation(); onsnooze?.(session.id); }}
								><Icon name="moon" size={13} /></Button>
							{/if}
						{/if}
						<Button variant="ghost" size="row-action" tone="secondary" hoverFill="sidebar"
							data-testid={actions.pinned ? "session-act-unpin" : "session-act-pin"}
							ariaLabel="{actions.pinned ? 'Unpin' : 'Pin'} {displayTitle}" title={actions.pinned ? "Unpin (p)" : "Pin (p)"}
							onclick={(event) => { event.preventDefault(); event.stopPropagation(); onpin?.(session.id, !actions.pinned); }}
						><Icon name={actions.pinned ? "pin-off" : "pin"} size={13} /></Button>
					</span>
					<Button
						bind:element={moreBtnEl}
						variant="ghost"
						size="row-action"
						tone="secondary"
						hoverFill="sidebar"
						class="session-more-btn shrink-0"
						title="More options"
						ariaLabel="More options for {displayTitle}"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onclick={handleMoreClick}
					>
						<Icon name="ellipsis" size={13} />
					</Button>
				</span>
			{/if}
		</div>
	{/if}
</SessionRow>
{#if gleaming}
	<div class="session-row-sheen motion-reduce:hidden" aria-hidden="true"></div>
{/if}
</div>
