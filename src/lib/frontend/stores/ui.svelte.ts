// Global UI state: sidebar, modals, toasts, scroll, rewind, plan mode, banners.

import type { ProjectSetting } from "../transport/ws-rpc.js";
import type { BannerConfig, PanelId, Toast, ToastCard } from "../types.js";
import { generateUuid } from "../utils/format.js";

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";
const SETTLED_SHELF_STORAGE_KEY = "settled-shelf-open";
const SNOOZED_SHELF_STORAGE_KEY = "snoozed-shelf-open";
const SIDEBAR_WIDTH_KEY = "sidebar-width";

/** Safe localStorage.getItem that returns null in non-browser environments. */
function safeGetItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const uiState = $state({
	// Sidebar
	sidebarCollapsed: safeGetItem(SIDEBAR_STORAGE_KEY) === "true",
	settledShelfOpen: safeGetItem(SETTLED_SHELF_STORAGE_KEY) === "true",
	snoozedShelfOpen: safeGetItem(SNOOZED_SHELF_STORAGE_KEY) === "true",
	// Cleanup and bulk settle share one row-selection mode, entered from either sidebar surface.
	selectMode: false,
	sidebarWidth: Number(safeGetItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT_WIDTH,

	// Toasts
	toasts: [] as Toast[],

	// Confirm dialog
	confirmDialog: null as {
		text: string;
		actionLabel: string;
		returnFocus?: () => HTMLElement | null;
		resolve: (result: boolean) => void;
	} | null,

	// Info panels
	openPanels: new Set<PanelId>(),

	// Banners
	banners: [] as BannerConfig[],
	/** Each OpenCode instance's lifecycle state, by instance id. */
	opencodeConnections: {} as Record<
		string,
		Extract<ProjectSetting, { _tag: "opencodeConnection" }>["status"]
	>,

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

	// File preview
	fileViewerOpen: false,
	fileViewerPath: null as string | null,
});

// Components should wrap in $derived() for reactive caching.

/** Get the context bar color class based on usage percentage. */
export function getContextColor(): string {
	if (uiState.contextPercent >= 80) return "ctx-red";
	if (uiState.contextPercent >= 50) return "ctx-yellow";
	if (uiState.contextPercent > 0) return "ctx-green";
	return "";
}

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

type ToastShorthandOptions = Pick<ToastCard, "duration" | "variant"> & {
	action?: { label: string; run: () => void };
};

/**
 * Show a toast card. The one-line form is shorthand for a card with only a
 * title, its inline `action` becoming the card's primary action.
 */
export function showToast(
	message: string,
	options?: ToastShorthandOptions,
): void;
export function showToast(card: ToastCard): void;
export function showToast(
	input: string | ToastCard,
	options: ToastShorthandOptions = {},
): void {
	const { action, ...rest } = options;
	const card: ToastCard =
		typeof input === "string"
			? {
					...rest,
					title: input,
					...(action ? { actions: [{ ...action, kind: "primary" }] } : {}),
				}
			: input;
	const toast: Toast = {
		...card,
		id: generateUuid(),
		actions: card.actions ?? [],
		variant: card.variant ?? "default",
		duration: card.duration ?? 7000,
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

/**
 * Show a confirm dialog. Returns a promise that resolves to true (confirm)
 * or false (cancel).
 */
export function confirm(
	text: string,
	actionLabel = "Confirm",
	returnFocus?: () => HTMLElement | null,
): Promise<boolean> {
	return new Promise((resolve) => {
		uiState.confirmDialog = {
			text,
			actionLabel,
			resolve,
			...(returnFocus ? { returnFocus } : {}),
		};
	});
}

export function resolveConfirm(result: boolean): void {
	if (uiState.confirmDialog) {
		uiState.confirmDialog.resolve(result);
		uiState.confirmDialog = null;
	}
}

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

export function showBanner(config: BannerConfig): void {
	// Don't duplicate
	if (uiState.banners.some((b) => b.id === config.id)) return;
	uiState.banners = [...uiState.banners, config];
}

export function removeBanner(id: string): void {
	uiState.banners = uiState.banners.filter((b) => b.id !== id);
}

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

export function openLightbox(src: string): void {
	uiState.lightboxSrc = src;
}

export function closeLightbox(): void {
	uiState.lightboxSrc = null;
}

export function openFileViewer(path: string): void {
	uiState.fileViewerOpen = true;
	uiState.fileViewerPath = path;
}

export function closeFileViewer(): void {
	uiState.fileViewerOpen = false;
	uiState.fileViewerPath = null;
}

export function updateContextPercent(percent: number): void {
	uiState.contextPercent = Math.max(0, Math.min(100, percent));
}

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
	uiState.fileViewerOpen = false;
	uiState.fileViewerPath = null;
	uiState.openPanels = new Set();
	uiState.banners = [];
	uiState.opencodeConnections = {};
}
