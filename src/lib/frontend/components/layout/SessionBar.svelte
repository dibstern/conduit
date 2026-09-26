<!--
  SessionBar — the session's own top bar, phones only (design bar 18).

  Two layouts, one DOM tree. Expanded it is two bands: back-to-the-list with its
  attention badge plus the project identity, then the session title. Sitting at
  the bottom of the transcript collapses it to a single 46px row carrying back,
  the title, a chevron that brings the bar back, and the overflow menu. The view
  switcher band arrives with its own ticket; the slot is marked below.

  You collapse by scrolling to the bottom and expand by scrolling up or by
  pressing the chevron. There is deliberately no collapse button: hiding chrome
  is never urgent, getting it back is.

  Geometry lives in style.css as a grid keyed on `data-collapsed`, so the title
  moves between rows without being re-parented and the <h1> never unmounts.

  On compact viewports this REPLACES the global header rather than stacking
  under it, so the header's global actions come with it: the instance badge
  keeps its place beside the project identity, and the rest move into the
  overflow menu at the end of band 1. Nothing the header could reach becomes
  unreachable on a phone.
-->

<script lang="ts">
	import { featureFlags } from "../../stores/feature-flags.svelte.js";
	import { getAttentionSessions } from "../../stores/notification-reducer.svelte.js";
	import { getDescendantSessionIds } from "../../stores/permissions.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import {
		getCurrentSlug,
		navigate,
		previousHistoryEntryIsSessionList,
	} from "../../stores/router.svelte.js";
	import {
		forceBarOpen,
		isBarCollapsed,
	} from "../../stores/session-view.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { setSidebarPanel } from "../../stores/ui.svelte.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import {
		openSettings,
		shareViaQr,
		toggleDebugPanel,
		toggleTerminal,
	} from "./chrome-actions.js";
	import InstanceBadgeMenu from "./InstanceBadgeMenu.svelte";

	// "New Session" matches session/SessionItem.svelte, so an untitled session
	// reads the same in the bar as it does in the list it came from.
	const title = $derived(
		findSession(sessionState.currentId ?? "")?.title || "New Session",
	);

	// The design mock also shows a branch and a PR number beside the project.
	// The frontend has neither, so identity is the project alone; it falls back
	// to the slug because the project list arrives over the socket and the bar
	// renders before it does.
	const identity = $derived(
		projectState.projects.find((p) => p.slug === getCurrentSlug())?.title ??
			getCurrentSlug(),
	);

	const attentionCount = $derived(
		getAttentionSessions(sessionState.currentId, getDescendantSessionIds).size,
	);

	const collapsed = $derived(isBarCollapsed());

	let barEl: HTMLElement | null = $state(null);

	function backToSessions() {
		setSidebarPanel("sessions");
		if (previousHistoryEntryIsSessionList()) {
			window.history.back();
		} else {
			navigate("/");
		}
	}

	function showControls() {
		forceBarOpen();
		// Expanding unmounts the chevron that was just pressed, which would drop
		// focus to <body> — the change would read to a screen reader as the
		// control disappearing. Moving focus to the bar instead announces the
		// region by name, so it reads as a state change.
		barEl?.focus();
	}

	let overflowOpen = $state(false);
</script>

<div
	id="session-bar"
	data-testid="session-bar"
	data-collapsed={collapsed}
	role="region"
	aria-label="Session controls"
	tabindex="-1"
	bind:this={barEl}
	class="shrink-0 bg-bg-surface border-b border-border outline-none"
