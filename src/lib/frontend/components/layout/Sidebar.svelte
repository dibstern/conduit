<!-- ─── Sidebar ─────────────────────────────────────────────────────────────── -->
<!-- Left sidebar with session actions, session list, and file browser panel. -->
<!-- Desktop: collapsible via toggle. Mobile: slide-over with overlay. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Button from "../ui/Button.svelte";
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
	import { navigate, getCurrentSlug } from "../../stores/router.svelte.js";
	import { createPtyRpc, getFileListRpc } from "../../transport/ws-rpc-client.js";
	import { applyGetFileListResponse } from "../../stores/ws-dispatch.js";
	import { beginCreateTab, failCreateTab, terminalState, togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { sendNewSession, sessionCreation, switchToSession } from "../../stores/session.svelte.js";

	// ─── Local state ──────────────────────────────────────────────────────────

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleCloseSidebar() {
		collapseSidebar();
	}

	function handleOverlayClick() {
		closeMobileSidebar();
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
	class="fixed inset-0 bg-[rgba(var(--overlay-rgb),0.45)] backdrop-blur-[2px] z-[var(--z-overlay)] transition-opacity duration-[250ms] ease-linear"
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
			class="mobile-sidebar-resize absolute top-0 bottom-0 -right-1 w-3 cursor-col-resize md:hidden z-[var(--z-raised)] flex items-center justify-center"
			onmousedown={handleMobileResizeStart}
			ontouchstart={handleMobileResizeStart}
		>
			<div class="absolute inset-y-0 -left-0.5 -right-0.5 hover:bg-accent/15 transition-colors"></div>
		</div>
	{/if}
</div>
