<!-- Left sidebar with session selection and compose actions in the header. -->
<!-- Desktop: collapsible via toggle. Phone: full-screen list route. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import SessionList from "../session/SessionList.svelte";
	import {
		uiState,
		collapseSidebar,
	} from "../../stores/ui.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { DRAFT_PROJECT_PARAM, getCurrentSearchParams, navigate } from "../../stores/router.svelte.js";
	import { setSessionScope } from "../../stores/session-scope.js";
	import { applyProjectList, getDraftProject, projectState } from "../../stores/project.svelte.js";
	import type { SaveProjectResponse } from "../../transport/ws-rpc.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { sessionList } from "../../stores/session-list.svelte.js";
	import { featureFlags } from "../../stores/feature-flags.svelte.js";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import { openSettings, toggleDebugPanel } from "./chrome-actions.js";
	import Banners from "../overlays/Banners.svelte";
	import UsageFooterMeter from "./UsageFooterMeter.svelte";

	// True while this sidebar is the phone's full-screen session list.
	let { listScreen = false }: { listScreen?: boolean } = $props();

	let addProjectOpen = $state(false);
	let listMenuOpen = $state(false);
	let phoneUsageHeight = $state(0);

	function handleCloseSidebar() {
		collapseSidebar();
	}

	// A new project is where the next session goes: scope the list to it, then
	// open a draft prefilled with it, so back returns to the scoped list.
	function handleProjectAdded(response: SaveProjectResponse) {
		applyProjectList(response);
		setSessionScope(response.savedSlug);
		const params = getCurrentSearchParams();
		if (response.kind === "existing") {
			params.delete(DRAFT_PROJECT_PARAM);
			navigate(`/?${params}`);
		} else {
			selection.openDraft(response.savedSlug);
		}
		addProjectOpen = false;
	}

	// Settled sessions are never counted: that set only grows.
	const openCount = $derived(
		sessionList.rows.filter((row) => row.settledAt == null).length,
	);

	// Opens a draft; the session is created by its first send. Pins the
	// prefilled project in the URL so a reload, or a later change to the
	// defaults, keeps it.
	function handleNewSession() {
		const shown = selection.shown;
		selection.openDraft(getDraftProject(shown.kind === "placed" ? shown.project : null));
	}

	// Sidebar width: collapsed → 0, otherwise user-set width.
	// Sets a CSS custom property that the stylesheet references.
	const sidebarStyle = $derived(
		`--sidebar-w: ${uiState.sidebarCollapsed ? 0 : uiState.sidebarWidth}px;`,
	);

</script>

{#snippet title()}
	<h1 class="m-0 flex min-w-0 items-baseline gap-[7px] {sessionViewState.compact ? 'text-[22px] font-bold' : 'text-[14px] font-semibold'} tracking-[-0.01em] text-text font-sans" data-testid="list-bar-title">
		Sessions
		<span class="font-mono text-[12px] font-normal tabular-nums text-text-dimmer" data-testid="list-bar-count">{openCount}</span>
	</h1>
{/snippet}

<!-- Sidebar -->
<div
	id="sidebar"
	class="{sessionViewState.compact ? 'bg-bg' : 'bg-sidebar-bg'} @container/sidebar border-r border-border-subtle flex flex-col shrink-0 h-full overflow-hidden"
	style={sidebarStyle}
>
	<div
		id="sidebar-header"
		class="flex shrink-0 items-center gap-[2px] pr-[8px] {sessionViewState.compact ? 'h-[46px] pl-[18px]' : 'h-[48px] pl-[16px]'}"
	>
		{@render title()}
		<span class="flex-1"></span>
		<Button
			variant="toolbar"
			size="content"
			iconOnly
			icon="circle-check"
			iconSize={16}
			class="shrink-0 rounded-[8px] {sessionViewState.compact ? 'size-[44px]' : 'size-[28px]'}"
			title="Select sessions"
			ariaLabel="Select sessions"
			data-testid="list-bar-select"
			onclick={() => { uiState.selectMode = true; }}
		/>
		<Button
			id="new-session-btn"
			variant="toolbar"
			size="content"
			iconOnly
			icon="square-pen"
			iconSize={18}
			class="shrink-0 rounded-[8px] {sessionViewState.compact ? 'size-[44px]' : 'size-[28px]'}"
			title="New session"
			ariaLabel="New session"
			onclick={handleNewSession}
		/>
		{#if sessionViewState.compact}
			<Menu
				bind:open={listMenuOpen}
				ariaLabel="More actions"
				align="end"
				data-testid="list-bar-overflow-menu"
			>
				{#snippet trigger({ props })}
					<Button
						{...props}
						id="list-bar-more"
						variant="toolbar"
						size="content"
						iconOnly
						icon="ellipsis"
						iconSize={17}
						class="size-[44px] shrink-0 rounded-[8px]"
						title="More actions"
						ariaLabel="More actions"
						data-testid="list-bar-overflow"
					/>
				{/snippet}
				<MenuItem
					title="Settings"
					data-testid="list-overflow-settings"
					class="min-h-[44px] md:min-h-0"
					onselect={() => openSettings()}
				>
					Settings
				</MenuItem>
				{#if featureFlags.debug}
					<MenuSeparator />
					<MenuItem
						title="Toggle debug panel"
						data-testid="list-overflow-debug"
						class="min-h-[44px] md:min-h-0"
						onselect={toggleDebugPanel}
					>
						Debug panel
					</MenuItem>
				{/if}
			</Menu>
		{:else}
			<Button
				id="sidebar-toggle-btn"
				variant="toolbar"
				size="content"
				iconOnly
				icon="panel-left"
				iconSize={18}
				class="size-[28px] shrink-0 rounded-[8px]"
				title="Close sidebar"
				ariaLabel="Close sidebar"
				onclick={handleCloseSidebar}
			/>
		{/if}
	</div>

	{#if listScreen}<Banners />{/if}

	<!-- Sidebar nav -->
	<nav id="sidebar-nav" class:clears-home-indicator={listScreen && phoneUsageHeight === 0} class="flex-1 flex flex-col overflow-hidden">
		<!-- Sessions panel -->
		<div
			id="sidebar-panel-sessions"
			class="sidebar-panel flex flex-col flex-1 overflow-hidden"
		>
			<!-- Session list -->
			<div id="session-list-container" class="flex-1 flex flex-col overflow-hidden">
				<SessionList onaddproject={() => { addProjectOpen = true; }} />
			</div>
		</div>

		{#if sessionViewState.compact && listScreen}
			<UsageFooterMeter phone bind:height={phoneUsageHeight} />
		{/if}
	</nav>
	{#if !sessionViewState.compact}<UsageFooterMeter />{/if}

</div>

{#if addProjectOpen}
	{#await import("../project/ProjectDialog.svelte") then { default: ProjectDialog }}
		<ProjectDialog
			open
			projects={projectState.projects}
			onclose={() => { addProjectOpen = false; }}
			onsaved={handleProjectAdded}
			returnFocus={() => document.querySelector('[data-testid="session-scope-chip"]')}
		/>
	{/await}
{/if}

<style>
	/* With no usage dock to take the home-indicator inset, the list clears it. */
	.clears-home-indicator :global(#session-list-scroller) {
		padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
	}
	.clears-home-indicator :global([data-testid="select-bar"]) {
		padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
	}
</style>