>
	<!--
		Leaving. `size="content"` because this button owns its own box: a 44px
		minimum is the platform touch target and is taller than the 38px the mock
		draws, and the taller of the two constraints wins. Literal px, not
		`min-h-11` — the root font-size is 12px here, so 11rem/4 would be 33px.

		Collapsed, the word goes and the chevron and badge stay: the icon alone
		is unambiguous once you have seen the labelled version, and the row needs
		the width for the title. `sr-only` rather than `hidden`, because the icon
		is decorative and `display: none` would leave the only way off the screen
		with no accessible name at all.
	-->
	<Button
		id="session-bar-back"
		variant="ghost"
		size="content"
		icon="chevron-left"
		iconSize={17}
		class="shrink-0 min-h-[44px] gap-1.5 rounded-lg pl-1 pr-2 text-base font-semibold"
		data-testid="session-bar-back"
		onclick={backToSessions}
	>
		<span class:sr-only={collapsed}>Sessions</span>
		{#if attentionCount > 0}
			<Badge
				variant="accent-solid"
				size="count"
				shape="pill"
				data-testid="session-bar-attention"
			>
				{attentionCount}
			</Badge>
		{/if}
	</Button>

	<!--
		Where you are. Identity is the first thing to give: it truncates while
		the back control stays whole, because losing the way out is worse than
		losing the project's name. The whole area is gone when collapsed.

		The instance badge sits beside the identity, as in the header: which
		instance this project runs on is part of where you are. Absent with a
		single instance.

		The badge is deliberately left at the pill recipe's own 18px height
		rather than raised to the bar's 44px touch target. `min-h-[44px]` was
		tried and captured: `pill` is `rounded-full`, so 44px turns a 10px label
		into a tall empty lozenge that reads as a rendering fault. Its tap target
		is exactly the desktop header's, so this is not a regression, and the
		real fix is a small-paint/large-hit-area capability on ui/Button rather
		than a call-site override (conduit-test-lciu).
	-->
	<div id="session-bar-meta" class="flex min-w-0 items-center gap-2">
		{#if identity}
			<span
				data-testid="session-bar-identity"
				class="min-w-0 truncate text-sm font-medium leading-none text-text-muted"
			>
				{identity}
			</span>
		{/if}
		<InstanceBadgeMenu />
	</div>

	<!-- The session title, and the only string in the bar allowed to ellipse. It
	     is the page heading on a phone; the global header's <h1> is suppressed at
	     this width, so there is still exactly one — and there is still exactly
	     one across the collapse, because this is the same element in both
	     layouts.

	     Collapsed it drops a size: the row is sharing its width with two 44px
	     controls, and the mock's smallest state carries the name alone.

	     The mock draws a chevron beside the name, the session menu's affordance.
	     It is not here yet, because a control that does nothing is worse than no
	     control -- it reads as broken rather than as coming. It arrives with the
	     menu it opens, as one of that menu's two triggers. -->
	<h1
		id="session-bar-title"
		data-testid="session-bar-title"
		class="flex min-w-0 items-center gap-1.5 font-semibold leading-tight text-text"
		class:text-lg={!collapsed}
		class:text-base={collapsed}
	>
		<span class="truncate">{title}</span>
	</h1>

	{#if collapsed}
		<!--
			Getting the bar back. `secondary` rather than `ghost` so it does not
			read as the same kind of thing as the overflow beside it: at the bar's
			smallest state the two glyphs are all you have, and one of them is the
			way back to everything else.

			Mode glyphs are exactly what you should not have to decode at the
			moment the bar is smallest, so the switcher is not duplicated here.
		-->
		<Button
			id="session-bar-chevron"
			variant="secondary"
			size="content"
			iconOnly
			icon="chevron-down"
			iconSize={17}
			class="shrink-0 min-h-[44px] min-w-[44px] justify-center rounded-lg"
			title="Show the bar"
			ariaLabel="Show session controls"
			aria-expanded={false}
			aria-controls="session-bar"
			data-testid="session-bar-expand"
			onclick={showControls}
		/>
	{/if}

	<!--
		Everything the global header offered that is not identity. The header
		is gone at this width, and the sidebar has never had a settings entry,
		so without this the whole set is simply unreachable on a phone. It
		survives the collapse for the same reason.

		Deliberately not here: the connection status dot and the client count,
		which are ambient signals rather than actions and say nothing once
		they are hidden behind a closed menu.
	-->
	<Menu
		bind:open={overflowOpen}
		ariaLabel="More actions"
		align="end"
		data-testid="session-bar-overflow-menu"
	>
		{#snippet trigger({ props })}
			<Button
				{...props}
				id="session-bar-more"
				variant="ghost"
				size="content"
				iconOnly
				icon="ellipsis"
				iconSize={17}
				class="shrink-0 min-h-[44px] min-w-[44px] justify-center rounded-lg"
				title="More actions"
				ariaLabel="More actions"
				data-testid="session-bar-overflow"
			/>
		{/snippet}

		<MenuItem
			title="Toggle terminal"
			data-testid="overflow-terminal"
			onselect={toggleTerminal}
		>
			Terminal
		</MenuItem>
		<MenuItem title="Share" data-testid="overflow-share" onselect={shareViaQr}>
			Share
		</MenuItem>
		<MenuItem
			title="Settings"
			data-testid="overflow-settings"
			onselect={() => openSettings()}
		>
			Settings
		</MenuItem>

		{#if featureFlags.debug}
			<MenuSeparator />
			<MenuItem
				title="Toggle debug panel"
				data-testid="overflow-debug"
				onselect={toggleDebugPanel}
			>
				Debug panel
			</MenuItem>
		{/if}
	</Menu>

	<!-- The view switcher band (Chat / Terminal / Diff / Files) belongs here,
	     below the title, and lands with its own ticket. It is one of the areas
	     the collapsed template drops. -->
</div>
