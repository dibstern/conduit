<!-- ─── SessionItem ─────────────────────────────────────────────────────────── -->
<!-- Single session entry in the sidebar list. Shows title, context, status/time, -->
<!-- the three-dot menu, and supports inline rename. -->

<script module lang="ts">
	import type { SessionAttention } from "../../types.js";

	type AttentionEmphasis = "strong" | "normal" | "dim";
	type Density = "comfortable" | "dense";

	// One word per tier, and nothing at all for idle, so a quiet list looks
	// quiet. The word on screen is what the row wants from you; the spoken form
	// is a state, because a screen reader reads a link's label as a description
	// of the row rather than as a button.
	const ATTENTION_DISPLAY: Record<
		SessionAttention,
		{
			word: string;
			spoken: string;
			colour: string;
			icon:
				| "triangle-alert"
				| "message-square"
				| "octagon-alert"
				| "loader-circle"
				| "check"
				| null;
			emphasis: AttentionEmphasis;
		}
	> = {
		"needs-approval": {
			word: "Approve",
			spoken: "Needs approval",
			colour: "text-warning",
			icon: "triangle-alert",
			emphasis: "strong",
		},
		"needs-reply": {
			word: "Reply",
			spoken: "Needs reply",
			colour: "text-brand-b",
			icon: "message-square",
			emphasis: "strong",
		},
		error: {
			word: "Failed",
			spoken: "Failed",
			colour: "text-error",
			icon: "octagon-alert",
			emphasis: "strong",
		},
		working: {
			// No word on purpose: the spinner on the left already says working,
			// and the right column shows elapsed time instead, which is the only
			// thing that changes while a turn runs. `word` is therefore the
			// pill's text and its presence is what decides pill-vs-time.
			word: "",
			spoken: "Working",
			colour: "text-accent",
			icon: "loader-circle",
			emphasis: "normal",
		},
		"done-unread": {
			word: "Done",
			spoken: "Done, unread",
			colour: "text-success",
			icon: "check",
			emphasis: "strong",
		},
		idle: {
			word: "",
			spoken: "",
			colour: "",
			icon: null,
			emphasis: "dim",
		},
	};

	const EMPHASIS_CLASSES: Record<
		AttentionEmphasis,
		{ title: string; row: string }
	> = {
		strong: { title: "text-text font-semibold", row: "" },
		normal: { title: "text-text-secondary font-normal", row: "" },
		dim: {
			title: "text-text-secondary font-normal",
			row: "opacity-[0.62]",
		},
	};

	// 52px is the touch row, dropping to 46px at `md` because a pointer is more
	// precise than a thumb. It is the width breakpoint rather than
	// `(pointer: fine)` on purpose: the visual suite's mobile leg is a 393px
	// viewport with no touch emulation, so a pointer query would resolve `fine`
	// on both legs and the 52px row would never be captured. Width is also what
	// the rest of the app already means by "phone".
	const DENSITY_CLASSES: Record<Density, { row: string; settled: string }> = {
		// Every number here is the height the row actually renders, not a floor
		// it never reaches: the padding is tuned so the two-line content clears
		// it and the declared min-height is what wins. Watch the rem scaling --
		// the app's root font-size is 12px, so `py-1.5` is 4.5px, not 6px.
		// Settled has no `md:` step because it cannot go below 40 while the row
		// still carries the desktop action buttons; the phone overflow button
		// leaves the row in conduit-test-vik1.9. Keep these heights for now.
		comfortable: {
			row: "min-h-[52px] md:min-h-[46px] py-1.5 md:py-1 px-[7px]",
			settled: "min-h-[40px] py-1 px-[7px]",
		},
		dense: {
			row: "min-h-[44px] py-1 px-[7px]",
			settled: "min-h-[38px] py-[3px] px-[7px]",
		},
	};
</script>

