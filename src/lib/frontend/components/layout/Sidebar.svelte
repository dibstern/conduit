<!-- ─── Sidebar ─────────────────────────────────────────────────────────────── -->
<!-- Left sidebar with session actions, session list, and file browser panel. -->
<!-- Desktop: collapsible via toggle. Phone: full-screen list route. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";
	import SessionList from "../session/SessionList.svelte";
	import SessionGroupMenu from "../session/SessionGroupMenu.svelte";
	import ProjectManagerPanel from "../project/ProjectManagerPanel.svelte";
	import SidebarFilePanel from "../file/SidebarFilePanel.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import { versionState } from "../../stores/version.svelte.js";
	import {
		uiState,
		collapseSidebar,
		setSidebarPanel,
	} from "../../stores/ui.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { navigate, getCurrentSlug } from "../../stores/router.svelte.js";
	import { createPtyRpc, getFileListRpc } from "../../transport/ws-rpc-client.js";
	import { applyGetFileListResponse } from "../../stores/ws-dispatch.js";
	import { beginCreateTab, failCreateTab, terminalState, togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
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

	// ─── Local state ──────────────────────────────────────────────────────────
	let projectsOpen = $state(false);
	let listMenuOpen = $state(false);
	let projectContextMenuOpen = $state(false);

	// ─── Handlers ──────────────────────────────────────────────────────────────
	function toggleProjectsPanel() {
		projectsOpen = !projectsOpen;
	}

	function handleCloseSidebar() {
		collapseSidebar();
	}

	function handleNewSession() {
		sendNewSession();
	}

	function handleResumeSession() {
		const id = prompt("Enter session ID to resume:");
		if (id?.trim()) {
			switchToSession(id.trim());
		}
	}

	function handleFileBrowser() {
		if (uiState.sidebarPanel === "files") {
			setSidebarPanel("sessions");
		} else {
			setSidebarPanel("files");
			const slug = getCurrentSlug();
			if (slug) {
				void getFileListRpc({ projectSlug: slug, path: "." }).then(
					applyGetFileListResponse,
				);
			}
		}
	}

	function requestTerminalCreate() {
		const slug = getCurrentSlug();
		if (!slug || !beginCreateTab()) return;
		void createPtyRpc({
			projectSlug: slug,
			originId: getBrowserClientId(),
		}).catch(() => {
			failCreateTab("Failed to create terminal");
		});
	}

	function handleTerminalSidebar() {
		const wasOpen = terminalState.panelOpen;
		toggleTerminalPanel();
		if (!wasOpen && terminalState.tabs.size === 0) {
			requestTerminalCreate();
		}
		// On a phone, maximize the terminal so it replaces the list screen.
		if (!wasOpen && sessionViewState.compact) {
			window.dispatchEvent(new CustomEvent("terminal:mobile-maximize"));
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
					title="Projects"
					data-testid="list-overflow-projects"
					onselect={() => { projectsOpen = true; }}
				>
					Projects…
				</MenuItem>
				<MenuItem
					title="Settings"
					data-testid="list-overflow-settings"
					onselect={() => openSettings()}
				>
					Settings
				</MenuItem>
				{#if featureFlags.debug}
					<MenuSeparator />
					<MenuItem
						title="Toggle debug panel"
						data-testid="list-overflow-debug"
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
	<nav id="sidebar-nav" class="flex-1 flex flex-col overflow-hidden">
		<!-- Action buttons (always visible) -->
		<div
			id="session-actions"
			class="flex flex-col gap-px px-2.5 py-2 shrink-0"
		>
			<!--
				`align="start"` because BASE has no `justify-*` and ALIGN's default
				`center` would emit one: a plain flex row already starts its items,
				so `justify-start` is what "unchanged" looks like here.
				`disabledStyle="undimmed"` matches the as-found `disabled:cursor-default`
				with no dimming; the default `dim` would have faded the button to 50%.
			-->
			<Button
				id="new-session-btn"
				variant="ghost"
				size="content"
				align="start"
				tone="secondary"
				hoverFill="sidebar"
				class="session-action-btn gap-2 w-full py-1.5 px-2.5 rounded-md text-base duration-100 text-left font-brand"
				disabledStyle="undimmed"
				disabled={sessionCreation.value.phase === "creating"}
				onclick={handleNewSession}
			>
				{#if sessionCreation.value.phase === "creating"}
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
				{:else}
					<Icon name="plus" size={16} class="shrink-0" />
				{/if}
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>New session</span
				>
			</Button>
			<Button
				id="resume-session-btn"
				variant="ghost"
				size="content"
				align="start"
				tone="secondary"
				hoverFill="sidebar"
				class="session-action-btn gap-2 w-full py-1.5 px-2.5 rounded-md text-base duration-100 text-left font-brand"
				onclick={handleResumeSession}
			>
				<Icon name="link" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>Resume with ID</span
				>
			</Button>
			<Button
				id="file-browser-btn"
				variant="ghost"
				size="content"
				align="start"
				tone="secondary"
				hoverFill="sidebar"
				class="session-action-btn gap-2 w-full py-1.5 px-2.5 rounded-md text-base duration-100 text-left font-brand"
				onclick={handleFileBrowser}
			>
				<Icon name="folder-tree" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>File browser</span
				>
			</Button>
			<Button
				id="terminal-sidebar-btn"
				variant="ghost"
				size="content"
				align="start"
				tone="secondary"
				hoverFill="sidebar"
				class="session-action-btn gap-2 w-full py-1.5 px-2.5 rounded-md text-base duration-100 text-left font-brand"
				onclick={handleTerminalSidebar}
			>
				<Icon name="square-terminal" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>Terminal</span
				>
			</Button>
		</div>

	{#if uiState.sidebarPanel === "sessions"}
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
		{:else}
			<!-- File browser panel -->
			<SidebarFilePanel />
		{/if}
	</nav>

	<!-- Sidebar footer: version info -->
	<div
		id="sidebar-footer"
		class="px-3.5 py-2.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+12px)] border-t border-border-subtle shrink-0"
	>
		{#if versionState.current}
			<div class="text-xs text-text-dimmer px-2 font-brand">
				conduit v{versionState.current}
			</div>
		{/if}
	</div>

</div>
