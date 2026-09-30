<!--
  SessionBar — the session's top bar on phones and desktop (design bar 20).

  One component for both layouts. On phones the expanded form has an identity
  row and a title/Views row; at the bottom of the transcript it collapses to a
  single 46px row. Desktop keeps one row regardless of transcript position.

  You collapse by scrolling to the bottom and expand by scrolling up or by
  pressing the chevron. There is deliberately no collapse button: hiding chrome
  is never urgent, getting it back is.

  Phone geometry lives in style.css as a grid keyed on `data-collapsed`, so the
  title moves between rows without being re-parented and the <h1> never unmounts.

  The instance badge stays beside the project identity. The title menu carries
  session verbs and global actions; the desktop overflow carries global actions.
-->

<script lang="ts">
	import { featureFlags } from "../../stores/feature-flags.svelte.js";
	import { getAttentionSessions } from "../../stores/notification-reducer.svelte.js";
	import { getDescendantSessionIds } from "../../stores/permissions.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import {
		getCurrentSlug,
	} from "../../stores/router.svelte.js";
	import {
		forceBarOpen,
		isBarCollapsed,
		sessionViewState,
	} from "../../stores/session-view.svelte.js";
	import { findSession, isSessionSnoozed, sessionState } from "../../stores/session.svelte.js";
	import { isSessionUnreadHeld } from "../../stores/session-unread-hold.svelte.js";
	import { backToSessions, toggleSessionRead } from "../../utils/session-read.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import { getSessionBarState } from "../../utils/session-lifecycle.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuCheckboxItem from "../ui/MenuCheckboxItem.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import SessionContextMenu from "../session/SessionContextMenu.svelte";
	import GitIdentity from "../session/GitIdentity.svelte";
	import SessionRenameInput from "../session/SessionRenameInput.svelte";
	import { getSettleVerb, sessionVerbActions } from "../session/session-verbs.js";
	import { uiState, expandSidebar } from "../../stores/ui.svelte.js";
	import { wsState } from "../../stores/ws.svelte.js";
	import {
		openSettings,
		shareViaQr,
		toggleDebugPanel,
	} from "./chrome-actions.js";
	import InstanceBadgeMenu from "./InstanceBadgeMenu.svelte";
	import { activeSessionView, sessionViews } from "./session-views.js";

	// "New Session" matches session/SessionItem.svelte, so an untitled session
	// reads the same in the bar as it does in the list it came from.
	const session = $derived(findSession(sessionState.currentId ?? ""));
	const title = $derived(session?.title || "New Session");
	const stateChip = $derived(getSessionBarState(session, sessionState.now));
	const settleVerb = $derived(session ? getSettleVerb(session, sessionState.now) : undefined);
	const statusTitle = $derived(wsState.statusText || "Connecting");
	const statusClass = $derived.by(() => {
		switch (wsState.status) {
			case "connected": return "bg-success";
			case "processing": return "bg-success animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "error": return "bg-error";
			default: return "bg-text-muted";
		}
	});

	// The project list arrives after the bar can render, so use the slug until then.
	const identity = $derived(
		projectState.projects.find((p) => p.slug === getCurrentSlug())?.title ??
			getCurrentSlug(),
	);
	const git = $derived(
		projectState.projects.find((p) => p.slug === getCurrentSlug())?.git,
	);

	const attentionCount = $derived(
		getAttentionSessions(sessionState.currentId, getDescendantSessionIds).size,
	);

	const collapsed = $derived(isBarCollapsed());
	const activeView = $derived(activeSessionView());
	const viewBadgeCount = $derived(
		sessionViews.reduce((total, view) => total + (view.badge?.() ?? 0), 0),
	);

	let barEl: HTMLElement | null = $state(null);

	function showControls() {
		forceBarOpen();
		// Expanding unmounts the chevron that was just pressed, which would drop
		// focus to <body> — the change would read to a screen reader as the
		// control disappearing. Moving focus to the bar instead announces the
		// region by name, so it reads as a state change.
		barEl?.focus();
	}

	let overflowOpen = $state(false);
	let overflowOpener: HTMLElement | null = null;
	let stateMenuOpen = $state(false);
	let titleMenuOpen = $state(false);
	let titleMenuAnchor: HTMLElement | null = $state(null);
	let renaming = $state(false);
	// The two layouts anchor their menus differently, so crossing the
	// breakpoint closes any open one rather than leaving it floating.
	$effect(() => {
		void sessionViewState.compact;
		titleMenuOpen = false;
		stateMenuOpen = false;
		overflowOpen = false;
	});

