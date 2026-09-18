<!--
  SessionBar — the session's own top bar, phones only (design bar 18).

  Two of bar 18's three bands land here: back-to-the-list with its attention
  badge plus the project identity, then the session title. The view switcher
  band and the at-bottom collapse arrive in later tickets; the slot for the
  switcher is marked below so the band order is already fixed.

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
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { openMobileSidebar, setSidebarPanel } from "../../stores/ui.svelte.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
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

	function backToSessions() {
		setSidebarPanel("sessions");
		openMobileSidebar();
	}

	let overflowOpen = $state(false);
</script>

<div
	id="session-bar"
	data-testid="session-bar"
	class="shrink-0 bg-bg-surface border-b border-border"
>
	<!-- Band 1 — leaving, and where you are. -->
	<div class="flex items-center gap-2 px-3 pt-1">
		<!--
			`size="content"` because this button owns its own box: a 44px minimum
			is the platform touch target and is taller than the 38px the mock
			draws, and the taller of the two constraints wins. Literal px, not
			`min-h-11` — the root font-size is 12px here, so 11rem/4 would be 33px.
		-->
		<Button
			variant="ghost"
			size="content"
			icon="chevron-left"
			iconSize={17}
			class="shrink-0 min-h-[44px] gap-1.5 rounded-lg pl-1 pr-2 text-base font-semibold"
			data-testid="session-bar-back"
			onclick={backToSessions}
		>
			Sessions
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

		<span class="flex-1"></span>

		{#if identity}
			<!-- Identity is the first thing to give: it truncates while the back
			     control stays whole, because losing the way out is worse than
			     losing the project's name. -->
			<span
				data-testid="session-bar-identity"
				class="min-w-0 truncate text-sm font-medium leading-none text-text-muted"
			>
				{identity}
			</span>
		{/if}

		<!--
			Beside the identity, as in the header: which instance this project runs
			on is part of where you are. Absent with a single instance.

			Deliberately left at the pill recipe's own 18px height rather than
			raised to the bar's 44px touch target. `min-h-[44px]` was tried and
			captured: `pill` is `rounded-full`, so 44px turns a 10px label into a
			tall empty lozenge that reads as a rendering fault. Its tap target is
			exactly the desktop header's, so this is not a regression, and the real
			fix is a small-paint/large-hit-area capability on ui/Button rather than
			a call-site override (conduit-test-lciu).
		-->
		<InstanceBadgeMenu />

		<!--
			Everything the global header offered that is not identity. The header
			is gone at this width, and the sidebar has never had a settings entry,
			so without this the whole set is simply unreachable on a phone.

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
			<MenuItem
				title="Share"
				data-testid="overflow-share"
				onselect={shareViaQr}
			>
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
	</div>

	<!-- Band 2 — the session title, and the only string in the bar allowed to
	     ellipse. It is the page heading on a phone; the global header's <h1> is
	     suppressed at this width, so there is still exactly one.

	     The chevron is the session menu's affordance. It is drawn but inert, and
	     the heading is deliberately not focusable: a focus stop that does
	     nothing is worse than no focus stop. It becomes a real control when the
	     session menu is wired up. -->
	<div class="px-3 pb-2">
		<h1
			data-testid="session-bar-title"
			class="flex min-w-0 items-center gap-1.5 text-lg font-semibold leading-tight text-text"
		>
			<span class="truncate">{title}</span>
			<Icon
				name="chevron-down"
				size={12}
				class="shrink-0 text-text-muted"
			/>
		</h1>
	</div>

	<!-- The view switcher band (Chat / Terminal / Diff / Files) belongs here,
	     below the title, and lands with its own ticket. -->
</div>