<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { sessionAttention } from "../../stores/session.svelte.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { isSessionWoken } from "../../stores/session.svelte.js";
	import { getSessionActionState, getSwipeStage, LONG_PRESS_DELAY_MS, MOVEMENT_SLOP_PX } from "../../utils/swipe.js";
	import { onDestroy } from "svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		session,
		projectLabel,
		href = "",
		active = false,
		renaming: renamingProp = false,
		cleanupMode = false,
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
		onpin,
		onsnooze,
		onunsnooze,
		oncommitsnooze,
		heldSessionId,
		onholdchange,
		menuOpen = false,
		onrename,
		onrenameend,
	}: {
		session: SessionInfo;
		// `| undefined` because the list passes it unconditionally and a row
		// without a project name is the single-project case, not a missing prop.
		projectLabel?: string | undefined;
		href?: string;
		active?: boolean;
		renaming?: boolean;
		cleanupMode?: boolean;
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
		oncontextmenu?: (session: SessionInfo, anchor: HTMLElement) => void;
		onsettle?: (id: string, next: boolean) => void;
		onpin?: (id: string, next: boolean) => void;
		onsnooze?: (id: string) => void;
		onunsnooze?: (id: string) => void;
		oncommitsnooze?: (id: string) => void;
		heldSessionId?: string | null;
		onholdchange?: (id: string | null) => void;
		/** This row's action menu is open: keep its anchor and verbs on screen. */
		menuOpen?: boolean;
		onrename?: (id: string, title: string) => void;
		onrenameend?: () => void;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let localRenaming = $state(false);
	let renameValue = $state("");
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
	let pendingOutsideBlock: ((event: MouseEvent) => void) | undefined;
	let pendingOutsideTimer: ReturnType<typeof setTimeout> | undefined;

	// Combined rename state: local (double-click) OR external (context menu)
	const isRenaming = $derived(localRenaming || renamingProp);

	// Initialize rename value when context menu triggers rename mode.
	// Only reads renamingProp (no circular write to localRenaming).
	$effect(() => {
		if (renamingProp) {
			renameValue = session.title || "New Session";
		}
	});

	// ─── Derived ────────────────────────────────────────────────────────────────

	const displayTitle = $derived(session.title || "New Session");
	const actions = $derived(getSessionActionState(session, now));
	const swipeStage = $derived(getSwipeStage(offset, rowEl?.getBoundingClientRect().width ?? 0));
	const swipeDirection = $derived(offset > 0 ? "settle" : "snooze");
	const swipeAllowed = $derived(canSwipe(swipeDirection));
	const shelfRow = $derived(settled || snoozed);
	const timeText = $derived(snoozedUntilText ?? settledAt ?? formatTimeAgo(session.updatedAt));
	const woken = $derived(isSessionWoken(session, now) && !snoozed);
	const wokeReason = $derived(session.wokenAt != null ? (session.wokeBecause ?? "time") : "time");
	const wokeText = $derived(
		wokeReason === "time" ? "Woke" :
		wokeReason === "error" ? "Woke · failed" :
		wokeReason === "turn" ? "Woke · done" : `Woke · ${wokeReason}`,
	);
	const wokeColour = $derived(
		wokeReason === "approval" ? "bg-warning/10 text-warning" :
		wokeReason === "question" ? "bg-brand-b/10 text-brand-b" :
		wokeReason === "error" ? "bg-error/10 text-error" :
		wokeReason === "turn" ? "bg-success/10 text-success" : "bg-accent-bg text-accent",
	);
	const contextText = $derived(
		[projectLabel, branch].filter((part) => part).join(" \u00B7 "),
	);
	const accessibleContext = $derived(shelfRow ? projectLabel : contextText);

	// The server derives the tier in one place and the row only reads it. It is
	// deliberately not re-derived from `processing`, the local phase or the
	// pending counts: a second derivation could disagree with the section this
	// row is filed under, and two answers on one screen is worse than either.
	const status = $derived(ATTENTION_DISPLAY[sessionAttention(session)]);
	const emphasis = $derived(EMPHASIS_CLASSES[status.emphasis]);
	const densityClass = $derived(
		shelfRow ? DENSITY_CLASSES[density].settled : DENSITY_CLASSES[density].row,
	);
	const titleClass = $derived(
		shelfRow
			? "text-base text-text-secondary font-normal"
			: `text-lg ${emphasis.title}`,
	);
	const rowOpacityClass = $derived(shelfRow ? "opacity-50" : woken ? "" : emphasis.row);

	// Status first, per the design reference. A screen reader user scanning the
	// list hears what a row wants before its title. This overrides the row's own
	// text as the accessible name, which is why title, project and time are
	// repeated here.
	const ariaLabel = $derived(
		[
			status.spoken,
			displayTitle,
			accessibleContext,
			timeText,
			woken ? wokeText : "",
		]
			.filter((part) => part)
			.join(", "),
	);

	// The leading column holds either the 20px status glyph or, in cleanup mode,
	// the selection control, which is 44px wide because it is a touch target and
	// not a glyph. It widens rather than letting the control overflow into the
	// title, and the `minmax(110px, 1fr)` middle column IS the title's floor --
	// no `min-w-` utility anywhere else may restate it.
	const itemClass = $derived(
		`session-item group grid ${
			cleanupMode
				? "grid-cols-[44px_minmax(110px,1fr)_auto]"
				: "grid-cols-[20px_minmax(110px,1fr)_auto]"
		} gap-x-[9px] items-center ${densityClass} ${rowOpacityClass} rounded-panel cursor-pointer relative` +
			(active
				? " active bg-bg-surface text-text"
				: " text-text-secondary hover:bg-sidebar-hover hover:text-text"),
	);

	// ─── Handlers ───────────────────────────────────────────────────────────────

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
		suppressTimer = setTimeout(() => { suppressClick = false; }, 450);
	}

	function closeHold(notify = true) {
		heldDirection = null;
		offset = 0;
		if (notify) onholdchange?.(null);
	}

	function clearOutsideBlock() {
		if (pendingOutsideBlock) window.removeEventListener("click", pendingOutsideBlock, true);
		if (pendingOutsideTimer) clearTimeout(pendingOutsideTimer);
		pendingOutsideBlock = undefined;
		pendingOutsideTimer = undefined;
	}

	$effect(() => {
		if (heldSessionId !== undefined && heldSessionId !== session.id && heldDirection) closeHold(false);
	});

	$effect(() => {
		if (!heldDirection) return;
		const closeOutside = (event: PointerEvent) => {
			if (!rowEl?.parentElement?.contains(event.target as Node)) {
				const pressed = event.target as Node;
				closeHold();
				clearOutsideBlock();
				const blockClick = (click: MouseEvent) => {
					clearOutsideBlock();
					const target = click.target as Node;
					if (!pressed.contains(target) && !target.contains(pressed)) return;
					click.preventDefault();
					click.stopImmediatePropagation();
				};
				pendingOutsideBlock = blockClick;
				window.addEventListener("click", blockClick, true);
				pendingOutsideTimer = setTimeout(clearOutsideBlock, 450);
			}
		};
		window.addEventListener("pointerdown", closeOutside, true);
		return () => window.removeEventListener("pointerdown", closeOutside, true);
	});

	function clearLongPress() {
		if (longPressTimer) clearTimeout(longPressTimer);
		longPressTimer = undefined;
	}

	function canSwipe(direction: "settle" | "snooze") {
		return direction === "settle"
			? actions.settleDisabledReason == null
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
		if (event.pointerType !== "touch" || cleanupMode || isRenaming || !oncontextmenuProp || (event.target as Element).closest("button")) return;
		if (activePointer !== null) return;
		if (heldDirection) { closeHold(); armClickSuppression(); return; }
		activePointer = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		gesture = "pending";
		longPressTimer = setTimeout(() => {
			if (activePointer === null || gesture !== "pending") return;
			suppressNativeContextMenu = true;
			setTimeout(() => { suppressNativeContextMenu = false; }, 1000);
			armClickSuppression();
			if (rowEl) oncontextmenuProp?.(session, rowEl);
			stopPointer();
		}, LONG_PRESS_DELAY_MS);
		window.addEventListener("pointermove", movePointer);
		window.addEventListener("pointerup", finishPointer);
		window.addEventListener("pointercancel", cancelPointer);
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
		const stage = canSwipe(direction) ? getSwipeStage(offset, rowEl?.getBoundingClientRect().width ?? 0) : "none";
		stopPointer();
		if (!wasHorizontal) return;
		armClickSuppression();
		if (stage === "commit") {
			runSwipeAction(direction, true);
			offset = 0;
		} else if (stage === "reveal") {
			heldDirection = direction;
			offset = (direction === "settle" ? 1 : -1) * 88;
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

	onDestroy(() => { stopPointer(); clearOutsideBlock(); if (suppressTimer) clearTimeout(suppressTimer); });

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

	function startRename() {
		localRenaming = true;
		renameValue = session.title || "New Session";
	}

	function handleDblClick(e: MouseEvent) {
		if (cleanupMode || !onrename) return;
		e.preventDefault();
		e.stopPropagation();
		startRename();
	}

	function commitRename() {
		const newTitle = renameValue.trim();
		localRenaming = false;
		onrenameend?.();
		if (newTitle && newTitle !== session.title) {
			onrename?.(session.id, newTitle);
		}
	}

	function cancelRename() {
		localRenaming = false;
		onrenameend?.();
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}

	function handleRenameBlur() {
		commitRename();
	}

	function handleRenameClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative overflow-hidden rounded-panel session-swipe-wrapper">
	{#if (dragging && swipeStage !== "none" && swipeAllowed) || heldDirection}
		{@const direction = heldDirection ?? swipeDirection}
		{@const verb = direction === "settle" ? (settled || actions.settled ? "Un-settle" : "Settle") : (snoozed || actions.snoozed ? "Unsnooze" : "Snooze")}
		{@const stage = heldDirection ? "reveal" : swipeStage}
		<button
			type="button"
			data-testid="session-swipe-action"
			data-stage={stage}
			aria-label="{verb} {displayTitle}"
			class="absolute inset-0 {direction === 'settle' ? 'justify-start' : 'justify-end'} flex items-center gap-1 px-3 font-brand text-sm font-medium {stage === 'commit' ? (direction === 'settle' ? 'bg-success text-bg' : 'bg-accent text-bg') : (direction === 'settle' ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent')}"
			onclick={(event) => { event.preventDefault(); event.stopPropagation(); if (heldDirection) runSwipeAction(heldDirection, false); }}
		>
			<Icon name={verb === "Settle" ? "check" : verb === "Snooze" ? "moon" : "undo"} size={16} />
			{stage === "commit" ? `Release to ${verb.toLowerCase()}` : verb}
		</button>
	{/if}
<a
	bind:this={rowEl}
	href={href || undefined}
	class="{itemClass} no-underline {offset !== 0 && !active ? 'bg-sidebar-bg' : ''} {dragging ? 'transition-none' : 'transition-[color,background-color,transform] duration-150 motion-reduce:transition-none'}"
	style="touch-action: pan-y; -webkit-touch-callout: none; user-select: none; transform: translateX({offset}px); {active ? 'box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);' : ''}"
	data-session-id={session.id}
	aria-label={ariaLabel}
	onclick={handleClick}
	onclickcapture={suppressGestureClick}
	onpointerdown={startPointer}
	oncontextmenu={(event) => {
		if (cleanupMode || !oncontextmenuProp) return;
		event.preventDefault();
		if (suppressNativeContextMenu) { suppressNativeContextMenu = false; return; }
		if (activePointer !== null) { stopPointer(); armClickSuppression(); }
		oncontextmenuProp(session, event.currentTarget);
	}}
>
	<!-- Selection circle (cleanup mode) -->
	{#if cleanupMode}
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
			class="col-start-1 row-start-1 row-span-2 self-stretch shrink-0 w-[44px] rounded duration-100 {active
				? selected
					? 'text-brand-a'
					: 'text-text-muted'
				: selected
					? 'text-accent'
					: 'text-text-dimmer'}"
			onclick={handleSelectionToggle}
		>
			<Icon name={selected ? "circle-check" : "circle"} size={18} />
		</Button>
	{:else if status.icon}
		<span
			class="col-start-1 row-start-1 row-span-2 grid place-items-center w-5 h-5 justify-self-center {status.colour}"
			aria-hidden="true"
		>
			<Icon name={status.icon} size={shelfRow ? 11 : 14} />
		</span>
	{/if}

	<!-- Title line -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		class="session-item-title col-start-2 row-start-1 flex items-center gap-1.5 overflow-hidden font-brand {titleClass}"
		ondblclick={handleDblClick}
	>
		{#if shelfRow && projectLabel && !isRenaming}
			<span class="text-sm text-text-dimmer shrink-0">
				{projectLabel}
			</span>
		{/if}
		{#if isRenaming}
			<!-- The bespoke version hard-coded `border-accent` to say "this row is
			     being edited". TextInput says that on focus and the field is
			     autofocused, so the signal survives -- which matters, because an
			     additive `border-accent` here would silently lose to the base
			     `border-border` (Tailwind emits border-colour utilities
			     alphabetically). -->
			<TextInput
				aria-label="Session name"
				size="sm"
				class="font-brand"
				bind:value={renameValue}
				onkeydown={handleRenameKeydown}
				onblur={handleRenameBlur}
				onclick={handleRenameClick}
				autofocus
			/>
		{:else}
			<span
				class="session-title-inner inline-block group-hover:pr-[3em] group-hover:session-title-marquee overflow-hidden text-ellipsis whitespace-nowrap min-w-0 group-hover:text-clip"
				>{displayTitle}</span
			>
		{/if}
		{#if pinned}
			<span class="shrink-0 text-text-dimmer" title="Pinned session">
				<Icon name="star" size={11} />
			</span>
		{/if}

	</span>

	{#if contextText && !shelfRow && !isRenaming}
		<span
			class="session-item-context col-start-2 row-start-2 flex items-center gap-1.5 mt-0.5 text-sm text-text-dimmer overflow-hidden whitespace-nowrap font-brand"
		>
			<span class="overflow-hidden text-ellipsis min-w-0">{contextText}</span>
		</span>
	{/if}

	{#if !isRenaming}
		<!-- One row, not a stack: a 36px control stacked under a pill is 56px of
		     content inside a row that promises 46px, and the row would silently
		     grow past its own density contract. -->
		<div
			class="col-start-3 row-start-1 row-span-2 self-stretch flex items-center gap-1.5 shrink-0 text-base text-text-dimmer tabular-nums whitespace-nowrap font-brand"
		>
			<!-- The pill when the tier has a word, the time otherwise, and never
			     both: two answers in one corner is the ambiguity this row is being
			     rebuilt to remove. Read from the tier table, not from the
			     emphasis, which only describes the title's weight. -->
			<!-- Status word. Hidden from the accessible name because aria-label above
			     already leads with it; announcing it twice per row is noise. -->
			{#if status.word && !shelfRow}
				<span
					class="session-item-status inline-flex items-center px-0.5 text-sm font-medium whitespace-nowrap font-brand {status.colour} md:group-hover:hidden md:group-focus-within:hidden {menuOpen ? 'md:hidden' : ''}"
					aria-hidden="true"
				>
					{status.word}
				</span>
			{:else}
				<span class="session-item-meta md:group-hover:hidden md:group-focus-within:hidden {menuOpen ? 'md:hidden' : ''}" title={settled && session.settledAutomatically ? "Settled automatically after it sat idle" : undefined}>{settled && session.settledAutomatically ? `Auto · ${timeText}` : timeText}</span>
			{/if}
			{#if woken}
				<span
					data-testid="session-woke-pill"
					class="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-xs font-medium {wokeColour}"
				>{wokeText}</span>
			{/if}

			<!-- Desktop verbs replace the time on hover and keyboard focus. -->
			{#if !cleanupMode && oncontextmenuProp}
				<span class="hidden md:group-hover:inline-flex md:group-focus-within:inline-flex {menuOpen ? 'md:inline-flex' : ''} items-center gap-0.5" data-testid="session-row-actions">
					<Button variant="ghost" size="content" tone="inherit" hoverFill="none"
						class="size-[27px] rounded-[7px] text-text-secondary hover:text-text hover:bg-bg-alt"
						data-testid={settled || actions.settled ? "session-act-unsettle" : "session-act-settle"}
						ariaLabel="{settled || actions.settled ? 'Un-settle' : 'Settle'} {displayTitle}"
						title={actions.settleDisabledReason ?? (settled || actions.settled ? "Un-settle" : "Settle")}
						disabled={actions.settleDisabledReason != null}
						onclick={(event) => { event.preventDefault(); event.stopPropagation(); onsettle?.(session.id, !(settled || actions.settled)); }}
					><Icon name={settled || actions.settled ? "undo" : "check"} size={16} /></Button>
					{#if actions.snoozeVisible}
						{#if snoozed || actions.snoozed}
							<Button variant="ghost" size="content" tone="inherit" hoverFill="none"
								class="size-[27px] rounded-[7px] text-text-secondary hover:text-text hover:bg-bg-alt"
								data-testid="session-act-unsnooze" ariaLabel="Unsnooze {displayTitle}" title="Unsnooze"
								onclick={(event) => { event.preventDefault(); event.stopPropagation(); onunsnooze?.(session.id); }}
							><Icon name="undo" size={16} /></Button>
						{:else}
							<Button variant="ghost" size="content" tone="inherit" hoverFill="none"
								class="size-[27px] rounded-[7px] text-text-secondary hover:text-text hover:bg-bg-alt"
								data-testid="session-act-snooze" ariaLabel="Snooze {displayTitle}"
								title={actions.snoozeDisabledReason ?? "Snooze"} disabled={actions.snoozeDisabledReason != null}
								onclick={(event) => { event.preventDefault(); event.stopPropagation(); onsnooze?.(session.id); }}
							><Icon name="moon" size={16} /></Button>
						{/if}
					{/if}
					<Button variant="ghost" size="content" tone="inherit" hoverFill="none"
						class="size-[27px] rounded-[7px] text-text-secondary hover:text-text hover:bg-bg-alt"
						data-testid={actions.pinned ? "session-act-unpin" : "session-act-pin"}
						ariaLabel="{actions.pinned ? 'Unpin' : 'Pin'} {displayTitle}" title={actions.pinned ? "Unpin" : "Pin"}
						onclick={(event) => { event.preventDefault(); event.stopPropagation(); onpin?.(session.id, !actions.pinned); }}
					><Icon name={actions.pinned ? "star-off" : "star"} size={16} /></Button>
				<Button
					bind:element={moreBtnEl}
					variant="ghost"
					size="content"
					tone="inherit"
					hoverFill="none"
					class="session-more-btn shrink-0 size-[27px] rounded-[7px] duration-100 {active
						? 'text-text-muted group-hover:text-text-secondary hover:text-text hover:bg-bg-alt'
						: 'text-text-dimmer/50 group-hover:text-text-dimmer hover:text-text hover:bg-bg-alt'}"
					title="More options"
					ariaLabel="More options for {displayTitle}"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onclick={handleMoreClick}
				>
					<Icon name="ellipsis" size={16} />
				</Button>
				</span>
			{/if}
		</div>
	{/if}
</a>
</div>
