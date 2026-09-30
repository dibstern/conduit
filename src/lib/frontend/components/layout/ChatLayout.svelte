<!-- ─── Chat Layout ─────────────────────────────────────────────────────────── -->
<!-- Session list and chat: Sidebar + SessionBar + Messages + Input. -->
<!-- Wires all feature/overlay components into the layout hierarchy. -->
<!-- Preserves element IDs and class names for E2E test compatibility. -->

<script lang="ts">
	import { onMount, tick, untrack } from "svelte";
	import { interruptStream, disposeRuntime } from "../../transport/runtime.js";
	import { attachProjectRpc, resolveSessionRpc, viewSessionRpc, getAgentsRpc, getCommandsRpc, getFileTreeRpc, getModelsRpc, getProjectsRpc, listPtysRpc, listSessionsRpc } from "../../transport/ws-rpc-client.js";
	import SessionBar from "./SessionBar.svelte";
	import SidebarFilePanel from "../file/SidebarFilePanel.svelte";
	import ViewsRail from "./ViewsRail.svelte";
	import { activeSessionView, matchSessionViewShortcut } from "./session-views.js";
	import Sidebar from "./Sidebar.svelte";
	import InputArea from "../input/InputArea.svelte";
	import MessageList from "../chat/MessageList.svelte";
	import ConnectOverlay from "../overlays/ConnectOverlay.svelte";
	import Banners from "../overlays/Banners.svelte";
	import NotificationStack from "../overlays/NotificationStack.svelte";
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
	import Button from "../ui/Button.svelte";
	import {
		uiState,
		closeFileViewer,
		showToast,
		resetProjectUI,
		setSidebarWidth,
		SIDEBAR_MIN_WIDTH,
		SIDEBAR_MAX_WIDTH,
	} from "../../stores/ui.svelte.js";
	import {
		connect,
		disconnect,
		onProjectAttached,
		wsState,
		onNavigateToSession,
		clearNavigateToSession,
		initSWNavigationListener,
		onPlanMode,
		onRewind,
		wsSend,
	} from "../../stores/ws.svelte.js";
	import { attachedProjectState, getCurrentRoute, getCurrentSessionId, getCurrentSearchParams, replaceRoute, routerState } from "../../stores/router.svelte.js";
	import { clearMessages } from "../../stores/chat.svelte.js";
	import { applyPtyListResponse, terminalState, destroyAll } from "../../stores/terminal.svelte.js";
	import { applyListSessionsResponse, clearSessionState, findSession, loadDaemonSessions, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { clearAllPermissions } from "../../stores/permissions.svelte.js";
	import { applyGetAgentsResponse, applyGetCommandsResponse, applyGetModelsResponse, clearDiscoveryState, discoveryState } from "../../stores/discovery.svelte.js";
	import { todoState, clearTodoState } from "../../stores/todo.svelte.js";
	import { applyGetFileTreeResponse, requestFileTree, clearFileTreeState } from "../../stores/file-tree.svelte.js";
	import { applyGetProjectsResponse } from "../../stores/project.svelte.js";
	import { FILES_PANE_MIN_WIDTH, isBarCollapsed, sessionViewState, setFilesOpen, setFilesPaneWidth, watchCompactViewport } from "../../stores/session-view.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { featureFlags, initFeatureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
	import { fetchCurrentVersion } from "../../stores/version.svelte.js";
	import type { RelayMessage } from "../../types.js";
	import { noteSessionOpened } from "../../stores/session-unread-hold.svelte.js";
	import DeepSearch from "../session/DeepSearch.svelte";

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
	/** Visual viewport height — tracks keyboard show/hide on mobile. */
	let vvHeight = $state<number | null>(null);
	let appEl: HTMLDivElement | undefined = $state(undefined);
	let chromeHeight = $state(0);
	let sessionListScrollTop = 0;
	let wasPhoneListScreen = false;

	// A phone shows one view. It is derived rather than stored, so crossing the
	// breakpoint never discards the desktop's open panes or file preview.
	const phoneView = $derived(sessionViewState.compact ? activeSessionView() : undefined);
	// On a phone the terminal is a whole view, never a split under the transcript.
	const mobileMaximized = $derived(phoneView === "terminal");

	const phoneListScreen = $derived.by(() => {
		const route = getCurrentRoute();
		return (
			sessionViewState.compact &&
			route.page === "chat" &&
			!route.sessionId &&
			!uiState.fileViewerOpen &&
			!mobileMaximized
		);
	});
	const topClearance = $derived(sessionViewState.compact && !phoneListScreen ? chromeHeight : 0);

	const layoutClass = $derived.by(() => {
		let cls = "flex h-dvh";
		if (uiState.sidebarCollapsed) cls += " sidebar-collapsed";
		if (sessionViewState.compact) cls += " layout-compact";
		if (phoneListScreen) cls += " phone-list-screen";
		return cls;
	});

	// Some browsers zero a scroller when an ancestor becomes display:none. Save
	// before the route class hides the sidebar, then restore after it is shown.
	$effect.pre(() => {
		const active = phoneListScreen;
		if (wasPhoneListScreen && !active) {
			const scroller = document.getElementById("session-list-scroller");
			if (scroller) sessionListScrollTop = scroller.scrollTop;
		}
	});

	$effect(() => {
		const active = phoneListScreen;
		if (active && !wasPhoneListScreen) {
			const scroller = document.getElementById("session-list-scroller");
			if (scroller) scroller.scrollTop = sessionListScrollTop;
		}
		wasPhoneListScreen = active;
	});

	// ─── Sidebar resize state ─────────────────────────────────────────────

	let isSidebarResizing = $state(false);
	const CHAT_MIN_WIDTH = 360;
	const FILES_DIVIDER_WIDTH = 6;
	let paneRowEl: HTMLDivElement | undefined = $state(undefined);
	let paneRowWidth = $state(0);
	let isPaneResizing = $state(false);
	let paneDrag: { pointerId: number; startX: number; startWidth: number } | null = null;
	const paneMaxWidth = $derived(Math.max(FILES_PANE_MIN_WIDTH, paneRowWidth - FILES_DIVIDER_WIDTH - CHAT_MIN_WIDTH));
	const paneDefaultWidth = $derived(Math.max(FILES_PANE_MIN_WIDTH, Math.min(640, paneRowWidth * 0.4)));
	const paneWidth = $derived(Math.min(paneMaxWidth, sessionViewState.filesPaneWidth ?? paneDefaultWidth));
	const filesPaneForcedExpanded = $derived(!sessionViewState.compact && sessionViewState.filesOpen && paneRowWidth < CHAT_MIN_WIDTH + FILES_DIVIDER_WIDTH + FILES_PANE_MIN_WIDTH);
	const filesPaneExpanded = $derived(!sessionViewState.compact && sessionViewState.filesOpen && (sessionViewState.filesPaneExpanded || filesPaneForcedExpanded));

	$effect(() => {
		if (!paneRowEl) return;
		const measure = () => { paneRowWidth = paneRowEl?.clientWidth ?? 0; };
		measure();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure);
			return () => window.removeEventListener("resize", measure);
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) paneRowWidth = entry.contentRect.width;
		});
		observer.observe(paneRowEl);
		return () => observer.disconnect();
	});

	function closeFilesPane() {
		setFilesOpen(false);
		closeFileViewer();
		void tick().then(() => document.querySelector<HTMLButtonElement>('[data-testid="views-rail-files"]')?.focus({ preventScroll: true }));
	}

	function toggleFilesPaneExpanded() {
		sessionViewState.filesPaneExpanded = !filesPaneExpanded;
		void tick().then(() => document.getElementById("files-pane-expand")?.focus({ preventScroll: true }));
	}

	function handlePanePointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		paneDrag = { pointerId: event.pointerId, startX: event.clientX, startWidth: paneWidth };
		isPaneResizing = true;
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
	}

	function handlePanePointerMove(event: PointerEvent) {
		if (!paneDrag || event.pointerId !== paneDrag.pointerId) return;
		setFilesPaneWidth(Math.min(paneMaxWidth, Math.max(FILES_PANE_MIN_WIDTH, paneDrag.startWidth + paneDrag.startX - event.clientX)));
	}

	function handlePanePointerEnd(event: PointerEvent) {
		if (!paneDrag || event.pointerId !== paneDrag.pointerId) return;
		paneDrag = null;
		isPaneResizing = false;
		if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	}

	function handlePaneKeydown(event: KeyboardEvent) {
		let width: number;
		switch (event.key) {
			case "ArrowLeft": width = paneWidth + 16; break;
			case "ArrowRight": width = paneWidth - 16; break;
			case "Home": width = FILES_PANE_MIN_WIDTH; break;
			case "End": width = paneMaxWidth; break;
			default: return;
		}
		event.preventDefault();
		setFilesPaneWidth(Math.min(paneMaxWidth, Math.max(FILES_PANE_MIN_WIDTH, width)));
	}

	function dragPoint(e: MouseEvent | TouchEvent) {
		const point = "touches" in e ? e.touches[0] : e;
		return { x: point?.clientX ?? 0, y: point?.clientY ?? 0 };
	}

	/** Follows a mouse or touch drag on the document until it is released. */
	function trackDrag(
		onMove: (point: { x: number; y: number }) => void,
		onEnd: () => void,
	) {
		const move = (ev: MouseEvent | TouchEvent) => onMove(dragPoint(ev));
		const end = () => {
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", end);
			document.removeEventListener("touchmove", move);
			document.removeEventListener("touchend", end);
			onEnd();
		};
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", end);
		document.addEventListener("touchmove", move, { passive: false });
		document.addEventListener("touchend", end);
	}

	function handleSidebarResizeStart(e: MouseEvent | TouchEvent) {
		if (uiState.sidebarCollapsed) return;
		e.preventDefault();
		isSidebarResizing = true;
		const startX = dragPoint(e).x;
		const startW = uiState.sidebarWidth;
		trackDrag(
			({ x }) => setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startW + x - startX))),
			() => { isSidebarResizing = false; },
		);
	}

	function handleResizeStart(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		isResizing = true;
		const startY = dragPoint(e).y;
		const startH = terminalHeight;
		const maxH = (appEl?.clientHeight ?? window.innerHeight) * TERMINAL_MAX_RATIO;
		trackDrag(
			// Dragging up grows the terminal.
			({ y }) => { terminalHeight = Math.max(TERMINAL_MIN_HEIGHT, Math.min(maxH, startH + startY - y)); },
			() => {
				isResizing = false;
				try {
					localStorage.setItem(TERMINAL_STORAGE_KEY, String(Math.round(terminalHeight)));
				} catch {
					/* ignore */
				}
			},
		);
	}

	/**
	 * Touch-drag handler for the terminal tab bar (bottom-sheet pattern).
	 * Uses a movement threshold so taps on tabs/buttons still fire normally.
	 * Drags resize the terminal pixel-by-pixel. A full-screen phone terminal has
	 * no height to drag; the Views sheet is how you leave it.
	 */
	function handleTabBarTouchStart(e: TouchEvent) {
		if (mobileMaximized) return;
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

			terminalHeight = Math.max(
				TERMINAL_MIN_HEIGHT,
				Math.min(maxH, startH + delta),
			);
		}

		function onEnd() {
			document.removeEventListener("touchmove", onMove);
			document.removeEventListener("touchend", onEnd);
			if (isDragging) {
				isResizing = false;
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

	let requestedProject: string | null = null;
	onMount(() => {
		let previousSlug: string | null = null;
		let attachGeneration = 0;
		const unsubscribe = onProjectAttached((slug) => {
			if (requestedProject === slug) requestedProject = null;
			const generation = ++attachGeneration;
			if (slug !== previousSlug) {
				clearMessages();
				clearSessionState();
				clearAllPermissions();
				destroyAll();
				clearDiscoveryState();
				clearTodoState();
				clearFileTreeState();
				resetProjectUI();
				planModeData = { mode: null, content: "" };
				previousSlug = slug;
			}
			// Fetch current version for sidebar footer
			fetchCurrentVersion();
			// Request initial state from server
			// First page only. The cross-project read is keyset-paged now; the
			// sidebar's scroll sentinel asks for the rest.
			void loadDaemonSessions();
			void listSessionsRpc({ projectSlug: slug, roots: true })
				.then((response) => {
					if (generation === attachGeneration) applyListSessionsResponse(response);
				})
				.catch(() => {
					if (generation === attachGeneration) showToast("Failed to load sessions", { variant: "error" });
				});
			const routeSessionId = getCurrentSessionId();
			// With no session in the route, scope the agent fetch to the
			// client-persisted harness draft so the agent list matches the
			// picker's pre-creation selection after a reload.
			const draftInstanceId =
				routeSessionId == null ? discoveryState.selectedInstanceId : null;
			void getAgentsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
				...(draftInstanceId != null ? { instanceId: draftInstanceId } : {}),
			})
				.then((response) => {
					if (generation === attachGeneration) applyGetAgentsResponse(response);
				})
				.catch(() => undefined);
			void getModelsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
			})
				.then((response) => {
					if (generation === attachGeneration) applyGetModelsResponse(response);
				})
				.catch(() => undefined);
			void getCommandsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
			})
				.then((response) => {
					if (generation === attachGeneration) applyGetCommandsResponse(response);
				})
				.catch(() => undefined);
			void getProjectsRpc({ projectSlug: slug })
				.then((response) => {
					if (generation === attachGeneration) applyGetProjectsResponse(response);
				})
				.catch(() => {
					if (generation === attachGeneration) showToast("Failed to load projects", { variant: "error" });
				});
			requestFileTree();
			void getFileTreeRpc({ projectSlug: slug })
				.then((response) => {
					if (generation === attachGeneration) applyGetFileTreeResponse(response);
				})
				.catch(() => {
					if (generation === attachGeneration) showToast("Failed to load file tree", { variant: "error" });
				});
			void listPtysRpc({
				projectSlug: slug,
				originId: getBrowserClientId(),
			})
				.then((response) => {
					if (generation === attachGeneration) applyPtyListResponse(response);
				})
				.catch(() => undefined);
		});
		onNavigateToSession((sessionId) => switchToSession(sessionId));
		initSWNavigationListener();
		connect();
		return () => {
			attachGeneration++;
			unsubscribe();
			clearNavigateToSession();
			interruptStream();
			disconnect();
		};
	});

	// Project navigation requests attachment through RPC on the existing socket.
	// This also covers browser history and project-only links from every caller.
	const connected = $derived(
		wsState.status === "connected" || wsState.status === "processing",
	);
	$effect(() => {
		const route = getCurrentRoute();
		const projectHint = getCurrentSearchParams().get("p");
		if (!connected || route.page !== "chat") return;
		let cancelled = false;
		untrack(() => {
			if (!route.sessionId) {
				if (sessionState.currentId !== null) {
					sessionState.currentId = null;
					clearMessages();
					clearAllPermissions();
					clearTodoState();
				}
				if (projectHint && (projectHint !== attachedProjectState.slug || requestedProject !== null)) {
					requestedProject = projectHint;
					void attachProjectRpc({ projectSlug: projectHint, originId: getBrowserClientId() })
						.catch(() => { if (!cancelled) showToast("Failed to switch projects", { variant: "error" }); });
				}
				return;
			}
			if (route.sessionId === sessionState.currentId) return;
			const sessionId = route.sessionId;
			void resolveSessionRpc({ sessionId }).then(({ projectSlug }) => {
				if (cancelled) return;
				if (sessionState.currentId === sessionId) return;
				if (projectSlug === null) {
					routerState.sessionNotFound = true;
					replaceRoute("/");
					return;
				}
				return viewSessionRpc({ projectSlug, sessionId, originId: getBrowserClientId(), ...noteSessionOpened(sessionId) });
			}).catch(() => { if (!cancelled) showToast("Failed to open session", { variant: "error" }); });
		});
		return () => { cancelled = true; };
	});

	// ─── Effect runtime disposal on page unload ──────────────────────────────
	// iOS fires pagehide every time a standalone PWA is backgrounded, not only
	// on unload, and `persisted` is how the two are told apart. Disposing on a
	// background left the app mute on return: the message fiber was gone but the
	// socket was still open, so no close event fired and nothing reconnected.
	if (typeof window !== "undefined") {
		window.addEventListener("pagehide", (event) => {
			if (!event.persisted) void disposeRuntime();
		});
	}

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

	// A full-screen phone terminal has no room for the todo overlay.
	$effect(() => {
		if (mobileMaximized) window.dispatchEvent(new CustomEvent("todo:collapse"));
	});

	// One matchMedia listener for the whole app decides whether the session's
	// own bar replaces the global header. Kept here rather than in each consumer
	// so the chrome cannot disagree with itself about what "compact" means.
	$effect(() => watchCompactViewport());
	let paneSessionId = sessionState.currentId;
	$effect(() => {
		const sessionId = sessionState.currentId;
		if (sessionId !== paneSessionId) closeFileViewer();
		paneSessionId = sessionId;
	});


	// ─── Visual viewport tracking (keyboard avoidance when terminal is open) ──
	// CSS dvh does NOT account for the virtual keyboard. We listen to the
	// visualViewport API and constrain #app height so the terminal stays above
	// the keyboard and xterm.js refits via its ResizeObserver.
	// Active whenever the phone terminal is showing.
	$effect(() => {
		if (!mobileMaximized) {
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

	// ─── QR modal event bridge (SessionBar dispatches "qr:show") ─────────────

	$effect(() => {
		function onQrShow() {
			qrVisible = true;
		}
		window.addEventListener("qr:show", onQrShow);
		return () => window.removeEventListener("qr:show", onQrShow);
	});

	// ─── Settings panel event bridge (SessionBar dispatches "settings:open") ──

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

	$effect(() => {
		function handleViewShortcut(event: KeyboardEvent) {
			const view = matchSessionViewShortcut(event);
			if (!view || event.defaultPrevented) return;
			event.preventDefault();
			if (sessionState.currentId && !view.disabled) view.select();
		}
		window.addEventListener("keydown", handleViewShortcut);
		return () => window.removeEventListener("keydown", handleViewShortcut);
	});

	// ─── Show debug panel when feature flag enabled ────────────────────────────
	$effect(() => {
		if (featureFlags.debug) {
			debugPanelVisible = true;
		}
	});

	// ─── Debug panel toggle event (from SessionBar menu) ───────────────────────
	$effect(() => {
		function onDebugToggle() {
			debugPanelVisible = !debugPanelVisible;
		}
		window.addEventListener("debug:toggle", onDebugToggle);
		return () => window.removeEventListener("debug:toggle", onDebugToggle);
	});
</script>

<div id="layout" class={layoutClass}>
	<!--
		iOS 26 paints a progressive blur under the status bar unless WebKit finds an
		opaque fixed or sticky box at the top edge (hit-tested at x = width/2, y = 0).
		Both phone top bars are static, so this strip stands in for them. Same colour
		as the bars, so it is invisible; compact-only, styled in style.css.
	-->
	<div id="compact-top-edge" aria-hidden="true"></div>

	<!-- Fixed and full-viewport, so it lives outside #app: the phone list screen
	     hides #app but still needs to show the connection state. -->
	<ConnectOverlay />

	<!-- Sidebar stays mounted so list state survives route changes. -->
	<Sidebar listScreen={phoneListScreen} />

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
		class:phone-session={sessionViewState.compact && !phoneListScreen}
		class:select-none={isResizing || isSidebarResizing || isPaneResizing}
		style={vvHeight ? `height: ${vvHeight}px;` : ""}
	>
		<div id="session-chrome" bind:offsetHeight={chromeHeight}>
			<!-- The list screen has its own bar in Sidebar; keep one session bar
			     mounted across breakpoint changes so its state follows the viewport. -->
			{#if !phoneListScreen}<SessionBar />{/if}

			<!-- Banners (update available, skip permissions, etc.). The phone list
			     screen hides #app, so Sidebar shows them there instead. -->
			{#if !phoneListScreen}<Banners />{/if}

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
		</div>

		<!-- Keep the transcript mounted and sized beneath phone views so its scrollTop survives. -->
		<div class="relative flex flex-1 min-h-0 min-w-0" style={`--phone-chrome-clearance: ${topClearance}px`}>
			<div bind:this={paneRowEl} class="relative flex flex-1 min-h-0 min-w-0">
				<!-- Lift horizontal clipping while the in-DOM 404px model picker overhangs a narrow chat column. -->
				<div id="chat-area" class="flex flex-col flex-1 min-h-0 min-w-0 has-[#model-picker]:overflow-x-visible" class:overflow-x-clip={!sessionViewState.compact && sessionViewState.filesOpen && !filesPaneExpanded} class:relative={!filesPaneExpanded} class:absolute={filesPaneExpanded} class:inset-0={filesPaneExpanded} class:invisible={filesPaneExpanded} class:island-transcript={isBarCollapsed() && phoneView === "chat"} inert={filesPaneExpanded} style:min-width={!sessionViewState.compact && sessionViewState.filesOpen && !filesPaneExpanded ? `${CHAT_MIN_WIDTH}px` : undefined}>
					<div class="flex flex-col flex-1 min-h-0" class:invisible={mobileMaximized} inert={phoneView === "files" || mobileMaximized}>
						<MessageList {topClearance} />
						<InputArea />
					</div>
					{#if sessionViewState.compact && sessionViewState.filesEverOpened}
						<div class="absolute inset-0 z-10 flex min-h-0 bg-bg-surface" class:invisible={phoneView !== "files"} inert={phoneView !== "files"} style:padding-top="var(--phone-chrome-clearance)">
							<SidebarFilePanel onClose={() => { setFilesOpen(false); }} />
						</div>
					{/if}

					<!-- Terminal Panel (resizable bottom panel) -->
					{#if terminalState.panelOpen}
						<!-- Resize handle (a full-screen phone terminal has no height to resize) -->
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
						<div class={mobileMaximized ? "absolute inset-0 z-20 flex min-h-0 flex-col bg-bg-surface" : "shrink-0 min-h-0"} style={mobileMaximized ? "padding-top: var(--phone-chrome-clearance);" : `height: ${terminalHeight}px;`}>
							<TerminalPanel onTabBarTouchStart={handleTabBarTouchStart} />
						</div>
					{/if}
				</div>
				{#if !sessionViewState.compact && sessionViewState.filesOpen}
					{#snippet paneTitle()}
						<span id="files-pane-title" class="ml-1.5 shrink-0 text-xs font-semibold text-text-muted">Files</span>
						{#if uiState.fileViewerOpen && uiState.fileViewerPath}
							<span class="min-w-0 truncate rounded-full border border-border-subtle bg-bg-alt px-2 py-0.5 font-mono text-xs text-text-muted" dir="rtl" title={uiState.fileViewerPath}>{uiState.fileViewerPath}</span>
						{/if}
					{/snippet}
					{#snippet paneActions()}
						<Button id="files-pane-expand" variant={uiState.fileViewerOpen ? "ghost" : "toolbar"} size="content" tone={uiState.fileViewerOpen ? "muted" : "dimmer"} hoverFill="overlay" class="h-6 w-6 shrink-0 rounded-md" iconOnly icon={filesPaneExpanded ? "minimize" : "maximize"} iconSize={uiState.fileViewerOpen ? 16 : 14} ariaLabel={filesPaneForcedExpanded ? "Not enough room to show chat beside Files" : filesPaneExpanded ? "Restore Files pane" : "Expand Files pane"} title={filesPaneForcedExpanded ? "Not enough room to show chat beside Files" : filesPaneExpanded ? "Restore Files pane" : "Expand Files pane"} aria-pressed={filesPaneExpanded} disabled={filesPaneForcedExpanded} onclick={toggleFilesPaneExpanded} />
						<Button variant={uiState.fileViewerOpen ? "ghost" : "toolbar"} size="content" tone={uiState.fileViewerOpen ? "muted" : "dimmer"} hoverFill="overlay" class="h-6 w-6 shrink-0 rounded-md" iconOnly icon="x" iconSize={uiState.fileViewerOpen ? 16 : 14} ariaLabel="Close Files pane" title="Close Files pane" onclick={closeFilesPane} />
					{/snippet}
					{#if !filesPaneExpanded}
						<Button
							variant="toolbar"
							size="content"
							tone="inherit"
							hoverFill="none"
							type="button"
							role="separator"
							aria-orientation="vertical"
							ariaLabel="Resize Files pane"
							aria-valuemin={FILES_PANE_MIN_WIDTH}
							aria-valuemax={paneMaxWidth}
							aria-valuenow={paneWidth}
							aria-valuetext={`${paneWidth}px`}
							tabindex={0}
							class="group relative z-10 w-1.5 shrink-0 cursor-col-resize aria-[orientation=vertical]:cursor-col-resize touch-none rounded-none after:absolute after:inset-y-0 after:-inset-x-px after:content-[''] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-text"
							onpointerdown={handlePanePointerDown}
							onpointermove={handlePanePointerMove}
							onpointerup={handlePanePointerEnd}
							onpointercancel={handlePanePointerEnd}
							onlostpointercapture={handlePanePointerEnd}
							onkeydown={handlePaneKeydown}
						><span aria-hidden="true" class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors {isPaneResizing ? 'bg-accent' : 'bg-border hover:bg-accent/50 group-hover:bg-accent/50 group-focus-visible:bg-accent'}"></span></Button>
					{/if}
					<div data-testid="side-pane-files" aria-labelledby="files-pane-title" class="relative flex shrink-0 min-h-0 min-w-0 flex-col bg-bg-surface" style:flex={filesPaneExpanded ? "1 1 0%" : "0 0 auto"} style:width={filesPaneExpanded ? undefined : `${paneWidth}px`}>
						<div class="relative flex flex-1 min-h-0" class:invisible={uiState.fileViewerOpen} inert={uiState.fileViewerOpen}>
							<SidebarFilePanel pane paneTitle={uiState.fileViewerOpen ? undefined : paneTitle} paneActions={uiState.fileViewerOpen ? undefined : paneActions} onClose={closeFilesPane} />
						</div>
						{#if uiState.fileViewerOpen}<div class="absolute inset-0 flex min-h-0"><FileViewer pane {paneTitle} {paneActions} visible onClose={closeFileViewer} /></div>{/if}
					</div>
				{/if}
			</div>
			<ViewsRail />
		</div>

		<!-- Info Panels (absolute positioned floating panels) -->
		<InfoPanels />
	</div>
	<!-- /#app -->

	<!-- The phone preview remains a full-screen overlay. -->
	{#if sessionViewState.compact}
		<FileViewer visible={phoneView === "files" && uiState.fileViewerOpen} onClose={closeFileViewer} overlay />
	{/if}
</div>
<!-- /#layout -->

<!-- Global overlays + notification stack (outside layout for proper z-index stacking) -->
<ImageLightbox />
<NotificationStack />
<DeepSearch />
<QrModal visible={qrVisible} onClose={handleQrClose} />
<SettingsPanel visible={settingsVisible} initialTab={settingsInitialTab} onClose={() => (settingsVisible = false)} />
{#if featureFlags.debug}
	<DebugPanel visible={debugPanelVisible} onClose={() => (debugPanelVisible = false)} />
{/if}
