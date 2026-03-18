<!-- ─── Sidebar ─────────────────────────────────────────────────────────────── -->
<!-- Left sidebar with session actions, session list, and file browser panel. -->
<!-- Desktop: collapsible via toggle. Mobile: slide-over with overlay. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import SessionList from "../features/SessionList.svelte";
	import ProjectSwitcher from "../features/ProjectSwitcher.svelte";
	import SidebarFilePanel from "../features/SidebarFilePanel.svelte";
	import ThemePicker from "../overlays/ThemePicker.svelte";
	import NotifSettings from "../overlays/NotifSettings.svelte";
	import { toggleThemePicker, closeThemePicker, themeState } from "../../stores/theme.svelte.js";
	import {
		uiState,
		collapseSidebar,
		closeMobileSidebar,
		setSidebarPanel,
		setSidebarWidth,
		SIDEBAR_MIN_WIDTH,
		SIDEBAR_MAX_WIDTH,
	} from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { navigate, getCurrentSlug } from "../../stores/router.svelte.js";
	import { togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { sendNewSession, sessionCreation } from "../../stores/session.svelte.js";

	// ─── Local state ──────────────────────────────────────────────────────────

	let notifMenuOpen = $state(false);

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleCloseSidebar() {
		closeThemePicker();
		collapseSidebar();
	}

	function handleOverlayClick() {
		closeThemePicker();
		closeMobileSidebar();
	}

	function handleOpenSettings() {
		window.dispatchEvent(new CustomEvent("settings:open"));
	}

	function handleToggleNotifMenu() {
		notifMenuOpen = !notifMenuOpen;
	}

	function handleCloseNotifMenu() {
		notifMenuOpen = false;
	}

	function handleNewSession() {
		sendNewSession(wsSend);
	}

	function handleResumeSession() {
		const id = prompt("Enter session ID to resume:");
		if (id?.trim()) {
			wsSend({ type: "switch_session", sessionId: id.trim() });
		}
	}

	function handleFileBrowser() {
		if (uiState.sidebarPanel === "files") {
			setSidebarPanel("sessions");
		} else {
			setSidebarPanel("files");
			wsSend({ type: "get_file_list", path: "." });
		}
	}

	function handleTerminalSidebar() {
		toggleTerminalPanel(wsSend);
	}

	function handleLogoClick(e: MouseEvent) {
		e.preventDefault();
		navigate("/");
	}

	// ─── Mobile resize ────────────────────────────────────────────────────

	function handleMobileResizeStart(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		const startX = "touches" in e ? ((e as TouchEvent).touches[0]?.clientX ?? 0) : e.clientX;
		const startW = uiState.mobileSidebarOpen ? (sidebarEl?.offsetWidth ?? 260) : 260;

		function onMove(ev: MouseEvent | TouchEvent) {
			const clientX =
				"touches" in ev
				? ((ev as TouchEvent).touches[0]?.clientX ?? 0)
				: (ev as MouseEvent).clientX;
			const newW = Math.max(
				SIDEBAR_MIN_WIDTH,
				Math.min(SIDEBAR_MAX_WIDTH, startW + (clientX - startX)),
			);
			setSidebarWidth(newW);
		}

		function onEnd() {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onEnd);
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onEnd);
		document.addEventListener("touchmove", onMove, { passive: false });
		document.addEventListener("touchend", onEnd);
	}

	let sidebarEl: HTMLDivElement | undefined = $state(undefined);

	// On mobile, sidebar uses user-set width (not fixed 260px)
	const mobileSidebarWidth = $derived(
		uiState.mobileSidebarOpen ? uiState.sidebarWidth : 260,
	);

	// Sidebar width: collapsed → 0, otherwise user-set width.
	// Sets a CSS custom property that the stylesheet references.
	const sidebarStyle = $derived(
		`--sidebar-w: ${uiState.sidebarCollapsed ? 0 : uiState.sidebarWidth}px;`,
	);
</script>

<!-- Sidebar overlay (mobile backdrop) -->
<div
	id="sidebar-overlay"
	class="fixed inset-0 bg-[rgba(var(--overlay-rgb),0.45)] backdrop-blur-[2px] z-[350] transition-opacity duration-[250ms] ease-linear"
	class:hidden={!uiState.mobileSidebarOpen}
	onclick={handleOverlayClick}
	onkeydown={undefined}
	role="presentation"
></div>

<!-- Sidebar -->
<div
	bind:this={sidebarEl}
	id="sidebar"
	class="bg-bg-surface border-r border-border-subtle flex flex-col shrink-0 h-full overflow-hidden"
	class:open={uiState.mobileSidebarOpen}
	style={sidebarStyle}
