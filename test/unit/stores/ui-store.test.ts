// ─── UI Store Tests ──────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE the store module is loaded.
// vi.hoisted runs before any imports are resolved.
const localStorageMock = vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	// Must be set immediately (before import resolution)
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
	return mock;
});

import {
	closePanel,
	collapseSidebar,
	confirm,
	dismissToast,
	enterPlanMode,
	enterRewindMode,
	exitPlanMode,
	exitRewindMode,
	expandSidebar,
	openPanel,
	removeBanner,
	resetProjectUI,
	resolveConfirm,
	setSidebarPanel,
	showBanner,
	showToast,
	togglePanel,
	toggleSidebar,
	uiState,
} from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { BannerConfig } from "../../../src/lib/frontend/types.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	// Reset UI state
	uiState.sidebarCollapsed = false;
	uiState.sidebarPanel = "sessions";
	uiState.mobileSidebarOpen = false;
	uiState.toasts = [];
	uiState.confirmDialog = null;
	uiState.openPanels = new Set();
	uiState.banners = [];
	uiState.rewindActive = false;
	uiState.rewindSelectedUuid = null;
	uiState.planMode = false;
	uiState.planContent = null;
	uiState.planApproval = null;
	uiState.lightboxSrc = null;
	uiState.contextPercent = 0;
	uiState.clientCount = 0;

	localStorageMock.clear();
	vi.clearAllMocks();
	vi.useFakeTimers();
});

// ─── Sidebar actions ────────────────────────────────────────────────────────

describe("collapseSidebar", () => {
	it("sets sidebarCollapsed to true", () => {
		collapseSidebar();
		expect(uiState.sidebarCollapsed).toBe(true);
	});

	it("persists to localStorage", () => {
		collapseSidebar();
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"sidebar-collapsed",
			"true",
		);
	});
});

describe("expandSidebar", () => {
	it("sets sidebarCollapsed to false", () => {
		uiState.sidebarCollapsed = true;
		expandSidebar();
		expect(uiState.sidebarCollapsed).toBe(false);
	});

	it("persists to localStorage", () => {
		expandSidebar();
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"sidebar-collapsed",
			"false",
		);
	});
});

describe("toggleSidebar", () => {
	it("collapses when expanded", () => {
		uiState.sidebarCollapsed = false;
		toggleSidebar();
		expect(uiState.sidebarCollapsed).toBe(true);
	});

	it("expands when collapsed", () => {
		uiState.sidebarCollapsed = true;
		toggleSidebar();
		expect(uiState.sidebarCollapsed).toBe(false);
	});
});

// ─── Toast actions ──────────────────────────────────────────────────────────

describe("showToast", () => {
	it("adds a toast with default options", () => {
		showToast("Hello");
		expect(uiState.toasts).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.message).toBe("Hello");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.variant).toBe("default");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.duration).toBe(7000);
	});

	it("accepts custom options", () => {
		showToast("Warning", { duration: 5000, variant: "warn" });
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.variant).toBe("warn");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.duration).toBe(5000);
	});

	it("auto-dismisses after duration", () => {
		showToast("Temp", { duration: 1000 });
		expect(uiState.toasts).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(uiState.toasts).toHaveLength(0);
	});
});

describe("dismissToast", () => {
	it("removes toast by id", () => {
		showToast("A");
		showToast("B");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const idToRemove = uiState.toasts[0]!.id;
		dismissToast(idToRemove);
		expect(uiState.toasts).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.toasts[0]!.message).toBe("B");
	});
});

// ─── Confirm dialog ─────────────────────────────────────────────────────────

describe("confirm", () => {
	it("sets confirmDialog state", () => {
		confirm("Are you sure?");
		expect(uiState.confirmDialog).not.toBeNull();
		expect(uiState.confirmDialog?.text).toBe("Are you sure?");
		expect(uiState.confirmDialog?.actionLabel).toBe("Confirm");
	});

	it("accepts custom action label", () => {
		confirm("Delete?", "Delete");
		expect(uiState.confirmDialog?.actionLabel).toBe("Delete");
	});
});

describe("resolveConfirm", () => {
	it("resolves the confirm promise with true", async () => {
		const p = confirm("Sure?");
		resolveConfirm(true);
		const result = await p;
		expect(result).toBe(true);
		expect(uiState.confirmDialog).toBeNull();
	});

	it("resolves the confirm promise with false", async () => {
		const p = confirm("Sure?");
		resolveConfirm(false);
		const result = await p;
		expect(result).toBe(false);
	});

	it("does nothing if no dialog is active", () => {
		resolveConfirm(true); // Should not throw
	});
});

