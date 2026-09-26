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
		// still carries the 27px overflow button; that button leaves the row in
		// conduit-test-17xt.9, which is when a 36px settled row becomes possible.
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
		branch,
		settledAt,
		pinned = false,
		onswitchsession,
		ontoggleselection,
		oncontextmenu: oncontextmenuProp,
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
		branch?: string | undefined;
		settledAt?: string | undefined;
		pinned?: boolean;
		onswitchsession?: (id: string) => void;
		ontoggleselection?: (id: string) => void;
		oncontextmenu?: (session: SessionInfo, anchor: HTMLElement) => void;
		onrename?: (id: string, title: string) => void;
		onrenameend?: () => void;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let localRenaming = $state(false);
	let renameValue = $state("");
	let moreBtnEl: HTMLButtonElement | HTMLAnchorElement | undefined =
		$state(undefined);

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
	const timeText = $derived(settledAt ?? formatTimeAgo(session.updatedAt));
	const contextText = $derived(
		[projectLabel, branch].filter((part) => part).join(" \u00B7 "),
	);
	const accessibleContext = $derived(settled ? projectLabel : contextText);

	// The server derives the tier in one place and the row only reads it. It is
	// deliberately not re-derived from `processing`, the local phase or the
	// pending counts: a second derivation could disagree with the section this
	// row is filed under, and two answers on one screen is worse than either.
	const status = $derived(ATTENTION_DISPLAY[sessionAttention(session)]);
	const emphasis = $derived(EMPHASIS_CLASSES[status.emphasis]);
	const densityClass = $derived(
		settled ? DENSITY_CLASSES[density].settled : DENSITY_CLASSES[density].row,
	);
	const titleClass = $derived(
		settled
			? "text-base text-text-secondary font-normal"
			: `text-lg ${emphasis.title}`,
	);
	const rowOpacityClass = $derived(settled ? "opacity-50" : emphasis.row);

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
		} gap-x-[9px] items-center ${densityClass} ${rowOpacityClass} rounded-panel cursor-pointer relative transition-colors duration-100` +
			(active
				? " active bg-bg-surface text-text"
				: " text-text-secondary hover:bg-sidebar-hover hover:text-text"),
	);

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleClick(e: MouseEvent) {
		if (!onswitchsession) return;
		e.preventDefault();
		if (!isRenaming) onswitchsession(session.id);
	}

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
<a
	href={href || undefined}
	class="{itemClass} no-underline"
	style={active ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
	data-session-id={session.id}
	aria-label={ariaLabel}
	onclick={handleClick}
	oncontextmenu={(event) => {
		if (cleanupMode || !oncontextmenuProp) return;
		event.preventDefault();
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
			<Icon name={status.icon} size={settled ? 11 : 14} />
		</span>
	{/if}

	<!-- Title line -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		class="session-item-title col-start-2 row-start-1 flex items-center gap-1.5 overflow-hidden font-brand {titleClass}"
		ondblclick={handleDblClick}
	>
		{#if settled && projectLabel && !isRenaming}
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

	{#if contextText && !settled && !isRenaming}
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
			{#if status.word && !settled}
				<span
					class="session-item-status inline-flex items-center px-0.5 text-sm font-medium whitespace-nowrap font-brand {status.colour}"
					aria-hidden="true"
				>
					{status.word}
				</span>
			{:else}
				<span class="session-item-meta">{timeText}</span>
			{/if}

			<!-- Three-dot more button -->
			{#if !cleanupMode && oncontextmenuProp}
				<!--
					`bind:element`, not `bind:this`: Svelte 5 does not forward `bind:this`
					through a component tag, so ui/Button hands the element back by prop.
					The hover pair stays in `class` because it is `group-hover:` driven off
					the row, which no `hoverFill` member expresses. Dropped
					`transition-[opacity,color]`: BASE's `transition-colors` already outranked
					it, and nothing here animates `opacity` -- the fade is an alpha channel on
					the text colour.
				-->
				<Button
					bind:element={moreBtnEl}
					variant="ghost"
					size="content"
					tone="inherit"
					hoverFill="none"
					class="session-more-btn shrink-0 self-stretch w-[44px] rounded duration-100 {active
						? 'text-text-muted group-hover:text-text-secondary hover:text-text hover:bg-bg-alt'
						: 'text-text-dimmer/50 group-hover:text-text-dimmer hover:text-text hover:bg-bg-alt'}"
					title="More options"
					ariaLabel="More options for {displayTitle}"
					aria-haspopup="menu"
					onclick={handleMoreClick}
				>
					<Icon name="ellipsis" size={16} />
				</Button>
			{/if}
		</div>
	{/if}
</a>
