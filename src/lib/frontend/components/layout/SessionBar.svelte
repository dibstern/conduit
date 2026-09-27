<!--
  SessionBar — the session's own top bar, phones only (design bar 18).

  Two layouts, one DOM tree. Expanded it is three bands: back-to-the-list with its
  attention badge plus the project identity, then the session title and views. Sitting at
  the bottom of the transcript collapses it to a single 46px row carrying back,
  the title, a chevron that brings the bar back, and the overflow menu. The view
  switcher band is omitted in the collapsed row.

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
	import { getDescendantSessionIds } from "../../stores/permissions.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import {
		getCurrentSlug,
	} from "../../stores/router.svelte.js";
	import {
		forceBarOpen,
		isBarCollapsed,
	} from "../../stores/session-view.svelte.js";
	import { findSession, getAttentionSessions, isSessionSnoozed, sessionState } from "../../stores/session.svelte.js";
	import { setSidebarPanel, showToast } from "../../stores/ui.svelte.js";
	import { backToSessions, toggleSessionRead } from "../../utils/session-read.js";
	import { WsRpcError } from "../../transport/ws-rpc.js";
	import { setSessionAutoSettleRpc, setSessionSettledRpc, unsnoozeSessionRpc } from "../../transport/ws-rpc-client.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import { getSessionBarState } from "../../utils/session-lifecycle.js";
	import Badge from "../ui/Badge.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
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
	const activeView = $derived(activeSessionView());

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

	function rpcInput() {
		if (!session) return null;
		if (session.projectSlug != null && session.projectSlug !== getCurrentSlug()) return null;
		const projectSlug = session.projectSlug ?? getCurrentSlug();
		return projectSlug
			? { projectSlug, sessionId: session.id, originId: getBrowserClientId() }
			: null;
	}

	async function unsettle() {
		const input = rpcInput();
		if (!input) return;
		try {
			await setSessionSettledRpc({ ...input, settled: false });
		} catch {
			showToast("Couldn't un-settle session", { variant: "error" });
		}
	}

	async function toggleAutoSettle() {
		const input = rpcInput();
		if (!input || !session) return;
		try {
			await setSessionAutoSettleRpc({ ...input, disabled: session.autoSettleDisabled !== true });
		} catch {
			showToast("Couldn't change auto-settle", { variant: "error" });
		}
	}

	async function wakeNow() {
		const input = rpcInput();
		if (!input) return;
		try {
			await unsnoozeSessionRpc(input);
		} catch (error) {
			showToast(error instanceof WsRpcError ? error.message : "Couldn't unsnooze session", { variant: "error" });
		}
	}
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

	     Collapsed it drops a size: the row shares its width with the state
	     glyph and two 44px controls.

	     Expanded, the title chevron opens the same menu as the overflow button.
	     The collapsed row keeps its separate chevron for expanding the bar. -->
	<div id="session-bar-title-row" class="flex min-w-0 items-center gap-1.5">
		<h1
			id="session-bar-title"
			data-testid="session-bar-title"
			class="min-w-0 truncate font-semibold leading-tight text-text"
			class:text-lg={!collapsed}
			class:text-base={collapsed}
		><span class="block truncate">{title}</span></h1>
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
				aria-expanded={overflowOpen}
				data-testid="session-bar-title-menu"
				onclick={(event) => {
					overflowOpener = event.currentTarget as HTMLElement;
					overflowOpen = true;
				}}
			/>
		{/if}
		{#if stateChip && session}
			{#if stateChip.kind === "woke"}
				<Badge variant="quiet" shape="pill" size="sm" class="shrink-0" data-testid="session-bar-state-chip" data-state="woke" title={stateChip.label}>
					<Icon name={stateChip.icon} size={13} class="text-accent" />
					{#if !collapsed}<span>{stateChip.label}</span>{/if}
				</Badge>
			{:else}
				<Menu bind:open={stateMenuOpen} ariaLabel="Session state options" align="end" data-testid="session-bar-state-menu">
					{#snippet trigger({ props })}
						<Button {...props} variant="ghost" size="content" class="min-h-[44px] min-w-[44px] shrink-0 rounded-full" ariaLabel={`${stateChip.label} — open options`} data-testid="session-bar-state-chip" data-state={stateChip.kind}>
							<Badge variant="quiet" shape="pill" size="sm">
								<Icon name={stateChip.icon} size={13} class={stateChip.kind === "snoozed" ? "text-brand-b" : "text-success"} />
								{#if !collapsed}<span>{stateChip.label}</span>{/if}
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
						<MenuItem data-testid="session-bar-wake" onselect={() => void wakeNow()}>
							<Icon name="undo" size={13} /><span>Wake now</span>
						</MenuItem>
					{:else}
						<MenuItem data-testid="session-bar-unsettle" onselect={() => void unsettle()}>
							<Icon name="undo" size={13} /><span>Un-settle</span>
						</MenuItem>
						<MenuItem data-testid="session-bar-auto-settle" aria-checked={session.autoSettleDisabled !== true} onselect={() => void toggleAutoSettle()}>
							<span class="w-[13px] shrink-0" aria-hidden="true">{#if session.autoSettleDisabled !== true}<Icon name="check" size={13} />{/if}</span>
							<span>Auto-settle when idle</span>
						</MenuItem>
					{/if}
				</Menu>
			{/if}
		{/if}
	</div>

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
		presentation="sheet"
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

		{#each sessionViews as view (view.id)}
			<MenuItem
				data-testid={`overflow-view-${view.id}`}
				disabled={view.disabled === true}
				aria-current={view.id === activeView ? "true" : undefined}
				onselect={view.activate}
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

		{#if session && session.settledAt == null && !isSessionSnoozed(session, sessionState.now)}
			<MenuItem
				data-testid={session.unread ? "overflow-mark-read" : "overflow-mark-unread"}
				onselect={() => void toggleSessionRead(session)}
			>
				{session.unread ? "Mark read" : "Mark unread"}
				<span class="ml-auto text-xs text-text-muted">⌘⇧U</span>
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

	{#if !collapsed}
		<div id="session-bar-views" data-testid="session-bar-views">
			<Tabs
				value={activeView}
				options={sessionViews.map((view) => ({ value: view.id, label: view.label, disabled: view.disabled === true, testId: `session-view-${view.id}` }))}
				variant="switcher"
				label="Session views"
				onValueChange={(id) => sessionViews.find((view) => view.id === id && !view.disabled)?.activate()}
			>
				{#snippet optionContent(option)}
					{@const view = sessionViews.find((entry) => entry.id === option.value)}
					{#if view}
						<Icon name={view.icon} size={16} class="shrink-0" />
						<span class="session-view-label truncate">{view.label}</span>
						{#if view.badge?.()}
							<Badge variant="accent-solid" size="count" shape="pill">{view.badge()}</Badge>
						{/if}
						{#if view.shortcut}<span class="session-view-shortcut">{view.shortcut}</span>{/if}
					{/if}
				{/snippet}
			</Tabs>
		</div>
	{/if}
</div>