// ─── Panel actions ──────────────────────────────────────────────────────────

describe("openPanel", () => {
	it("adds panel to openPanels set", () => {
		openPanel("usage-panel");
		expect(uiState.openPanels.has("usage-panel")).toBe(true);
	});
});

describe("closePanel", () => {
	it("removes panel from openPanels set", () => {
		openPanel("usage-panel");
		closePanel("usage-panel");
		expect(uiState.openPanels.has("usage-panel")).toBe(false);
	});
});

describe("togglePanel", () => {
	it("opens a closed panel", () => {
		togglePanel("status-panel");
		expect(uiState.openPanels.has("status-panel")).toBe(true);
	});

	it("closes an open panel", () => {
		openPanel("status-panel");
		togglePanel("status-panel");
		expect(uiState.openPanels.has("status-panel")).toBe(false);
	});
});

// ─── Banner actions ─────────────────────────────────────────────────────────

describe("showBanner", () => {
	it("adds a banner", () => {
		const banner: BannerConfig = {
			id: "b1",
			variant: "update",
			icon: "arrow-up",
			text: "Update available",
			dismissible: true,
		};
		showBanner(banner);
		expect(uiState.banners).toHaveLength(1);
	});

	it("does not duplicate banners with same id", () => {
		const banner: BannerConfig = {
			id: "b1",
			variant: "update",
			icon: "arrow-up",
			text: "Update",
			dismissible: true,
		};
		showBanner(banner);
		showBanner(banner);
		expect(uiState.banners).toHaveLength(1);
	});
});

describe("removeBanner", () => {
	it("removes banner by id", () => {
		showBanner({
			id: "b1",
			variant: "update",
			icon: "i",
			text: "t",
			dismissible: true,
		});
		showBanner({
			id: "b2",
			variant: "onboarding",
			icon: "i",
			text: "t",
			dismissible: true,
		});
		removeBanner("b1");
		expect(uiState.banners).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(uiState.banners[0]!.id).toBe("b2");
	});
});

// ─── Rewind mode ────────────────────────────────────────────────────────────

describe("enterRewindMode", () => {
	it("activates rewind mode and clears selected uuid", () => {
		enterRewindMode();
		expect(uiState.rewindActive).toBe(true);
		expect(uiState.rewindSelectedUuid).toBeNull();
	});
});

describe("exitRewindMode", () => {
	it("deactivates rewind mode", () => {
		enterRewindMode();
		exitRewindMode();
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.rewindSelectedUuid).toBeNull();
	});
});

// ─── Plan mode ──────────────────────────────────────────────────────────────

describe("enterPlanMode", () => {
	it("activates plan mode", () => {
		enterPlanMode();
		expect(uiState.planMode).toBe(true);
	});
});

describe("exitPlanMode", () => {
	it("deactivates plan mode and clears related state", () => {
		enterPlanMode();
		uiState.planContent = "some plan";
		exitPlanMode();
		expect(uiState.planMode).toBe(false);
		expect(uiState.planContent).toBeNull();
		expect(uiState.planApproval).toBeNull();
	});
});

// ─── Sidebar panel switching ────────────────────────────────────────────────

describe("setSidebarPanel", () => {
	it("switches from sessions to files", () => {
		setSidebarPanel("files");
		expect(uiState.sidebarPanel).toBe("files");
	});

	it("switches from files to sessions", () => {
		uiState.sidebarPanel = "files";
		setSidebarPanel("sessions");
		expect(uiState.sidebarPanel).toBe("sessions");
	});

	it("is idempotent", () => {
		setSidebarPanel("files");
		setSidebarPanel("files");
		expect(uiState.sidebarPanel).toBe("files");
	});
});

describe("fileBrowserOpen removal", () => {
	it("uiState does not have fileBrowserOpen property", () => {
		expect("fileBrowserOpen" in uiState).toBe(false);
	});
});

describe("resetProjectUI resets sidebarPanel", () => {
	it("resets sidebarPanel to sessions", () => {
		uiState.sidebarPanel = "files";
		resetProjectUI();
		expect(uiState.sidebarPanel).toBe("sessions");
	});
});
