// ─── UI Store ────────────────────────────────────────────────────────────────
// Global UI state: sidebar, modals, toasts, scroll, rewind, plan mode, banners.

import type { BannerConfig, PanelId, Toast, ToastVariant } from "../types.js";
import { generateUuid } from "../utils/format.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";
const SETTLED_SHELF_STORAGE_KEY = "settled-shelf-open";
const SNOOZED_SHELF_STORAGE_KEY = "snoozed-shelf-open";
const SIDEBAR_WIDTH_KEY = "sidebar-width";
const FILE_VIEWER_WIDTH_KEY = "file-viewer-width";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safe localStorage.getItem that returns null in non-browser environments. */
function safeGetItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const FILE_VIEWER_DEFAULT_WIDTH = 50; // percentage of layout
export const FILE_VIEWER_MIN_WIDTH = 20; // percentage
export const FILE_VIEWER_MAX_WIDTH = 70; // percentage
// ─── State ──────────────────────────────────────────────────────────────────

export const uiState = $state({
	// Sidebar
	sidebarCollapsed: safeGetItem(SIDEBAR_STORAGE_KEY) === "true",
	settledShelfOpen: safeGetItem(SETTLED_SHELF_STORAGE_KEY) === "true",
	snoozedShelfOpen: safeGetItem(SNOOZED_SHELF_STORAGE_KEY) === "true",
	sidebarPanel: "sessions" as "sessions" | "files",
	sidebarWidth: Number(safeGetItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT_WIDTH,

	// Toasts
	toasts: [] as Toast[],

	// Confirm dialog
	confirmDialog: null as {
		text: string;
		actionLabel: string;
		resolve: (result: boolean) => void;
	} | null,

	// Info panels
	openPanels: new Set<PanelId>(),

	// Banners
	banners: [] as BannerConfig[],

	// Rewind mode
	rewindActive: false,
	rewindSelectedUuid: null as string | null,

	// Plan mode
	planMode: false,
	planContent: null as string | null,
	planApproval: null as {
		onApprove: () => void;
		onReject: () => void;
	} | null,

	// Image lightbox
	lightboxSrc: null as string | null,

	// Context usage
	contextPercent: 0,

	// Client count
	clientCount: 0,

	// File viewer (split pane)
	fileViewerOpen: false,
	fileViewerPath: null as string | null,
	fileViewerWidth:
		Number(safeGetItem(FILE_VIEWER_WIDTH_KEY)) || FILE_VIEWER_DEFAULT_WIDTH,
});

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the context bar color class based on usage percentage. */
export function getContextColor(): string {
	if (uiState.contextPercent >= 80) return "ctx-red";
	if (uiState.contextPercent >= 50) return "ctx-yellow";
	if (uiState.contextPercent > 0) return "ctx-green";
	return "";
}

// ─── Sidebar actions ────────────────────────────────────────────────────────

export function collapseSidebar(): void {
	uiState.sidebarCollapsed = true;
	localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
}

export function expandSidebar(): void {
	uiState.sidebarCollapsed = false;
	localStorage.setItem(SIDEBAR_STORAGE_KEY, "false");
}

export function toggleSidebar(): void {
	if (uiState.sidebarCollapsed) {
		expandSidebar();
	} else {
		collapseSidebar();
	}
}

export function setSidebarPanel(panel: "sessions" | "files"): void {
	uiState.sidebarPanel = panel;
}

export function setSidebarWidth(width: number): void {
	const clamped = Math.max(
		SIDEBAR_MIN_WIDTH,
		Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)),
	);
	uiState.sidebarWidth = clamped;
	try {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
	} catch {
		/* ignore */
	}
}

export function setSettledShelfOpen(open: boolean): void {
	uiState.settledShelfOpen = open;
	try {
		localStorage.setItem(SETTLED_SHELF_STORAGE_KEY, String(open));
	} catch {
		/* Storage may be unavailable; keep the in-memory preference. */
	}
}

export function setSnoozedShelfOpen(open: boolean): void {
	uiState.snoozedShelfOpen = open;
	try {
		localStorage.setItem(SNOOZED_SHELF_STORAGE_KEY, String(open));
	} catch {
		/* Storage may be unavailable; keep the in-memory preference. */
	}
}

// ─── Toast actions ──────────────────────────────────────────────────────────

export function showToast(
	message: string,
	options?: {
		duration?: number;
		variant?: ToastVariant;
		action?: Toast["action"];
	},
): void {
	const toast: Toast = {
		id: generateUuid(),
		message,
		variant: options?.variant ?? "default",
		duration: options?.duration ?? 7000,
		...(options?.action ? { action: options.action } : {}),
	};
	uiState.toasts = [...uiState.toasts, toast];

	// Auto-dismiss
	setTimeout(() => {
		dismissToast(toast.id);
	}, toast.duration);
}

