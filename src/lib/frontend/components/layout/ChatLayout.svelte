<!-- Session list and chat: Sidebar + SessionBar + Messages + Input. -->
<!-- Wires all feature/overlay components into the layout hierarchy. -->
<!-- Preserves element IDs and class names for E2E test compatibility. -->

<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from "svelte";
	import { Effect } from "effect";
	import { getScopeGroupKey } from "../../../session-scope.js";
	import { disposeRuntime, runTransportEffect } from "../../transport/runtime.js";
	import { WsRpcClients } from "../../transport/shared-client.js";
	import { attachProjectRpc, resolveSessionRpc, getAgentsRpc, getCommandsRpc, getFileTreeRpc, getModelsRpc, getProjectsRpc } from "../../transport/ws-rpc-client.js";
	import SessionBar from "./SessionBar.svelte";
	import ViewsRail from "./ViewsRail.svelte";
	import { taskDrawer } from "../session/background-tasks.svelte.js";
	import { activeSessionView, matchSessionViewShortcut } from "./session-views.js";
	import Sidebar from "./Sidebar.svelte";
	import InputArea from "../input/InputArea.svelte";
	import ProjectSquare from "../session/ProjectSquare.svelte";
	import { projectAccent, projectDisplayName } from "../session/session-list-project.js";
	import MessageList from "../chat/MessageList.svelte";
	import ConnectOverlay from "../overlays/ConnectOverlay.svelte";
	import Banners from "../overlays/Banners.svelte";
	import NotificationStack from "../overlays/NotificationStack.svelte";
	import ImageLightbox from "../overlays/ImageLightbox.svelte";
	import type { SettingsOpenDetail, SettingsSection } from "./chrome-actions.js";
	import RewindBanner from "../overlays/RewindBanner.svelte";
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
		onNavigateToSession,
		clearNavigateToSession,
		initSWMessageListener,
		reconcilePushActive,
	} from "../../stores/ws-notifications.js";
	import { onProjectAttached } from "../../stores/ws-listeners.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { attachedProjectState, getCurrentRoute, getCurrentSessionId, getCurrentSlug, getCurrentSearchParams, replaceRoute, routerState } from "../../stores/router.svelte.js";
	import { clearMessages } from "../../stores/chat.svelte.js";
	import { terminalState, destroyAll, viewPtys } from "../../stores/terminal.svelte.js";
	import { clearSessionState, findSession, sessionState, setAttachedProject, switchToSession } from "../../stores/session.svelte.js";
	import { attachSessionList, detachSessionList, drawSavedShell, onShellSynchronized } from "../../stores/session-list.svelte.js";
	import { viewFamily } from "../../stores/session-family-feed.js";
	import { attachApprovals, detachApprovals } from "../../stores/approvals.js";
	import { drawSavedTranscript, leaveSavedDraw, placedSessionId, placeSavedDraw, savedDraw, viewTranscript } from "../../stores/transcript.svelte.js";
	import { openSavedTranscript } from "../../stores/saved-transcripts.js";
	import { openSavedShell } from "../../stores/saved-shell.js";
	import { applyGetAgentsResponse, applyGetCommandsResponse, followModelsRead, clearDiscoveryState, discoveryState, getEffectiveInstanceId, viewDraftModels } from "../../stores/discovery.svelte.js";
	import { instanceState } from "../../stores/instance.svelte.js";
	import { todoState, clearTodoState, viewTodos } from "../../stores/todo.svelte.js";
	import { viewProjectSettings } from "../../stores/project-settings.js";
	import { viewAlerts } from "../../stores/alerts.js";
	import { viewInputDraft } from "../../stores/input-draft.js";
	import { applyGetFileTreeResponse, requestFileTree, clearFileTreeState, fileTreeState } from "../../stores/file-tree.svelte.js";
	import { applyProjectList, followDaemonLists, getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
	import { FILES_PANE_MIN_WIDTH, isBarCollapsed, sessionViewState, setFilesOpen, setFilesPaneWidth, watchCompactViewport } from "../../stores/session-view.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { featureFlags, initFeatureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
	import { fetchCurrentVersion } from "../../stores/version.svelte.js";
	import {
		observeOpenSession,
		trackSeen,
	} from "../../utils/attention.js";

	let qrVisible = $state(false);
	let qrEverOpened = $state(false);
	let settingsVisible = $state(false);
	let settingsEverOpened = $state(false);
	let settingsInitialTab = $state<SettingsSection | undefined>();
	let settingsInitialAnchor = $state<SettingsOpenDetail["anchor"]>();
	let debugPanelVisible = $state(false);

	const TERMINAL_MIN_HEIGHT = 100;
	const TERMINAL_MAX_RATIO = 0.7; // 70% of parent height
	const TERMINAL_DEFAULT_HEIGHT = 300;
	const TERMINAL_STORAGE_KEY = "terminal-panel-height";
	const LAST_PROJECT_STORAGE_KEY = "conduit:last-attached-project";

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

	const draftSlug = $derived(getDraftProject());
	// Navigation can arrive while disconnected; it must wake the socket before
	// the placement effect's connected guard, without tracking connection state.
	$effect(() => {
		getCurrentRoute();
		getCurrentSearchParams();
		untrack(() => {
			void runTransportEffect(Effect.flatMap(WsRpcClients, (clients) => clients.wake));
		});
	});
	$effect(() => {
		const route = getCurrentRoute();
		const projectSlug = route.page === "chat" && route.draft && !sessionState.currentId &&
			(discoveryState.defaultsLoaded || discoveryState.hasInstanceChoice)
			? getDraftProject() : null;
		const instanceId = getEffectiveInstanceId();
		const instancesLoaded = instanceState.loaded;
		const attachedSlug = attachedProjectState.slug;
		untrack(() => viewDraftModels(
			projectSlug === attachedSlug && instancesLoaded ? projectSlug : null,
			instanceId,
		));
	});
	onDestroy(() => viewDraftModels(null));
	const commandSessionId = $derived(getCurrentSessionId());
	const commandWorkspace = $derived(JSON.stringify(commandSessionId ? findSession(commandSessionId)?.workspace ?? null : null));
	let previousCommandContext: { sessionId: string | null; workspace: string } | undefined;
	$effect(() => {
		const sessionId = commandSessionId;
		const workspace = commandWorkspace;
		const previous = previousCommandContext;
		previousCommandContext = { sessionId, workspace };
		// Selection and connect fetch commands; moves and leaving a session
		// also change which folder supplies the catalog.
		const moved = previous?.sessionId === sessionId && previous.workspace !== workspace;
		const leftSession = previous?.sessionId != null && sessionId === null;
		if (!moved && !leftSession) return;
		const projectSlug = attachedProjectState.slug;
		if (!projectSlug) return;
		let active = true;
		void getCommandsRpc({ projectSlug, ...(sessionId ? { sessionId } : {}) }).then((response) => {
			if (active) applyGetCommandsResponse(response);
		}).catch(() => undefined);
		return () => { active = false; };
	});

	const phoneListScreen = $derived.by(() => {
		const route = getCurrentRoute();
		return (
			sessionViewState.compact &&
			route.page === "chat" &&
			!route.sessionId &&
			!route.draft &&
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

	function filesPaneExpandLabel(): string {
		if (filesPaneForcedExpanded) return "Not enough room to show chat beside Files";
		if (filesPaneExpanded) return "Restore Files pane";
		return "Expand Files pane";
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

	// Todo items (the viewed session's todo subscription)

	const todoItems = $derived(todoState.items);
	let todoEverOpened = $state(false);
	let fileViewerEverOpened = $state(false);
	let deepSearchEverOpened = $state(false);
	$effect(() => {
		if (todoItems.length > 0) todoEverOpened = true;
		if (uiState.fileViewerOpen) fileViewerEverOpened = true;
	});

	function handleDeepSearchShortcut(event: KeyboardEvent): void {
		if (deepSearchEverOpened || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
		event.preventDefault();
		deepSearchEverOpened = true;
	}

	function handleQrClose() {
		qrVisible = false;
	}

	let requestedProject: string | null = null;
	// Each mount attaches once: a remount keeps the previous mount's slug.
	let attachedThisMount = false;
	onMount(() => {
		let attachGeneration = 0;
		const loadPath = routerState.path;
		const loadSearch = routerState.search;
		const loadProject = getCurrentSlug() ?? getDraftProject();
		let lastProject: string | null = null;
		try {
			lastProject = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
		} catch { /* device storage is optional */ }
		// A page load draws the session's saved page, if any, before any reply.
		const loadSessionId = getCurrentSessionId();
		const savedTranscript = loadSessionId
			? openSavedTranscript(loadSessionId)
			: Promise.resolve(undefined);
		if (loadSessionId)
			void savedTranscript.then((record) => {
				if (record && sessionState.currentId === null && getCurrentSessionId() === loadSessionId)
					drawSavedTranscript(record);
			});
		const readShell = (project: string | null | undefined) => {
			if (attachGeneration !== 0) return;
			if (!project) return;
			void openSavedShell(project).then((record) => {
				if (record && attachGeneration === 0 && routerState.path === loadPath && routerState.search === loadSearch)
					drawSavedShell(record);
			});
		};
		if (loadProject) readShell(loadProject);
		else void savedTranscript.then((transcript) => readShell(transcript?.project ?? lastProject));
		// A page load starts clean; only a change of project clears state.
		let previousSlug = attachedProjectState.slug;
		const unsubscribe = onProjectAttached((slug) => {
			if (requestedProject === slug) requestedProject = null;
			attachGeneration++;
			try {
				localStorage.setItem(LAST_PROJECT_STORAGE_KEY, slug);
			} catch { /* device storage is optional */ }
			if (previousSlug !== null && slug !== previousSlug) {
				clearMessages();
				clearSessionState();
				destroyAll();
				clearDiscoveryState();
				clearTodoState();
				clearFileTreeState();
				resetProjectUI();
			}
			previousSlug = slug;
			// Request initial state from server
			// First page only. The cross-project read is keyset-paged now; the
			// sidebar's scroll sentinel asks for the rest.
			attachSessionList(slug);
			attachApprovals(slug);
		});
		const unsubscribeShell = onShellSynchronized((slug) => {
			if (slug !== previousSlug) return;
			const generation = attachGeneration;
			const routeSessionId = getCurrentSessionId();
			const workspace = commandWorkspace;
			const draftInstanceId = routeSessionId == null ? getEffectiveInstanceId() : undefined;
			void getAgentsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
				...(draftInstanceId != null ? { instanceId: draftInstanceId } : {}),
			})
				.then((response) => {
					if (
						generation === attachGeneration &&
						getCurrentSessionId() === routeSessionId &&
						(routeSessionId != null || draftInstanceId === getEffectiveInstanceId())
					) applyGetAgentsResponse(response, routeSessionId ?? undefined);
				})
				.catch(() => undefined);
			const applyModels = followModelsRead(routeSessionId ?? undefined);
			void getModelsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
				...(draftInstanceId != null ? { instanceId: draftInstanceId } : {}),
			})
				.then((response) => {
					if (generation === attachGeneration && getCurrentSessionId() === routeSessionId && (routeSessionId != null || draftInstanceId === getEffectiveInstanceId())) applyModels(response);
				})
				.catch(() => undefined);
			void getCommandsRpc({
				projectSlug: slug,
				...(routeSessionId != null ? { sessionId: routeSessionId } : {}),
			})
				.then((response) => {
					if (generation === attachGeneration && commandSessionId === routeSessionId && commandWorkspace === workspace) applyGetCommandsResponse(response);
				})
				.catch(() => undefined);
			void getProjectsRpc({ projectSlug: slug })
				.then((response) => {
					if (generation === attachGeneration) applyProjectList(response);
				})
				.catch(() => {
					if (generation === attachGeneration) showToast("Failed to load projects", { variant: "error" });
				});
		});
		onNavigateToSession((sessionId) => switchToSession(sessionId));
		initSWMessageListener();
		return () => {
			attachGeneration++;
			detachSessionList();
			viewFamily("", null);
			detachApprovals();
			unsubscribe();
			unsubscribeShell();
			clearNavigateToSession();
		};
	});

	// Project navigation requests attachment through RPC on the existing socket.
	// This also covers browser history and project-only links from every caller.
	const connected = $derived(getIsConnected());
	const fileScope = $derived.by(() => {
		const slug = attachedProjectState.slug;
		const sessionId = getCurrentSessionId();
		const session = sessionId ? findSession(sessionId) : undefined;
		const folders = projectState.projects.find((project) => project.slug === slug)?.folders ?? [];
		const primary = folders[0] ?? "";
		const directory = effectiveWorkingDirectory(primary, session?.workspace);
		return JSON.stringify([slug, sessionId, directory, folders, session?.workspace]);
	});
	$effect(() => {
		const scope = fileScope;
		const slug = untrack(() => attachedProjectState.slug);
		const sessionId = untrack(getCurrentSessionId);
		if (!connected || !slug) return;
		let cancelled = false;
		untrack(() => {
			if (fileTreeState.scope !== scope) {
				clearFileTreeState();
				fileTreeState.scope = scope;
				closeFileViewer();
			}
			requestFileTree();
		});
		void getFileTreeRpc({ projectSlug: slug, ...(sessionId ? { sessionId } : {}) })
			.then((response) => {
				if (!cancelled) applyGetFileTreeResponse(response);
			})
			.catch(() => {
				if (!cancelled) {
					fileTreeState.loading = false;
					showToast("Failed to load file tree", { variant: "error" });
				}
			});
		return () => { cancelled = true; };
	});
	// A drawn session is viewed once the server has placed it.
	const placedId = $derived(placedSessionId());
	$effect(() => {
		const project = attachedProjectState.slug ?? "";
		const sessionId = project ? placedId : null;
		untrack(() => {
			viewTranscript(project, sessionId);
			viewTodos(project, sessionId);
			viewInputDraft(project, sessionId);
		});
		return () => {
			viewTranscript(project, null);
			viewTodos(project, null);
			viewInputDraft(project, null);
		};
	});
	// The task drawer belongs to the session it was opened from.
	$effect(() => {
		void sessionState.currentId;
		return () => {
			taskDrawer.task = null;
		};
	});
	$effect(() => {
		if (sessionViewState.compact) taskDrawer.task = null;
	});
	// No null cleanup: moving within a family keeps its subscription.
	$effect(() => {
		const project = attachedProjectState.slug ?? "";
		const sessionId = project ? placedId : null;
		untrack(() => viewFamily(project, sessionId));
	});
	$effect(() => {
		const project = attachedProjectState.slug ?? null;
		untrack(() => {
			viewPtys(project);
			viewProjectSettings(project);
			viewAlerts(project);
		});
		return () => {
			viewPtys(null);
			viewProjectSettings(null);
			viewAlerts(null);
		};
	});
	$effect(() => {
		followDaemonLists(true);
		return () => followDaemonLists(false);
	});
	// The version is daemon-wide, so it follows the connection, not the project:
	// a reconnect after a restart can be a new build.
	$effect(() => {
		if (connected) void fetchCurrentVersion();
	});
	$effect(() => {
		const route = getCurrentRoute();
		// A draft attaches the project it will be created in, so models and
		// commands match it before the first send.
		const scope = getCurrentSearchParams().get("p");
		const groupScope = getScopeGroupKey(scope) !== null;
		const projectHint = route.page === "chat" && route.draft ? getDraftProject() : groupScope ? null : scope;
		const attachedSlug = attachedProjectState.slug;
		untrack(() => leaveSavedDraw(route.page === "chat" ? route.sessionId : undefined));
		if (!connected || route.page !== "chat") return;
		let cancelled = false;
		untrack(() => {
			const placeSession = (sessionId: string, projectSlug: string | null) => {
				if (cancelled) return;
				if (sessionState.currentId === sessionId && savedDraw.sessionId !== sessionId) return;
				placeSavedDraw(sessionId, projectSlug);
				if (projectSlug === null) {
					routerState.sessionNotFound = true;
					replaceRoute("/");
					return;
				}
				switchToSession(sessionId, projectSlug);
			};
			// The server picks the project on a cold load (the session's, the hint,
			// else its default); afterwards only a project-only route switches it.
			if (!attachedThisMount || (groupScope && attachedSlug === null) || (!route.sessionId && projectHint && (projectHint !== attachedSlug || requestedProject !== null))) {
				requestedProject = projectHint ?? null;
				void attachProjectRpc({
					originId: getBrowserClientId(),
					...(projectHint ? { projectSlug: projectHint } : {}),
					...(route.sessionId ? { sessionId: route.sessionId } : {}),
				})
					.then(({ projectSlug, sessionSlug }) => {
						if (cancelled) return;
						requestedProject = null;
						if (projectSlug !== null) {
							attachedThisMount = true;
							setAttachedProject(projectSlug);
						}
						if (route.sessionId) placeSession(route.sessionId, sessionSlug);
					})
					.catch(() => { if (!cancelled) showToast("Failed to switch projects", { variant: "error" }); });
				if (route.sessionId) return;
			}
			if (!route.sessionId) {
				if (sessionState.currentId !== null) {
					sessionState.currentId = null;
					clearTodoState();
					if (attachedSlug && (!projectHint || projectHint === attachedSlug)) {
						const draftInstanceId = getEffectiveInstanceId();
						const applyModels = followModelsRead();
						void getModelsRpc({ projectSlug: attachedSlug, instanceId: draftInstanceId })
							.then(applyModels)
								.catch(() => undefined);
						void getAgentsRpc({
							projectSlug: attachedSlug,
							...(draftInstanceId != null ? { instanceId: draftInstanceId } : {}),
						})
							.then((response) => {
								if (
									sessionState.currentId === null &&
									getCurrentSessionId() === null &&
									attachedProjectState.slug === attachedSlug &&
									draftInstanceId === getEffectiveInstanceId()
								) applyGetAgentsResponse(response);
							})
							.catch(() => undefined);
					}
				}
				return;
			}
			if (!attachedSlug) return;
			if (route.sessionId === sessionState.currentId && savedDraw.sessionId !== route.sessionId) return;
			const sessionId = route.sessionId;
			void resolveSessionRpc({ sessionId, projectSlug: attachedSlug }).then(({ projectSlug }) => {
				placeSession(sessionId, projectSlug);
			}).catch(() => { if (!cancelled) showToast("Failed to open session", { variant: "error" }); });
		});
		return () => { cancelled = true; };
	});

	// iOS fires pagehide every time a standalone PWA is backgrounded, not only
	// on unload, and `persisted` is how the two are told apart. Disposing on a
	// background would leave the app with no RPC sockets or subscriptions on return.
	if (typeof window !== "undefined") {
		window.addEventListener("pagehide", (event) => {
			if (!event.persisted) void disposeRuntime();
		});
	}

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


	// Visual viewport tracking (keyboard avoidance when terminal is open)
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

		const onViewportResize = () => {
			vvHeight = Math.round(vv.height);
		};
		onViewportResize(); // capture initial height
		vv.addEventListener("resize", onViewportResize);
		return () => vv.removeEventListener("resize", onViewportResize);
	});

	// QR modal event bridge (SessionBar dispatches "qr:show")

	$effect(() => {
		function onQrShow() {
			qrEverOpened = true;
			qrVisible = true;
		}
		window.addEventListener("qr:show", onQrShow);
		return () => window.removeEventListener("qr:show", onQrShow);
	});

	// Settings panel event bridge (SessionBar dispatches "settings:open")

	$effect(() => {
		function onSettingsOpen(e: WindowEventMap["settings:open"]) {
			const detail = e.detail;
			// A generic open leaves this undefined: phone then starts on the section list.
			settingsInitialTab = detail?.section;
			settingsInitialAnchor = detail?.anchor;
			settingsEverOpened = true;
			settingsVisible = true;
		}
		window.addEventListener("settings:open", onSettingsOpen);
		return () => window.removeEventListener("settings:open", onSettingsOpen);
	});

	$effect(() => {
		initFeatureFlags();
	});

	// Debug keyboard shortcut (Ctrl/Cmd+Shift+D)
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

	// A dot marked unread holds against touches until the user switches away
	// (utils/attention.ts, conduit-test-hk9m.5).
	$effect(() => {
		observeOpenSession(sessionState.currentId ? findSession(sessionState.currentId) : undefined);
	});

	$effect(() => {
		if (featureFlags.debug) {
			debugPanelVisible = true;
		}
	});

	// Debug panel toggle event (from SessionBar menu)
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
			{#if todoEverOpened}
				{#await import("../todo/TodoOverlay.svelte") then { default: TodoOverlay }}
					<TodoOverlay items={todoItems} forceCollapsed={mobileMaximized} />
				{/await}
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
					<!-- Touches here clear the unread dot (conduit-test-hk9m.4). -->
					<div class="flex flex-col flex-1 min-h-0" class:invisible={mobileMaximized} inert={phoneView === "files" || mobileMaximized} {@attach trackSeen(sessionState.currentId)}>
						<MessageList {topClearance} />
						{#if !sessionState.currentId}
							<div class="pointer-events-none absolute inset-x-0 top-[28%] flex flex-col items-center gap-2.5 px-6 text-center font-brand" data-testid="draft-empty">
								{#if draftSlug}<ProjectSquare large label={projectDisplayName(draftSlug)} accent={projectAccent(draftSlug)} />{/if}
								<b class="text-[16px] font-semibold text-text">What should happen{draftSlug ? ` in ${projectDisplayName(draftSlug)}` : ""}?</b>
								<span class="text-[13px] text-text-dimmer">Nothing is created until you send.</span>
							</div>
						{/if}
						<RewindBanner pendingOnly />
						<InputArea />
					</div>
					{#if sessionViewState.compact && sessionViewState.filesEverOpened}
						<div class="absolute inset-0 z-10 flex min-h-0 bg-bg-surface" class:invisible={phoneView !== "files"} inert={phoneView !== "files"} style:padding-top="var(--phone-chrome-clearance)">
							{#await import("../file/SidebarFilePanel.svelte") then { default: SidebarFilePanel }}
								<SidebarFilePanel onClose={() => { setFilesOpen(false); }} />
							{/await}
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
							{#await import("../terminal/TerminalPanel.svelte") then { default: TerminalPanel }}
								<TerminalPanel folders={fileTreeState.roots} onTabBarTouchStart={handleTabBarTouchStart} />
							{/await}
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
						<Button id="files-pane-expand" variant={uiState.fileViewerOpen ? "ghost" : "toolbar"} size="content" tone={uiState.fileViewerOpen ? "muted" : "dimmer"} hoverFill="overlay" class="h-6 w-6 shrink-0 rounded-md" iconOnly icon={filesPaneExpanded ? "minimize" : "maximize"} iconSize={uiState.fileViewerOpen ? 16 : 14} ariaLabel={filesPaneExpandLabel()} title={filesPaneExpandLabel()} aria-pressed={filesPaneExpanded} disabled={filesPaneForcedExpanded} onclick={toggleFilesPaneExpanded} />
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
							{#await import("../file/SidebarFilePanel.svelte") then { default: SidebarFilePanel }}
								<SidebarFilePanel pane paneTitle={uiState.fileViewerOpen ? undefined : paneTitle} paneActions={uiState.fileViewerOpen ? undefined : paneActions} onClose={closeFilesPane} />
							{/await}
						</div>
						{#if uiState.fileViewerOpen}
							<div class="absolute inset-0 flex min-h-0">
								{#await import("../file/FileViewer.svelte") then { default: FileViewer }}
									<FileViewer pane {paneTitle} {paneActions} visible onClose={closeFileViewer} />
								{/await}
							</div>
						{/if}
					</div>
				{/if}
				{#if !sessionViewState.compact && taskDrawer.task}
					{#await import("../session/TaskDrawer.svelte") then { default: TaskDrawer }}
						<TaskDrawer task={taskDrawer.task} />
					{/await}
				{/if}
			</div>
			<ViewsRail />
		</div>

		<!-- Info Panels (absolute positioned floating panels) -->
		{#if uiState.openPanels.size > 0}
			{#await import("../overlays/InfoPanels.svelte") then { default: InfoPanels }}
				<InfoPanels />
			{/await}
		{/if}
	</div>
	<!-- /#app -->

	<!-- The phone preview remains a full-screen overlay. -->
	{#if sessionViewState.compact && fileViewerEverOpened}
		{#await import("../file/FileViewer.svelte") then { default: FileViewer }}
			<FileViewer visible={phoneView === "files" && uiState.fileViewerOpen} onClose={closeFileViewer} overlay />
		{/await}
	{/if}
</div>
<!-- /#layout -->

<!-- Global overlays + notification stack (outside layout for proper z-index stacking) -->
<ImageLightbox />
<NotificationStack />
<svelte:window onkeydown={handleDeepSearchShortcut} />
{#if deepSearchEverOpened}
	{#await import("../session/DeepSearch.svelte") then { default: DeepSearch }}
		<DeepSearch initiallyOpen />
	{/await}
{/if}
{#if qrEverOpened}
	{#await import("../overlays/QrModal.svelte") then { default: QrModal }}
		<QrModal visible={qrVisible} onClose={handleQrClose} />
	{/await}
{/if}
{#if settingsEverOpened}
	{#await import("../overlays/SettingsPanel.svelte") then { default: SettingsPanel }}
		<SettingsPanel visible={settingsVisible} initialTab={settingsInitialTab} initialAnchor={settingsInitialAnchor} onClose={() => (settingsVisible = false)} />
	{/await}
{/if}
{#if featureFlags.debug}
	{#await import("../debug/DebugPanel.svelte") then { default: DebugPanel }}
		<DebugPanel visible={debugPanelVisible} onClose={() => (debugPanelVisible = false)} />
	{/await}
{/if}
