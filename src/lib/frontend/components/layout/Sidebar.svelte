<!-- Left sidebar with the session list. New session is a FAB on phones, + in the header on desktop. -->
<!-- Desktop: collapsible via toggle. Phone: full-screen list route. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import SessionList from "../session/SessionList.svelte";
	import SessionGroupMenu from "../session/SessionGroupMenu.svelte";
	import ProjectDialog from "../project/ProjectDialog.svelte";
	import {
		uiState,
		collapseSidebar,
	} from "../../stores/ui.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { DRAFT_PROJECT_PARAM, getCurrentSearchParams, getCurrentSlug, navigate } from "../../stores/router.svelte.js";
	import { applyProjectList, projectState } from "../../stores/project.svelte.js";
	import { setSessionScope } from "../../stores/session-scope.js";
	import type { SaveProjectResponse } from "../../transport/ws-rpc.js";
	import { switchToSession } from "../../stores/session.svelte.js";
	import { sessionList } from "../../stores/session-list.svelte.js";
	import { featureFlags } from "../../stores/feature-flags.svelte.js";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import { openSettings, toggleDebugPanel } from "./chrome-actions.js";
	import InstanceBadgeMenu from "./InstanceBadgeMenu.svelte";
	import Banners from "../overlays/Banners.svelte";

	// True while this sidebar is the phone's full-screen session list.
	let { listScreen = false }: { listScreen?: boolean } = $props();

	let addProjectOpen = $state(false);
	let listMenuOpen = $state(false);

	function handleCloseSidebar() {
		collapseSidebar();
	}

	function handleProjectAdded(response: SaveProjectResponse) {
		applyProjectList(response);
		setSessionScope(response.savedSlug);
		addProjectOpen = false;
	}

	// Settled sessions are never counted: that set only grows.
	const openCount = $derived(
		sessionList.groups.reduce(
			(total, group) => total + group.rows.filter((row) => row.settledAt == null).length,
			0,
		),
	);

	// Opens a draft; the session is created by its first send.
	function handleNewSession() {
		const params = getCurrentSearchParams();
		const project = getCurrentSlug() ?? projectState.projects.find((p) => !p.missing)?.slug;
		if (project) params.set(DRAFT_PROJECT_PARAM, project);
		navigate(`/new?${params}`);
	}

	function handleResumeSession() {
		const id = prompt("Enter session ID to resume:");
		if (id?.trim()) {
			switchToSession(id.trim());
		}
	}

	// Sidebar width: collapsed → 0, otherwise user-set width.
	// Sets a CSS custom property that the stylesheet references.
	const sidebarStyle = $derived(
		`--sidebar-w: ${uiState.sidebarCollapsed ? 0 : uiState.sidebarWidth}px;`,
	);

</script>

{#snippet title(titleSize: string, countSize: string)}
	<h1 class="m-0 flex min-w-0 items-baseline gap-[5px] {titleSize} font-semibold tracking-[-0.01em] text-text font-brand" data-testid="list-bar-title">
		Sessions
		<span class="{countSize} font-normal tabular-nums text-text-dimmer" data-testid="list-bar-count">{openCount}</span>
	</h1>
{/snippet}

<!-- Sidebar -->
<div
	id="sidebar"
	class="{sessionViewState.compact ? 'bg-bg' : 'bg-bg-surface'} border-r border-border-subtle flex flex-col shrink-0 h-full overflow-hidden"
	style={sidebarStyle}
>
	<!-- Sidebar header: title + count, then actions. Literal px per the design:
	     phone bar 40px under 2px, desktop 34px under 10px. -->
	<div
		id="sidebar-header"
		class="box-content flex shrink-0 items-center {sessionViewState.compact ? 'h-[40px] gap-[10px] px-[12px] pt-[2px]' : 'h-[34px] gap-[2px] px-[10px] pt-[10px]'}"
	>
		{#if sessionViewState.compact}
			<!--
				Phone list bar (design option A): title, instance identity, group-by, overflow.
				Select joins
				this menu with multi-select. Literal px keeps touch targets at 44px
				despite the 12px root font size.
			-->
			{@render title("text-[19px]", "text-[13px]")}
			<span class="flex-1"></span>
			{#if listScreen}<InstanceBadgeMenu />{/if}
			<SessionGroupMenu compact />
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
						variant="ghost"
						size="content"
						iconOnly
						icon="ellipsis"
						iconSize={17}
						class="shrink-0 min-h-[44px] min-w-[44px] justify-center rounded-lg"
						title="More actions"
						ariaLabel="More actions"
						data-testid="list-bar-overflow"
					/>
				{/snippet}
				<MenuItem
					title="Select"
					data-testid="list-overflow-select"
					class="min-h-[44px] md:min-h-0"
					onselect={() => { uiState.selectMode = true; }}
				>
					Select
				</MenuItem>
				<MenuItem
					title="Resume a session by ID"
					data-testid="list-overflow-resume"
					class="min-h-[44px] md:min-h-0"
					onselect={handleResumeSession}
				>
					Resume by ID…
				</MenuItem>
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
			{@render title("text-[15px]", "text-[12px]")}
			<span class="flex-1"></span>
			<Button
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="alt"
				iconOnly
				icon="circle-check"
				iconSize={16}
				class="p-1 rounded-md"
				title="Select sessions"
				ariaLabel="Select sessions"
				onclick={() => { uiState.selectMode = true; }}
			/>
			<Button
				id="new-session-btn"
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="alt"
				iconOnly
				icon="plus"
				iconSize={18}
				class="p-1 rounded-md"
				title="New session"
				ariaLabel="New session"
				onclick={handleNewSession}
			/>
			<!--
				`tone="muted"` and `hoverFill="alt"` reproduce this button's two colour
				pairs token for token. Dropped: `bg-none` (background-image is already
				none), `border-none` and `cursor-pointer` (preflight and BASE do those on
				a button), `transition-[color,background]` (BASE's `transition-colors`
				has always outranked it, since arbitrary values sort first) and
				`duration-150`, which only restated the default.
			-->
			<Button
				id="sidebar-toggle-btn"
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="alt"
				iconOnly
				icon="panel-left-close"
				iconSize={18}
				class="p-1 rounded-md"
				title="Close sidebar"
				ariaLabel="Close sidebar"
				onclick={handleCloseSidebar}
			/>
		{/if}
	</div>

	{#if listScreen}<Banners />{/if}

	<!-- Sidebar nav -->
	<nav id="sidebar-nav" class="relative flex-1 flex flex-col overflow-hidden">
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

		{#if sessionViewState.compact}
			<Button
				id="new-session-btn"
				variant="ghost"
				size="content"
				tone="inherit"
				hoverFill="none"
				iconOnly
				icon="plus"
				iconSize={20}
				class="absolute right-[11px] bottom-[calc(11px+env(safe-area-inset-bottom))] size-[44px] justify-center rounded-full bg-fill-brand text-on-brand shadow-[0_4px_14px_var(--color-backdrop-subtle)]"
				title="New session"
				ariaLabel="New session"
				onclick={handleNewSession}
			/>
		{/if}
	</nav>

</div>

{#if addProjectOpen}
	<ProjectDialog
		open
		projects={projectState.projects}
		onclose={() => { addProjectOpen = false; }}
		onsaved={handleProjectAdded}
		returnFocus={() => document.querySelector('[data-testid="session-scope-chip"]')}
	/>
{/if}