</script>

<!--
	Where you are. Identity is the first thing to give: it truncates while the
	back control stays whole, because losing the way out is worse than losing
	the project's name. On phones it is the first row and is gone when
	collapsed; on desktop it follows the title. Rendered from one snippet in
	either position so DOM order always matches visual order.

	The instance badge sits beside the identity: which instance this project
	runs on is part of where you are. Absent with a single instance. It keeps
	the pill recipe's 18px height rather than the bar's 44px touch target,
	because a 44px rounded-full pill reads as a rendering fault; the real fix is
	a small-paint/large-hit-area capability on ui/Button (conduit-test-lciu).
-->
{#snippet identityBlock()}
	<div id="session-bar-meta" class="flex min-w-0 items-center gap-2" class:desktop-session-identity={session != null}>
		{#if identity}
			<GitIdentity project={identity} {git} />
		{/if}
		<InstanceBadgeMenu />
	</div>
{/snippet}

<div
	id="session-bar"
	data-testid="session-bar"
	data-collapsed={collapsed}
	data-compact={sessionViewState.compact}
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
	{#if sessionViewState.compact || uiState.sidebarCollapsed}
	<Button
		id="session-bar-back"
		variant="ghost"
		size="content"
		icon="chevron-left"
		iconSize={17}
		class="shrink-0 min-h-[44px] gap-1.5 rounded-lg pl-1 pr-2 text-base font-semibold"
		data-testid="session-bar-back"
		onclick={sessionViewState.compact ? backToSessions : expandSidebar}
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
	{/if}

	{#if sessionViewState.compact}{@render identityBlock()}{/if}

	<!-- The session title, and the only string in the bar allowed to ellipse. It
	     is the page heading on a phone; the global header's <h1> is suppressed at
	     this width, so there is still exactly one — and there is still exactly
	     one across the collapse, because this is the same element in both
	     layouts.

	     Collapsed it drops a size: the row shares its width with the state
	     glyph and two 44px controls.

	     Expanded, the title chevron opens the session menu.
	     The collapsed row keeps its separate chevron for expanding the bar. -->
	{#if sessionViewState.compact || session}
	<div id="session-bar-title-row" class="flex min-w-0 items-center gap-1.5">
		<h1
			id="session-bar-title"
			data-testid="session-bar-title"
			class="min-w-0 truncate font-semibold leading-tight text-text"
			class:text-lg={!collapsed}
			class:text-base={collapsed}
		>
			{#if renaming && session}
				<SessionRenameInput {session} onend={() => { renaming = false; }} class="font-brand min-h-[44px] md:min-h-0" />
			{:else}<span class="block truncate">{title}</span>{/if}
		</h1>
		{#if !collapsed}
			<Button
				variant="ghost"
				size="content"
				iconOnly
				icon="chevron-down"
				iconSize={17}
				class="-my-[13px] shrink-0 min-h-[44px] min-w-[44px] justify-center rounded-lg"
				ariaLabel="Session menu"
				aria-haspopup="menu"
				aria-expanded={titleMenuOpen}
				data-testid="session-bar-title-menu"
				onclick={(event) => {
					titleMenuAnchor = event.currentTarget as HTMLElement;
					titleMenuOpen = true;
				}}
			/>
		{/if}
		{#if session?.unread === true && isSessionUnreadHeld(session.id)}
			<Menu ariaLabel="Unread session options" align="end" data-testid="session-bar-unread-menu">
				{#snippet trigger({ props })}
					<Button {...props} variant="ghost" size="content" hoverFill="none" class="group -my-[13px] min-h-[44px] min-w-[44px] shrink-0 rounded-full" ariaLabel="Unread — open options" data-testid="session-bar-unread-chip">
						<Badge variant="quiet" shape="pill" size="sm" class="group-hover:bg-brand-a/10 group-focus-visible:bg-brand-a/10 group-active:bg-brand-a/15 group-data-[state=open]:bg-brand-a/15">
							<span class="size-[7px] shrink-0 rounded-full bg-brand-a" aria-hidden="true"></span>Unread
						</Badge>
					</Button>
				{/snippet}
				<MenuItem data-testid="session-bar-unread-mark-read" onselect={() => void sessionVerbActions.markRead(session)}>Mark read</MenuItem>
			</Menu>
		{/if}
		{#if stateChip && session}
			{#if stateChip.kind === "woke"}
				<Badge variant="quiet" shape="pill" size="sm" class="shrink-0" data-testid="session-bar-state-chip" data-state="woke" title={stateChip.label}>
					<Icon name={stateChip.icon} size={13} class="text-accent" />
					{#if !collapsed}<span class="desktop-state-label">{stateChip.label}</span>{/if}
				</Badge>
			{:else}
				<Menu bind:open={stateMenuOpen} ariaLabel="Session state options" align="end" data-testid="session-bar-state-menu">
					{#snippet trigger({ props })}
						<Button {...props} variant="ghost" size="content" class="min-h-[44px] min-w-[44px] shrink-0 rounded-full" ariaLabel={`${stateChip.label} — open options`} data-testid="session-bar-state-chip" data-state={stateChip.kind}>
							<Badge variant="quiet" shape="pill" size="sm">
								<Icon name={stateChip.icon} size={13} class={stateChip.kind === "snoozed" ? "text-brand-b" : "text-success"} />
								{#if !collapsed}<span class="desktop-state-label">{stateChip.label}</span>{/if}
							</Badge>
						</Button>
					{/snippet}
					<div class="border-b border-border px-3 py-2 text-xs font-semibold text-text">
						{#if stateChip.kind === "snoozed"}
							{session.snoozedUntil == null ? "Snoozed" : `Snoozed until ${stateChip.label}`}
						{:else}
							{stateChip.label} {formatTimeAgo(session.settledAt)}
						{/if}
						{#if stateChip.kind === "auto-settled"}
							<div class="mt-1 font-normal text-text-dimmer">Settled automatically after it sat idle</div>
						{/if}
					</div>
					{#if stateChip.kind === "snoozed"}
						<MenuItem data-testid="session-bar-wake" onselect={() => void sessionVerbActions.unsnooze(session)}>
							<Icon name="undo" size={13} /><span>Wake now</span>
						</MenuItem>
					{:else}
						<MenuItem data-testid="session-bar-unsettle" onselect={() => void sessionVerbActions.settle(session, false)}>
							<Icon name="undo" size={13} /><span>Un-settle</span>
						</MenuItem>
						<MenuCheckboxItem data-testid="session-bar-auto-settle" checked={session.autoSettleDisabled !== true} onselect={() => void sessionVerbActions.autoSettle(session, session.autoSettleDisabled !== true)}>
							<span class="w-[13px] shrink-0" aria-hidden="true"></span><span>Auto-settle when idle</span>
						</MenuCheckboxItem>
					{/if}
				</Menu>
			{/if}
		{/if}
	</div>
	{/if}

	{#if !sessionViewState.compact}{@render identityBlock()}{/if}

	{#if !sessionViewState.compact && settleVerb}
		<Button
			id="session-bar-settle"
			variant="secondary"
			size="sm"
			icon={settleVerb.icon ?? "check"}
			disabled={settleVerb.disabledReason != null}
			title={settleVerb.disabledReason ?? settleVerb.label}
			ariaLabel={settleVerb.disabledReason ? `${settleVerb.label}: ${settleVerb.disabledReason}` : settleVerb.label}
			data-testid="session-bar-settle"
			onclick={settleVerb.run}
		>
			<span id="session-bar-settle-label">{settleVerb.label}</span>
		</Button>
	{/if}

	{#if !sessionViewState.compact}
		<div id="session-bar-connection" class="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
			<span id="status" class="status-dot size-[7px] shrink-0 rounded-full {statusClass}" title={statusTitle} role="status"><span class="sr-only">{statusTitle}</span></span>
			{#if uiState.clientCount > 1}
				<Badge id="client-count-badge" variant="accent-solid" size="count" shape="pill">{uiState.clientCount}</Badge>
			{/if}
		</div>
	{/if}

	{#if sessionViewState.compact && !collapsed}
		<Menu presentation="sheet" ariaLabel="Views" data-testid="session-bar-views-sheet">
			{#snippet trigger({ props })}
				<Button
					{...props}
					id="session-bar-views-button"
					variant="secondary"
					size="sm"
					icon="panels-top-left"
					touchTarget
					class="shrink-0"
					data-testid="session-bar-views-button"
				>
					Views
					{#if viewBadgeCount > 0}
						<Badge variant="accent-solid" size="count" shape="pill">{viewBadgeCount}</Badge>
					{/if}
				</Button>
			{/snippet}
			<div class="border-b border-border px-4 py-3 font-brand text-[14px] font-semibold text-text">Views</div>
			<MenuRadioGroup value={activeView}>
				{#each sessionViews as view (view.id)}
					<MenuRadioItem
						value={view.id}
						data-testid={`session-bar-view-${view.id}`}
						class="min-h-[44px]"
						disabled={view.disabled === true}
						onselect={view.select}
					>
						<span class="flex items-center gap-2">
							<Icon name={view.icon} size={16} class="shrink-0" />
							<span class="min-w-0 flex-1">{view.label}</span>
							{#if view.badge?.()}
								<Badge variant="accent-solid" size="count" shape="pill">{view.badge()}</Badge>
							{/if}
						</span>
					</MenuRadioItem>
				{/each}
			</MenuRadioGroup>
		</Menu>
	{/if}

	{#if sessionViewState.compact && collapsed}
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

	{#if collapsed || !sessionViewState.compact}
		<!--
		The phone's collapsed row and the desktop bar use this overflow. Expanded
		phone actions remain in the title menu.

		Deliberately not here: the connection status dot and the client count,
		which are ambient signals rather than actions and say nothing once
		they are hidden behind a closed menu.
		-->
	<Menu
		bind:open={overflowOpen}
		presentation={sessionViewState.compact ? "sheet" : "popover"}
		ariaLabel="More actions"
		align="end"
		onCloseAutoFocus={(event) => {
			const opener = overflowOpener;
			if (opener?.isConnected) {
				event.preventDefault();
				setTimeout(() => {
					requestAnimationFrame(() => { if (opener.isConnected) opener.focus(); });
				}, 0);
			}
		}}
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
				onpointerdowncapture={(event) => { overflowOpener = event.currentTarget as HTMLElement; }}
				onkeydowncapture={(event) => { overflowOpener = event.currentTarget as HTMLElement; }}
			/>
		{/snippet}

		{#if sessionViewState.compact}
		{#each sessionViews as view (view.id)}
			<MenuItem
				data-testid={`overflow-view-${view.id}`}
				disabled={view.disabled === true}
				aria-current={view.id === activeView ? "true" : undefined}
				onselect={view.select}
			>
				<Icon name={view.icon} size={16} class="shrink-0" />
				<span class="min-w-0 flex-1">{view.label}</span>
				{#if view.badge?.()}
					<Badge variant="accent-solid" size="count" shape="pill">{view.badge()}</Badge>
				{/if}
				{#if view.id === activeView}<Icon name="check" size={14} class="shrink-0 text-accent" />{/if}
			</MenuItem>
		{/each}
		<MenuSeparator />
		{/if}

		{#if sessionViewState.compact && session && session.settledAt == null && !isSessionSnoozed(session, sessionState.now)}
			<MenuItem
				data-testid={session.unread ? "overflow-mark-read" : "overflow-mark-unread"}
				onselect={() => void toggleSessionRead(session)}
			>
				{session.unread ? "Mark read" : "Mark unread"}
			</MenuItem>
			<MenuSeparator />
		{/if}

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
	{/if}

	{#if titleMenuOpen && titleMenuAnchor && session}
		<SessionContextMenu
			{session}
			anchor={titleMenuAnchor}
			projectLabel={identity ?? undefined}
			branch={session.git?.branch}
			presentation={sessionViewState.compact ? "sheet" : "menu"}
			now={sessionState.now}
			host={{ rename: () => { renaming = true; } }}
			onclose={() => { titleMenuOpen = false; }}
			extras={[
				{ testId: "session-title-share", label: "Share", icon: "share", run: shareViaQr },
				{ testId: "session-title-settings", label: "Settings", icon: "settings", run: () => openSettings() },
				...(featureFlags.debug ? [{ testId: "session-title-debug", label: "Debug panel", icon: "bug", run: toggleDebugPanel } as const] : []),
			]}
		/>
	{/if}

</div>
