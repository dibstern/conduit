<!-- ─── Chat Layout ─────────────────────────────────────────────────────────── -->
<!-- Main layout for the /p/:slug/ route: Sidebar + Header + Messages + Input. -->
<!-- Wires all feature/overlay components into the layout hierarchy. -->
<!-- Preserves element IDs and class names for E2E test compatibility. -->

<script lang="ts">
	import { untrack } from "svelte";
	import Header from "./Header.svelte";
	import Sidebar from "./Sidebar.svelte";
	import InputArea from "../input/InputArea.svelte";
	import MessageList from "../chat/MessageList.svelte";
	import ConnectOverlay from "../overlays/ConnectOverlay.svelte";
	import Banners from "../overlays/Banners.svelte";
	import Toast from "../overlays/Toast.svelte";
	import ImageLightbox from "../overlays/ImageLightbox.svelte";
	import QrModal from "../overlays/QrModal.svelte";
	import SettingsPanel from "../overlays/SettingsPanel.svelte";
	import DebugPanel from "../debug/DebugPanel.svelte";
	import InfoPanels from "../overlays/InfoPanels.svelte";
	import RewindBanner from "../overlays/RewindBanner.svelte";
	import TodoOverlay from "../todo/TodoOverlay.svelte";
	import TerminalPanel from "../terminal/TerminalPanel.svelte";
	import PlanMode from "../chat/PlanMode.svelte";
	import FileViewer from "../file/FileViewer.svelte";
	import PermissionNotification from "../permissions/PermissionNotification.svelte";
	import {
		uiState,
		closeFileViewer,
		showToast,
		resetProjectUI,
		setSidebarWidth,
		setFileViewerWidth,
		SIDEBAR_MIN_WIDTH,
		SIDEBAR_MAX_WIDTH,
		FILE_VIEWER_MIN_WIDTH,
		FILE_VIEWER_MAX_WIDTH,
	} from "../../stores/ui.svelte.js";
	import {
		connect,
		disconnect,
		onConnect,
		onNavigateToSession,
		clearNavigateToSession,
		initSWNavigationListener,
		onPlanMode,
		onRewind,
		wsSend,
	} from "../../stores/ws.svelte.js";
	import { slugState } from "../../stores/router.svelte.js";
	import { chatState, clearMessages } from "../../stores/chat.svelte.js";
	import { terminalState, destroyAll } from "../../stores/terminal.svelte.js";
	import { clearSessionState, switchToSession } from "../../stores/session.svelte.js";
	import { clearAllPermissions } from "../../stores/permissions.svelte.js";
	import { clearDiscoveryState } from "../../stores/discovery.svelte.js";
	import { todoState, clearTodoState } from "../../stores/todo.svelte.js";
	import { requestFileTree, clearFileTreeState } from "../../stores/file-tree.svelte.js";
	import { featureFlags, initFeatureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
	import { fetchCurrentVersion } from "../../stores/version.svelte.js";
	import type { RelayMessage } from "../../types.js";

	// ─── Layout classes ────────────────────────────────────────────────────────

	const layoutClass = $derived.by(() => {
		let cls = "flex h-dvh";
		if (uiState.sidebarCollapsed) cls += " sidebar-collapsed";
		return cls;
	});

	// ─── Local state ──────────────────────────────────────────────────────────

	let qrVisible = $state(false);
	let settingsVisible = $state(false);
	let settingsInitialTab = $state("notifications");
	let debugPanelVisible = $state(false);
	let planModeData = $state<{
		mode: "enter" | "exit" | "content" | "approval" | null;
		content: string;
		onApprove?: () => void;
		onReject?: () => void;
	}>({ mode: null, content: "" });

	// ─── Terminal resize state ─────────────────────────────────────────────

	const TERMINAL_MIN_HEIGHT = 100;
	const TERMINAL_MAX_RATIO = 0.7; // 70% of parent height
	const TERMINAL_DEFAULT_HEIGHT = 300;
	const TERMINAL_STORAGE_KEY = "terminal-panel-height";

	let terminalHeight = $state(
		Number(
			typeof localStorage !== "undefined" &&
				localStorage.getItem(TERMINAL_STORAGE_KEY),
		) || TERMINAL_DEFAULT_HEIGHT,
	);
	let isResizing = $state(false);
	let mobileMaximized = $state(false);
	/** Visual viewport height — tracks keyboard show/hide on mobile. */
	let vvHeight = $state<number | null>(null);
	let appEl: HTMLDivElement | undefined = $state(undefined);

	// ─── Sidebar resize state ─────────────────────────────────────────────

	let isSidebarResizing = $state(false);

	// ─── File viewer resize state ─────────────────────────────────────────

	let isFileViewerResizing = $state(false);
	let layoutEl: HTMLDivElement | undefined = $state(undefined);

	function handleFileViewerResizeStart(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		isFileViewerResizing = true;
		const startX = "touches" in e ? ((e as TouchEvent).touches[0]?.clientX ?? 0) : e.clientX;
		const layoutWidth = layoutEl?.clientWidth ?? window.innerWidth;

		function onMove(ev: MouseEvent | TouchEvent) {
			const clientX =
				"touches" in ev
					? ((ev as TouchEvent).touches[0]?.clientX ?? 0)
					: (ev as MouseEvent).clientX;
			// File viewer is on the right — mouse moving left = wider viewer
			const viewerWidth = layoutWidth - clientX;
			const percent = (viewerWidth / layoutWidth) * 100;
			setFileViewerWidth(
				Math.max(
					FILE_VIEWER_MIN_WIDTH,
					Math.min(FILE_VIEWER_MAX_WIDTH, percent),
				),
			);
		}

		function onEnd() {
			isFileViewerResizing = false;
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

	function handleSidebarResizeStart(e: MouseEvent | TouchEvent) {
		if (uiState.sidebarCollapsed) return;
		e.preventDefault();
		isSidebarResizing = true;
		const startX = "touches" in e ? ((e as TouchEvent).touches[0]?.clientX ?? 0) : e.clientX;
		const startW = uiState.sidebarWidth;

		function onMove(ev: MouseEvent | TouchEvent) {
			const clientX =
				"touches" in ev
					? ((ev as TouchEvent).touches[0]?.clientX ?? 0)
					: (ev as MouseEvent).clientX;
			const delta = clientX - startX;
			const newW = Math.max(
				SIDEBAR_MIN_WIDTH,
				Math.min(SIDEBAR_MAX_WIDTH, startW + delta),
			);
			setSidebarWidth(newW);
		}

		function onEnd() {
			isSidebarResizing = false;
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

	function handleResizeStart(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		isResizing = true;
		const startY =
			"touches" in e ? ((e as TouchEvent).touches[0]?.clientY ?? 0) : e.clientY;
		const startH = terminalHeight;
		const maxH = appEl
			? appEl.clientHeight * TERMINAL_MAX_RATIO
			: window.innerHeight * TERMINAL_MAX_RATIO;

		function onMove(ev: MouseEvent | TouchEvent) {
			const clientY =
				"touches" in ev
					? ((ev as TouchEvent).touches[0]?.clientY ?? 0)
					: (ev as MouseEvent).clientY;
			// Dragging up = increasing terminal height
			const delta = startY - clientY;
			const newH = Math.max(
				TERMINAL_MIN_HEIGHT,
				Math.min(maxH, startH + delta),
			);
			terminalHeight = newH;
		}

		function onEnd() {
			isResizing = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onEnd);
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			// Persist
			try {
				localStorage.setItem(
					TERMINAL_STORAGE_KEY,
					String(Math.round(terminalHeight)),
				);
			} catch {
				/* ignore */
			}
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onEnd);
		document.addEventListener("touchmove", onMove, { passive: false });
		document.addEventListener("touchend", onEnd);
	}

	/**
	 * Touch-drag handler for the terminal tab bar (bottom-sheet pattern).
	 * Uses a movement threshold so taps on tabs/buttons still fire normally.
	 * In mobileMaximized mode, dragging down exits maximized and snaps to default height.
	 * In normal mode, drags resize the terminal pixel-by-pixel.
	 */
	function handleTabBarTouchStart(e: TouchEvent) {
		const startY = e.touches[0]?.clientY ?? 0;
		const startH = terminalHeight;
		const threshold = 8; // px before treating as a drag
		let isDragging = false;
		const maxH = appEl
			? appEl.clientHeight * TERMINAL_MAX_RATIO
			: window.innerHeight * TERMINAL_MAX_RATIO;

		function onMove(ev: TouchEvent) {
			const clientY = ev.touches[0]?.clientY ?? 0;
			const delta = startY - clientY;

			if (!isDragging && Math.abs(delta) < threshold) return;

			if (!isDragging) {
				isDragging = true;
				isResizing = true;
			}

			ev.preventDefault(); // prevent scroll once dragging

			if (mobileMaximized) {
				// In maximized mode: dragging down exits maximized, snap to default
				if (delta < -threshold) {
					mobileMaximized = false;
					terminalHeight = TERMINAL_DEFAULT_HEIGHT;
				}
			} else {
				const newH = Math.max(
					TERMINAL_MIN_HEIGHT,
					Math.min(maxH, startH + delta),
				);
				terminalHeight = newH;
			}
		}

		function onEnd() {
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			if (isDragging) {
				isResizing = false;
				if (!mobileMaximized) {
					try {
						localStorage.setItem(
							TERMINAL_STORAGE_KEY,
							String(Math.round(terminalHeight)),
						);
					} catch {
						/* ignore */
					}
				}
			}
		}

		document.addEventListener("touchmove", onMove, { passive: false });
		document.addEventListener("touchend", onEnd);
	}

	// ─── Todo items (from reactive todo store, updated by SSE + tool results) ──

	const todoItems = $derived(todoState.items);

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleQrClose() {
		qrVisible = false;
	}

	// ─── Lifecycle: WebSocket connection ───────────────────────────────────────

	$effect(() => {
		// Read slug from slugState — this ONLY changes when the project slug changes,
		// not on session-within-project changes (unlike getCurrentSlug() which reads
		// routerState.path and would cause disconnect/reconnect on every session switch).
		const slug = slugState.current;
		if (!slug) return;

		// Wrap everything except the slug read in untrack() so the only
		// reactive dependency of this effect is slugState.current.
		// In particular, connect() must be untracked because it internally
		// calls getCurrentSessionId() → getCurrentRoute() → routerState.path,
		// which would cause a spurious disconnect/reconnect cycle whenever
		// the session portion of the URL changes (e.g. on initial load when
		// the server sends session_switched and replaceRoute updates the path).
		untrack(() => {
			clearMessages();
			clearSessionState();
			clearAllPermissions();
			destroyAll();
			clearDiscoveryState();
			clearTodoState();
			clearFileTreeState();
			resetProjectUI();
			planModeData = { mode: null, content: "" };

			// Register notification-click → session navigation callback.
			// Uses wsSend so switchToSession can notify the server.
			onNavigateToSession((sessionId) => {
				switchToSession(sessionId, wsSend);
			});

			// Listen for SW postMessage (push notification clicks)
			initSWNavigationListener();

			onConnect(() => {
				// Fetch current version for sidebar footer
				fetchCurrentVersion();
				// Request initial state from server
				wsSend({ type: "list_sessions" });
				wsSend({ type: "get_agents" });
				wsSend({ type: "get_models" });
				wsSend({ type: "get_commands" });
				wsSend({ type: "get_projects" });
				requestFileTree();
				wsSend({ type: "get_file_tree" });
				// Request existing terminal sessions so the panel can show them
				wsSend({ type: "terminal_command", action: "list" });
			});

			connect(slug);
		});

		return () => {
			clearNavigateToSession();
			disconnect();
		};
	});

	// ─── Plan mode subscription ───────────────────────────────────────────────

	$effect(() => {
		const unsub = onPlanMode((msg: RelayMessage) => {
			switch (msg.type) {
				case "plan_enter":
					planModeData = { mode: "enter", content: "" };
					break;
				case "plan_exit":
					planModeData = { mode: null, content: "" };
					break;
				case "plan_content":
					planModeData = {
						...planModeData,
						mode: "content",
						content: msg.content ?? "",
					};
					break;
				case "plan_approval":
					planModeData = {
						...planModeData,
						mode: "approval",
						onApprove: () => wsSend({ type: "plan_approve" }),
						onReject: () => wsSend({ type: "plan_reject" }),
					};
					break;
			}
		});
		return unsub;
	});

	// ─── Rewind result subscription ──────────────────────────────────────────

	$effect(() => {
		const unsub = onRewind((msg: RelayMessage) => {
			if (msg.type === "rewind_result") {
				// Rewind completed — clear messages and show feedback
				clearMessages();
				const mode = msg.mode ?? "both";
				showToast(`Rewound ${mode === "both" ? "conversation & files" : mode}`);
			}
		});
		return unsub;
	});

	// ─── Terminal mobile-maximize event bridge (Sidebar dispatches "terminal:mobile-maximize") ──

	$effect(() => {
		function onTerminalMobileMaximize() {
			mobileMaximized = true;
			// Auto-collapse the todo overlay to free vertical space
			window.dispatchEvent(new CustomEvent("todo:collapse"));
		}
		window.addEventListener("terminal:mobile-maximize", onTerminalMobileMaximize);
		return () => window.removeEventListener("terminal:mobile-maximize", onTerminalMobileMaximize);
	});

	// Clear mobileMaximized when terminal panel closes
	$effect(() => {
		if (!terminalState.panelOpen) {
			mobileMaximized = false;
		}
	});

	// ─── Visual viewport tracking (keyboard avoidance when terminal is open) ──
	// CSS dvh does NOT account for the virtual keyboard. We listen to the
	// visualViewport API and constrain #app height so the terminal stays above
	// the keyboard and xterm.js refits via its ResizeObserver.
	// Active whenever the terminal panel is open on a mobile-width viewport.
	$effect(() => {
		const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
		if (!terminalState.panelOpen || !isMobile) {
			vvHeight = null;
			return;
		}
		const vv = window.visualViewport;
		if (!vv) return;

		function onViewportResize() {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded above
			vvHeight = Math.round(vv!.height);
		}
		onViewportResize(); // capture initial height
		vv.addEventListener("resize", onViewportResize);
		return () => vv.removeEventListener("resize", onViewportResize);
	});

	// ─── QR modal event bridge (Header dispatches "qr:show") ─────────────────

	$effect(() => {
		function onQrShow() {
			qrVisible = true;
		}
		window.addEventListener("qr:show", onQrShow);
		return () => window.removeEventListener("qr:show", onQrShow);
	});

	// ─── Settings panel event bridge (Header dispatches "settings:open") ──────

	$effect(() => {
		function onSettingsOpen(e: Event) {
			const detail = (e as CustomEvent).detail;
			if (detail?.tab) settingsInitialTab = detail.tab;
			settingsVisible = true;
		}
		window.addEventListener("settings:open", onSettingsOpen);
		return () => window.removeEventListener("settings:open", onSettingsOpen);
	});

	// ─── Feature flag initialization ────────────────────────────────────────────
	$effect(() => {
		initFeatureFlags();
	});

	// ─── Debug keyboard shortcut (Ctrl/Cmd+Shift+D) ────────────────────────────
	$effect(() => {
		function handleDebugShortcut(e: KeyboardEvent) {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
				e.preventDefault();
				toggleFeature("debug");
			}
		}
		window.addEventListener("keydown", handleDebugShortcut);
		return () => window.removeEventListener("keydown", handleDebugShortcut);
	});

	// ─── Show debug panel when feature flag enabled ────────────────────────────
	$effect(() => {
		if (featureFlags.debug) {
			debugPanelVisible = true;
		}
	});

	// ─── Debug panel toggle event (from Header bug icon) ───────────────────────
	$effect(() => {
		function onDebugToggle() {
			debugPanelVisible = !debugPanelVisible;
		}
		window.addEventListener("debug:toggle", onDebugToggle);
		return () => window.removeEventListener("debug:toggle", onDebugToggle);
	});
</script>

<div bind:this={layoutEl} id="layout" class={layoutClass}>
	<!-- Sidebar (includes overlay backdrop) -->
	<Sidebar />

	<!-- Sidebar resize handle (desktop only) -->
	{#if !uiState.sidebarCollapsed}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="sidebar-resize-handle w-1 shrink-0 cursor-col-resize hidden md:flex items-center justify-center group hover:bg-accent/10 transition-colors relative"
			onmousedown={handleSidebarResizeStart}
			ontouchstart={handleSidebarResizeStart}
		>
			<div class="absolute inset-y-0 -left-0.5 -right-0.5"></div>
		</div>
	{/if}

	<!-- Main app area -->
	<div
		bind:this={appEl}
		id="app"
		class="flex-1 flex flex-col min-w-0 relative pt-[env(safe-area-inset-top,0px)]"
		class:h-full={!vvHeight}
		class:select-none={isResizing || isSidebarResizing || isFileViewerResizing}
		style={vvHeight ? `height: ${vvHeight}px;` : ""}
	>
		<!-- Header -->
		<Header />

		<!-- Connection Overlay -->
		<ConnectOverlay />

		<!-- Banners (update available, skip permissions, etc.) -->
		<Banners />

		<!-- Remote permission notification (other sessions needing approval) -->
		<PermissionNotification />

		<!-- Todo Sticky Overlay -->
		<TodoOverlay items={todoItems} />

		<!-- Plan Mode UI -->
		{#if planModeData.mode}
			<PlanMode
				mode={planModeData.mode}
				content={planModeData.content}
				{...planModeData.onApprove != null ? { onApprove: planModeData.onApprove } : {}}
				{...planModeData.onReject != null ? { onReject: planModeData.onReject } : {}}
			/>
		{/if}

		<!-- Rewind Banner -->
		{#if uiState.rewindActive}
			<RewindBanner />
		{/if}

		<!-- Messages + Input area (hidden when terminal is mobile-maximized) -->
		{#if !mobileMaximized}
			<div class="flex flex-col flex-1 min-h-0">
				<MessageList />
				<InputArea />
			</div>
		{/if}

		<!-- Terminal Panel (resizable bottom panel) -->
		{#if terminalState.panelOpen}
			<!-- Resize handle (hidden when mobile-maximized — tab bar is the drag target) -->
			{#if !mobileMaximized}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="terminal-resize-handle h-1.5 shrink-0 cursor-ns-resize flex items-center justify-center group hover:bg-accent/10 transition-colors"
					onmousedown={handleResizeStart}
					ontouchstart={handleResizeStart}
				>
					<div class="w-8 h-0.5 rounded-full bg-border group-hover:bg-accent/50 transition-colors"></div>
				</div>
			{/if}
			<div class={mobileMaximized ? "flex-1 min-h-0 bg-bg-surface" : "shrink-0 min-h-0"} style={mobileMaximized ? "" : `height: ${terminalHeight}px;`}>
				<TerminalPanel onTabBarTouchStart={handleTabBarTouchStart} />
			</div>
		{/if}

		<!-- Info Panels (absolute positioned floating panels) -->
		<InfoPanels />
	</div>
	<!-- /#app -->

	<!-- File viewer resize handle (desktop only, visible when file viewer is open) -->
	{#if uiState.fileViewerOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="file-viewer-resize-handle w-1 shrink-0 cursor-col-resize hidden lg:flex items-center justify-center group hover:bg-accent/10 transition-colors relative"
			onmousedown={handleFileViewerResizeStart}
			ontouchstart={handleFileViewerResizeStart}
		>
			<div class="absolute inset-y-0 -left-0.5 -right-0.5"></div>
		</div>
	{/if}

	<!-- File Viewer: split pane on desktop, full overlay on mobile -->
	<FileViewer visible={uiState.fileViewerOpen} onClose={closeFileViewer} />
</div>
<!-- /#layout -->

<!-- Global overlays (outside layout for proper z-index stacking) -->
<ImageLightbox />
<Toast />
<QrModal visible={qrVisible} onClose={handleQrClose} />
<SettingsPanel visible={settingsVisible} initialTab={settingsInitialTab} onClose={() => (settingsVisible = false)} />
{#if featureFlags.debug}
	<DebugPanel visible={debugPanelVisible} onClose={() => (debugPanelVisible = false)} />
{/if}