>
	<!-- Sidebar header: logo + toggle -->
	<div
		id="sidebar-header"
		class="flex items-center justify-between px-3 pt-2.5 pb-2 shrink-0"
	>
		<a
			href="/"
			class="sidebar-logo flex items-center no-underline"
			onclick={handleLogoClick}
		>
			<!-- OpenCode "O" Mark -->
			<svg class="footer-mascot" viewBox="0 0 16 20" width="13" height="16" fill="none" aria-hidden="true"
				><path d="M12 16H4V8H12V16Z" fill="currentColor" opacity="0.45" /><path d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="currentColor" /></svg
			>
		</a>
		<button
			id="sidebar-toggle-btn"
			class="flex items-center justify-center bg-none border-none text-text-muted cursor-pointer p-1 rounded-md transition-[color,background] duration-150 hover:text-text hover:bg-bg-alt"
			title="Close sidebar"
			onclick={handleCloseSidebar}
		>
			<Icon name="panel-left-close" size={18} />
		</button>
	</div>

	<!-- Project switcher -->
	<div class="px-1 shrink-0">
		<ProjectSwitcher projects={projectState.projects} currentSlug={getCurrentSlug()} />
	</div>

	<!-- Sidebar nav -->
	<nav id="sidebar-nav" class="flex-1 flex flex-col overflow-hidden">
		<!-- Action buttons (always visible) -->
		<div
			id="session-actions"
			class="flex flex-col gap-px px-2.5 py-2 shrink-0"
		>
			<button
				id="new-session-btn"
				class="session-action-btn flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer disabled:cursor-default transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text"
				onclick={handleNewSession}
				disabled={sessionCreation.value.phase === "creating"}
			>
				{#if sessionCreation.value.phase === "creating"}
					<Icon name="loader-2" size={16} class="shrink-0 animate-spin" />
				{:else}
					<Icon name="plus" size={16} class="shrink-0" />
				{/if}
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>New session</span
				>
			</button>
			<button
				id="resume-session-btn"
				class="session-action-btn flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text"
				onclick={handleResumeSession}
			>
				<Icon name="link" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>Resume with ID</span
				>
			</button>
			<button
				id="file-browser-btn"
				class="session-action-btn flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text"
				onclick={handleFileBrowser}
			>
				<Icon name="folder-tree" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>File browser</span
				>
			</button>
			<button
				id="terminal-sidebar-btn"
				class="session-action-btn flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text"
				onclick={handleTerminalSidebar}
			>
				<Icon name="square-terminal" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>Terminal</span
				>
			</button>
		</div>

	{#if uiState.sidebarPanel === "sessions"}
		<!-- Sessions panel -->
		<div
			id="sidebar-panel-sessions"
			class="sidebar-panel flex flex-col flex-1 overflow-hidden"
		>
			<!-- Session list -->
			<div id="session-list-container" class="flex-1 flex flex-col overflow-hidden">
				<SessionList />
			</div>
		</div>
		{:else}
			<!-- File browser panel -->
			<SidebarFilePanel />
		{/if}
	</nav>

	<!-- Sidebar footer -->
	<div
		id="sidebar-footer"
		class="px-3.5 py-3 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+12px)] border-t border-border-subtle shrink-0 flex items-center justify-between"
	>
		<span class="sidebar-footer-text text-xs text-text-dimmer">OpenCode Relay</span>
		<div class="flex items-center gap-0.5">
			<!-- Settings -->
			<button
				id="settings-btn"
				onclick={handleOpenSettings}
				class="p-1 rounded hover:bg-bg-alt text-text-dimmer hover:text-text-secondary transition-colors"
				title="Settings"
			>
				<Icon name="settings" size={14} />
			</button>
			<!-- Notification settings -->
			<div id="notif-settings-wrap">
				<button
					id="notif-settings-btn"
					onclick={handleToggleNotifMenu}
					class="p-1 rounded hover:bg-bg-alt text-text-dimmer hover:text-text-secondary transition-colors"
					title="Notification settings"
				>
					<Icon name="sliders-horizontal" size={14} />
				</button>
				<NotifSettings visible={notifMenuOpen} onClose={handleCloseNotifMenu} />
			</div>
			<!-- Theme picker -->
			<button
				onclick={toggleThemePicker}
				class="p-1 rounded hover:bg-bg-alt text-text-dimmer hover:text-text-secondary transition-colors"
				title="Change theme"
				aria-expanded={themeState.pickerOpen}
				aria-haspopup="listbox"
			>
				<Icon name="palette" size={14} />
			</button>
		</div>
	</div>
	<ThemePicker />

	<!-- Mobile resize handle (right edge, only visible on mobile when open) -->
	{#if uiState.mobileSidebarOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="mobile-sidebar-resize absolute top-0 bottom-0 -right-1 w-3 cursor-col-resize md:hidden z-[1] flex items-center justify-center"
			onmousedown={handleMobileResizeStart}
			ontouchstart={handleMobileResizeStart}
		>
			<div class="absolute inset-y-0 -left-0.5 -right-0.5 hover:bg-accent/15 transition-colors"></div>
		</div>
	{/if}
</div>
