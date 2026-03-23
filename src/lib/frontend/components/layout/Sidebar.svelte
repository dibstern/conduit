<!-- ─── Sidebar ─────────────────────────────────────────────────────────────── -->
<!-- Left sidebar with session actions, session list, and file browser panel. -->
<!-- Desktop: collapsible via toggle. Mobile: slide-over with overlay. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";
	import SessionList from "../session/SessionList.svelte";
	import ProjectSwitcher from "../project/ProjectSwitcher.svelte";
	import SidebarFilePanel from "../file/SidebarFilePanel.svelte";
	import { versionState } from "../../stores/version.svelte.js";
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
	import { terminalState, togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { sendNewSession, sessionCreation } from "../../stores/session.svelte.js";

	// ─── Local state ──────────────────────────────────────────────────────────

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleCloseSidebar() {
		collapseSidebar();
	}

	function handleOverlayClick() {
		closeMobileSidebar();
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
		const wasOpen = terminalState.panelOpen;
		toggleTerminalPanel(wsSend);
		// On mobile: close sidebar overlay and maximize terminal so user can type
		if (!wasOpen && window.innerWidth <= 768) {
			closeMobileSidebar();
			window.dispatchEvent(new CustomEvent("terminal:mobile-maximize"));
		}
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
			class="sidebar-logo flex items-center gap-2 no-underline"
			onclick={handleLogoClick}
		>
			<span class="text-sm font-medium tracking-[0.14em] text-text font-brand">conduit</span>
			<BlockGrid cols={10} mode="static" blockSize={2} gap={1} />
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
			class="session-action-btn flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-text-secondary text-base cursor-pointer disabled:cursor-default transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text font-brand"
			onclick={handleNewSession}
				disabled={sessionCreation.value.phase === "creating"}
			>
				{#if sessionCreation.value.phase === "creating"}
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
				{:else}
					<Icon name="plus" size={16} class="shrink-0" />
				{/if}
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>New session</span
				>
			</button>
			<button
				id="resume-session-btn"
			class="session-action-btn flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-text-secondary text-base cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text font-brand"
			onclick={handleResumeSession}
			>
				<Icon name="link" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>Resume with ID</span
				>
			</button>
			<button
				id="file-browser-btn"
			class="session-action-btn flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-text-secondary text-base cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text font-brand"
			onclick={handleFileBrowser}
			>
				<Icon name="folder-tree" size={16} class="shrink-0" />
				<span class="overflow-hidden text-ellipsis whitespace-nowrap"
					>File browser</span
				>
			</button>
			<button
				id="terminal-sidebar-btn"
			class="session-action-btn flex items-center gap-2 w-full py-1.5 px-2.5 border-none rounded-md bg-transparent text-text-secondary text-base cursor-pointer transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text font-brand"
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

	<!-- Sidebar footer: version info -->
	<div
		id="sidebar-footer"
		class="px-3.5 py-2.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+12px)] border-t border-border-subtle shrink-0"
	>
		{#if versionState.latest}
			<a
				href="https://www.npmjs.com/package/conduit-code"
				target="_blank"
				rel="noopener noreferrer"
			class="flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-md bg-brand-a/10 text-brand-a text-sm font-medium no-underline hover:bg-brand-a/15 transition-colors font-brand"
			>
				<Icon name="arrow-up-circle" size={13} />
				<span>Update available: v{versionState.latest}</span>
			</a>
		{/if}
		{#if versionState.current}
			<div class="text-xs text-text-dimmer px-2 font-brand">
				conduit v{versionState.current}
			</div>
		{/if}
	</div>

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
