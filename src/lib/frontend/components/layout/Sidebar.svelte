<!-- Left sidebar with the session list. New session is a FAB on phones, + in the header on desktop. -->
<!-- Desktop: collapsible via toggle. Phone: full-screen list route. -->

<script lang="ts">
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";
	import SessionList from "../session/SessionList.svelte";
	import SessionGroupMenu from "../session/SessionGroupMenu.svelte";
	import ProjectManagerPanel from "../project/ProjectManagerPanel.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import {
		uiState,
		collapseSidebar,
	} from "../../stores/ui.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { navigate, getCurrentSlug } from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { sendNewSession, sessionCreation, switchToSession } from "../../stores/session.svelte.js";
	import { featureFlags } from "../../stores/feature-flags.svelte.js";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import { openSettings, toggleDebugPanel } from "./chrome-actions.js";
	import InstanceBadgeMenu from "./InstanceBadgeMenu.svelte";
	import Banners from "../overlays/Banners.svelte";

	// True while this sidebar is the phone's full-screen session list.
	let { listScreen = false }: { listScreen?: boolean } = $props();

	let projectsOpen = $state(false);
	let listMenuOpen = $state(false);
	let projectContextMenuOpen = $state(false);

	function toggleProjectsPanel() {
		projectsOpen = !projectsOpen;
	}

	function handleCloseSidebar() {
		collapseSidebar();
	}

	const newSessionPending = $derived(sessionCreation.value.phase === "creating");

	function handleNewSession() {
		sendNewSession();
	}

	function handleResumeSession() {
		const id = prompt("Enter session ID to resume:");
		if (id?.trim()) {
			switchToSession(id.trim());
		}
	}

	function handleLogoClick(e: MouseEvent) {
		e.preventDefault();
		navigate("/");
	}

	// Sidebar width: collapsed → 0, otherwise user-set width.
	// Sets a CSS custom property that the stylesheet references.
	const sidebarStyle = $derived(
		`--sidebar-w: ${uiState.sidebarCollapsed ? 0 : uiState.sidebarWidth}px;`,
	);

</script>

<!-- Sidebar -->
<div
	id="sidebar"
	class="bg-bg-surface border-r border-border-subtle flex flex-col shrink-0 h-full overflow-hidden"
	style={sidebarStyle}
>
	<!-- Sidebar header: logo + toggle -->
	<div
		id="sidebar-header"
		class="relative flex items-center justify-between px-3 pt-2.5 pb-2 shrink-0"
		use:dismiss={{
			enabled: projectsOpen && !projectContextMenuOpen,
			escape: false,
			onDismiss: () => {
				if (document.getElementById("confirm-modal")) return;
				projectsOpen = false;
			},
		}}
	>
		{#if sessionViewState.compact}
			<!--
				Phone list bar (design option A): title, instance identity, group-by, overflow.
				Select joins
				this menu with multi-select. Literal px keeps touch targets at 44px
				despite the 12px root font size.
			-->
			<h1 class="m-0 text-[19px] font-semibold tracking-[-0.01em] text-text" data-testid="list-bar-title">Sessions</h1>
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
					title="Projects"
					data-testid="list-overflow-projects"
					class="min-h-[44px] md:min-h-0"
					onselect={() => { projectsOpen = true; }}
				>
					Projects…
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
			<a
				href="/"
				class="sidebar-logo flex items-center gap-2 no-underline"
				onclick={handleLogoClick}
			>
				<span class="text-sm font-medium tracking-[0.14em] text-text font-brand">conduit</span>
				<BlockGrid cols={10} mode="static" blockSize={2} gap={1} />
			</a>
			<span class="flex-1"></span>
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
				loading={newSessionPending}
				onclick={handleNewSession}
			/>
			<Button
				id="sidebar-projects-btn"
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="alt"
				iconOnly
				icon="ellipsis"
				iconSize={18}
				class="p-1 rounded-md"
				title="Projects"
				ariaLabel="Projects"
				aria-haspopup="true"
				aria-expanded={projectsOpen}
				aria-controls={projectsOpen ? "sidebar-projects-panel" : undefined}
				onclick={toggleProjectsPanel}
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

		<!-- Keep this surface inside #sidebar so it follows the list route. -->
		{#if projectsOpen}
			<Surface
				variant="card"
				radius="panel"
				elevation="dropdown"
				id="sidebar-projects-panel"
				data-testid="sidebar-projects-panel"
				class="absolute top-full left-1 right-1 z-[var(--z-dropdown)] mt-0.5 min-w-[240px] p-1 overflow-hidden font-brand"
			>
				<ProjectManagerPanel
					projects={projectState.projects}
					currentSlug={getCurrentSlug() ?? undefined}
					onclose={() => { projectsOpen = false; }}
					oncontextmenuopenchange={(nextOpen) => { projectContextMenuOpen = nextOpen; }}
				/>
			</Surface>
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
				<SessionList onaddproject={() => { projectsOpen = true; }} />
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
				loading={newSessionPending}
				onclick={handleNewSession}
			/>
		{/if}
	</nav>

</div>
