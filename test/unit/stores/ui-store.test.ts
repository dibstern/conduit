import { assert, beforeEach, describe, expect, it, vi } from "vitest";

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
	resolveConfirm,
	setSettledShelfOpen,
	setSnoozedShelfOpen,
	showBanner,
	showToast,
	togglePanel,
	toggleSidebar,
	uiState,
} from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { BannerConfig } from "../../../src/lib/frontend/types.js";

beforeEach(() => {
	// Reset UI state
	uiState.sidebarCollapsed = false;
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

describe("settled shelf preference", () => {
	it("starts collapsed with no saved preference", async () => {
		vi.resetModules();
		const fresh = await import("../../../src/lib/frontend/stores/ui.svelte.js");
		expect(fresh.uiState.settledShelfOpen).toBe(false);
	});

	it("restores the saved preference when the store loads", async () => {
		localStorageMock.setItem("settled-shelf-open", "true");
		vi.resetModules();
		const fresh = await import("../../../src/lib/frontend/stores/ui.svelte.js");
		expect(fresh.uiState.settledShelfOpen).toBe(true);
	});

	it("persists both states", () => {
		setSettledShelfOpen(true);
		expect(uiState.settledShelfOpen).toBe(true);
		expect(localStorageMock.getItem("settled-shelf-open")).toBe("true");
		setSettledShelfOpen(false);
		expect(uiState.settledShelfOpen).toBe(false);
		expect(localStorageMock.getItem("settled-shelf-open")).toBe("false");
	});

	it("still changes state when storage is unavailable", () => {
		localStorageMock.setItem.mockImplementationOnce(() => {
			throw new Error("unavailable");
		});
		expect(() => setSettledShelfOpen(true)).not.toThrow();
		expect(uiState.settledShelfOpen).toBe(true);
	});
});

describe("snoozed shelf preference", () => {
	it("starts collapsed and restores a saved preference", async () => {
		vi.resetModules();
		const collapsed = await import(
			"../../../src/lib/frontend/stores/ui.svelte.js"
		);
		expect(collapsed.uiState.snoozedShelfOpen).toBe(false);
		localStorageMock.setItem("snoozed-shelf-open", "true");
		vi.resetModules();
		const expanded = await import(
			"../../../src/lib/frontend/stores/ui.svelte.js"
		);
		expect(expanded.uiState.snoozedShelfOpen).toBe(true);
	});

	it("persists both states and keeps state if storage fails", () => {
		setSnoozedShelfOpen(true);
		expect(uiState.snoozedShelfOpen).toBe(true);
		expect(localStorageMock.getItem("snoozed-shelf-open")).toBe("true");
		setSnoozedShelfOpen(false);
		expect(localStorageMock.getItem("snoozed-shelf-open")).toBe("false");
		localStorageMock.setItem.mockImplementationOnce(() => {
			throw new Error("unavailable");
		});
		expect(() => setSnoozedShelfOpen(true)).not.toThrow();
		expect(uiState.snoozedShelfOpen).toBe(true);
	});
});

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

describe("showToast", () => {
	it("adds a toast with default options", () => {
		showToast("Hello");
		expect(uiState.toasts).toHaveLength(1);
		const firstToast = uiState.toasts[0];
		assert.exists(firstToast, "expected toast");
		expect(firstToast.title).toBe("Hello");
		expect(firstToast.variant).toBe("default");
		expect(firstToast.duration).toBe(7000);
		expect(firstToast.actions).toEqual([]);
	});

	it("turns a legacy inline action into the card's primary action", () => {
		const run = vi.fn();
		showToast("Moved “Fix nav” to Settled", {
			action: { label: "Undo", run },
		});
		expect(uiState.toasts[0]?.actions).toEqual([
			{ label: "Undo", run, kind: "primary" },
		]);
	});

	it("stores a titled card with its body, emphasis and actions", () => {
		const undo = vi.fn();
		showToast({
			title: "Switched to personal",
			body: "personal has 77% of its week left.",
			emphasis: "personal",
			actions: [
				{ label: "Undo", run: undo, kind: "primary" },
				{ label: "Later", kind: "dismiss" },
			],
		});
		const toast = uiState.toasts[0];
		assert.exists(toast, "expected toast");
		expect(toast).toMatchObject({
			title: "Switched to personal",
			body: "personal has 77% of its week left.",
			emphasis: "personal",
			variant: "default",
			duration: 7000,
		});
		expect(toast.actions.map((action) => action.kind)).toEqual([
			"primary",
			"dismiss",
		]);
	});

	it("auto-dismisses a card after its duration", () => {
		showToast({ title: "Saved", variant: "warn", duration: 500 });
		expect(uiState.toasts[0]?.variant).toBe("warn");
		vi.advanceTimersByTime(500);
		expect(uiState.toasts).toHaveLength(0);
	});

	it("accepts custom options", () => {
		showToast("Warning", { duration: 5000, variant: "warn" });
		const firstToast = uiState.toasts[0];
		assert.exists(firstToast, "expected toast");
		expect(firstToast.variant).toBe("warn");
		expect(firstToast.duration).toBe(5000);
	});

	it("auto-dismisses after duration", () => {
		showToast("Temp", { duration: 1000 });
		expect(uiState.toasts).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(uiState.toasts).toHaveLength(0);
	});

	it("keeps only the two newest toasts, and the survivors still expire", () => {
		showToast("A");
		showToast("B");
		showToast("C");
		expect(uiState.toasts.map((toast) => toast.title)).toEqual(["B", "C"]);
		vi.advanceTimersByTime(7000);
		expect(uiState.toasts).toHaveLength(0);
	});
});

describe("dismissToast", () => {
	it("removes toast by id", () => {
		showToast("A");
		showToast("B");
		const firstToast = uiState.toasts[0];
		assert.exists(firstToast, "expected first toast");
		const idToRemove = firstToast.id;
		dismissToast(idToRemove);
		expect(uiState.toasts).toHaveLength(1);
		const remainingToast = uiState.toasts[0];
		assert.exists(remainingToast, "expected remaining toast");
		expect(remainingToast.title).toBe("B");
	});
});

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
		const firstBanner = uiState.banners[0];
		assert.exists(firstBanner, "expected banner");
		expect(firstBanner.id).toBe("b2");
	});
});

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

describe("fileBrowserOpen removal", () => {
	it("uiState does not have fileBrowserOpen property", () => {
		expect("fileBrowserOpen" in uiState).toBe(false);
	});
});