export function dismissToast(id: string): void {
	uiState.toasts = uiState.toasts.filter((t) => t.id !== id);
}

// ─── Confirm dialog ─────────────────────────────────────────────────────────

/**
 * Show a confirm dialog. Returns a promise that resolves to true (confirm)
 * or false (cancel).
 */
export function confirm(
	text: string,
	actionLabel = "Confirm",
): Promise<boolean> {
	return new Promise((resolve) => {
		uiState.confirmDialog = { text, actionLabel, resolve };
	});
}

export function resolveConfirm(result: boolean): void {
	if (uiState.confirmDialog) {
		uiState.confirmDialog.resolve(result);
		uiState.confirmDialog = null;
	}
}

// ─── Info panel actions ─────────────────────────────────────────────────────

export function openPanel(id: PanelId): void {
	uiState.openPanels = new Set([...uiState.openPanels, id]);
}

export function closePanel(id: PanelId): void {
	const next = new Set(uiState.openPanels);
	next.delete(id);
	uiState.openPanels = next;
}

export function closeAllPanels(): void {
	uiState.openPanels = new Set();
}

export function togglePanel(id: PanelId): void {
	if (uiState.openPanels.has(id)) {
		closePanel(id);
	} else {
		openPanel(id);
	}
}

// ─── Banner actions ─────────────────────────────────────────────────────────

export function showBanner(config: BannerConfig): void {
	// Don't duplicate
	if (uiState.banners.some((b) => b.id === config.id)) return;
	uiState.banners = [...uiState.banners, config];
}

export function removeBanner(id: string): void {
	uiState.banners = uiState.banners.filter((b) => b.id !== id);
}

// ─── Rewind actions ─────────────────────────────────────────────────────────

export function enterRewindMode(): void {
	uiState.rewindActive = true;
	uiState.rewindSelectedUuid = null;
}

export function exitRewindMode(): void {
	uiState.rewindActive = false;
	uiState.rewindSelectedUuid = null;
}

export function selectRewindMessage(uuid: string | null): void {
	uiState.rewindSelectedUuid = uuid;
}

// ─── Plan mode actions ──────────────────────────────────────────────────────

export function enterPlanMode(): void {
	uiState.planMode = true;
}

export function exitPlanMode(): void {
	uiState.planMode = false;
	uiState.planContent = null;
	uiState.planApproval = null;
}

export function setPlanContent(content: string): void {
	uiState.planContent = content;
}

export function setPlanApproval(
	onApprove: () => void,
	onReject: () => void,
): void {
	uiState.planApproval = { onApprove, onReject };
}

// ─── Lightbox actions ───────────────────────────────────────────────────────

export function openLightbox(src: string): void {
	uiState.lightboxSrc = src;
}

export function closeLightbox(): void {
	uiState.lightboxSrc = null;
}

// ─── File viewer actions ────────────────────────────────────────────────────

export function openFileViewer(path: string): void {
	uiState.fileViewerOpen = true;
	uiState.fileViewerPath = path;
}

export function closeFileViewer(): void {
	uiState.fileViewerOpen = false;
	uiState.fileViewerPath = null;
}

export function setFileViewerWidth(widthPercent: number): void {
	const clamped = Math.max(
		FILE_VIEWER_MIN_WIDTH,
		Math.min(FILE_VIEWER_MAX_WIDTH, Math.round(widthPercent)),
	);
	uiState.fileViewerWidth = clamped;
	try {
		localStorage.setItem(FILE_VIEWER_WIDTH_KEY, String(clamped));
	} catch {
		/* ignore */
	}
}

// ─── Context usage ──────────────────────────────────────────────────────────

export function updateContextPercent(percent: number): void {
	uiState.contextPercent = Math.max(0, Math.min(100, percent));
}

// ─── Client count ───────────────────────────────────────────────────────────

export function setClientCount(count: number): void {
	uiState.clientCount = count;
}

/** Reset transient per-session UI state (for project switch). */
export function resetProjectUI(): void {
	uiState.rewindActive = false;
	uiState.rewindSelectedUuid = null;
	uiState.planMode = false;
	uiState.planContent = null;
	uiState.planApproval = null;
	uiState.lightboxSrc = null;
	uiState.contextPercent = 0;
	uiState.sidebarPanel = "sessions";
	uiState.fileViewerOpen = false;
	uiState.fileViewerPath = null;
	uiState.openPanels = new Set();
	uiState.banners = [];
}
