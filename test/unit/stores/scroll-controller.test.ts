// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
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
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import type { LoadLifecycle } from "../../../src/lib/frontend/stores/chat.svelte.js";
import { createScrollController } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";

describe("ScrollController", () => {
	let lifecycle: LoadLifecycle;

	function makeController() {
		lifecycle = "empty";
		return createScrollController(() => lifecycle);
	}

	function createScrollableDiv(): HTMLDivElement {
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "scrollTop", {
			value: 1500,
			writable: true,
			configurable: true,
		});
		return div;
	}

	function simulateScrollUp(div: HTMLDivElement): void {
		div.scrollTop = 200;
		div.dispatchEvent(new Event("scroll"));
	}

	// Failure cases: a short historical window looks like latest at its bottom;
	// an already queued prepend applies to a different navigation/window.
	describe("transcript windows", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());
		it("does not follow the physical bottom of a historical window", () => {
			const ctrl = createScrollController(
				() => "ready",
				() => ({ historical: true, busy: false, topClearance: 0, identity: 1 }),
			);
			const div = createScrollableDiv();
			ctrl.attach(div);
			ctrl.requestJump();
			vi.runAllTimers();
			expect(ctrl.state).toBe("detached");
			div.scrollTop = 1500;
			div.dispatchEvent(new Event("scroll"));
			ctrl.onNewContent();
			expect(div.scrollTop).toBe(1500);
			expect(ctrl.state).toBe("detached");
			ctrl.detach();
		});
		it("discards prepend placement when navigation changes before its frame", () => {
			let identity = 1;
			const ctrl = createScrollController(
				() => "ready",
				() => ({ historical: false, busy: false, topClearance: 0, identity }),
			);
			const div = createScrollableDiv();
			ctrl.attach(div);
			ctrl.onPrepend(1500, 100);
			identity++;
			div.scrollTop = 900;
			vi.runAllTimers();
			expect(div.scrollTop).toBe(900);
			ctrl.detach();
		});
	});

	describe("explicit jumps", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		// A return expands the steps while the launching row is already visible.
		// Neither a stale bottom-scroll event nor content timing may undo it.
		it.each([
			"before expansion",
			"after expansion",
			"after settling",
		])("preserves the revealed row when new content arrives %s", (order) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			let top = 1500;
			Object.defineProperty(div, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = Math.min(value, div.scrollHeight - div.clientHeight);
				},
			});
			ctrl.attach(div);
			ctrl.resetForSession();
			ctrl.requestJump();
			div.dispatchEvent(new Event("scroll"));
			if (order === "before expansion") ctrl.onNewContent();
			Object.defineProperty(div, "scrollHeight", { value: 2033 });
			if (order === "after expansion") ctrl.onNewContent();
			ctrl.onContainerResize();
			vi.advanceTimersToNextFrame();
			if (order === "after settling") ctrl.onNewContent();
			expect(div.scrollTop).toBe(1500);
			expect(ctrl.state).toBe("detached");
			expect(ctrl.isPinned).toBe(false);

			// Even a gap below the 50px detach threshold stays detached until
			// the reader returns to the bottom using the normal re-follow rule.
			div.dispatchEvent(new Event("scroll"));
			ctrl.onNewContent();
			expect(div.scrollTop).toBe(1500);
			div.scrollTop = 1533;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("following");
			expect(ctrl.isPinned).toBe(true);
			ctrl.detach();
		});

		it.each([
			0, 4, 5, 33,
		])("settles using the normal at-bottom rule with a %ipx gap, without a scroll event", (gap) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			ctrl.requestJump();
			div.scrollTop = 1500 - gap;
			vi.advanceTimersToNextFrame();
			expect(ctrl.isPinned).toBe(gap < 5);
			expect(ctrl.isDetached).toBe(gap >= 5);
			ctrl.detach();
		});

		it.each([
			"requestFollow",
			"resetForSession",
			"detach",
		] as const)("%s cancels a pending jump settlement", (method) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			ctrl.requestJump();
			ctrl[method]();
			if (method === "detach") {
				ctrl.attach(createScrollableDiv());
				ctrl.resetForSession();
			}
			// Growth after the newer request must not let the old jump detach it.
			Object.defineProperty(div, "scrollHeight", { value: 3000 });
			vi.advanceTimersToNextFrame();
			expect(ctrl.state).toBe("following");
			ctrl.detach();
		});
	});

	// Content that lands while the session is idle follows only a reader who
	// was parked at the bottom, so pinned must survive the growth that moved
	// the bottom away without a scroll event.
	it("isPinned remembers the last position through content growth", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		expect(ctrl.isPinned).toBe(true);
		div.scrollTop = 1480;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isPinned).toBe(false);
		expect(ctrl.state).toBe("following");
		div.scrollTop = 1500;
		div.dispatchEvent(new Event("scroll"));
		Object.defineProperty(div, "scrollHeight", { value: 2400 });
		expect(ctrl.isPinned).toBe(true);
		ctrl.detach();
	});

	it.each([
		"requestFollow",
		"onNewContent",
	] as const)("a programmatic scroll from %s pins without reading as a user scroll", (method) => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		expect(ctrl.isPinned).toBe(false);
		ctrl.requestFollow();
		div.scrollTop = 200;
		ctrl[method]();
		expect(div.scrollTop).toBe(div.scrollHeight);
		// This regression test must fail if the programmaticScrollCount guard is removed.
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isPinned).toBe(true);
		expect(ctrl.state).toBe("following");
		ctrl.detach();
	});

	it("onContainerResize re-pins scrollTop when following", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		Object.defineProperty(div, "clientHeight", { value: 450 });
		ctrl.onContainerResize();
		expect(div.scrollTop).toBe(div.scrollHeight);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.state).toBe("following");
		ctrl.detach();
	});

	it("onContainerResize does nothing when detached", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		ctrl.onContainerResize();
		expect(div.scrollTop).toBe(200);
		expect(ctrl.state).toBe("detached");
		ctrl.detach();
	});

	it.each([
		"empty",
		"loading",
	] as const)("onContainerResize does nothing during %s", (nextLifecycle) => {
		const ctrl = makeController();
		lifecycle = nextLifecycle;
		const div = createScrollableDiv();
		ctrl.attach(div);
		ctrl.onContainerResize();
		expect(div.scrollTop).toBe(1500);
		ctrl.detach();
	});

	it("starts in 'loading' state when lifecycle is 'empty'", () => {
		const ctrl = makeController();
		expect(ctrl.state).toBe("loading");
	});

	it("transitions to 'following' when lifecycle becomes 'ready'", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		expect(ctrl.state).toBe("following");
	});

	it("isDetached is false initially", () => {
		const ctrl = makeController();
		expect(ctrl.isDetached).toBe(false);
	});

	it("isLoading is true when lifecycle is loading or empty", () => {
		const ctrl = makeController();
		lifecycle = "loading";
		expect(ctrl.isLoading).toBe(true);
	});

	it("resetForSession clears detached state", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		expect(ctrl.isDetached).toBe(true);
		ctrl.resetForSession();
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});

	it("detaches when user scrolls away from bottom past threshold", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		expect(ctrl.isDetached).toBe(true);
		ctrl.detach();
	});

	it("stays following when scroll position is near bottom", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		div.scrollTop = 1498;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});

	it("detaches when scroll position moves away from bottom beyond threshold", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "scrollTop", {
			value: 1500,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		expect(ctrl.isDetached).toBe(false);
		div.scrollTop = 200;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);
		ctrl.detach();
	});

	it("overflow guard prevents detach even with non-zero scrollTop on non-overflowing container", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "scrollTop", {
			value: 0,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});

	it("does NOT detach when distFromBottom is exactly at DETACH_THRESHOLD (50px)", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		// distFromBottom = 2000 - 1450 - 500 = 50 (exactly at threshold → NOT detach)
		Object.defineProperty(div, "scrollTop", {
			value: 1450,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});

	it("detaches when distFromBottom is 1px past DETACH_THRESHOLD", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		// distFromBottom = 2000 - 1449 - 500 = 51 (past threshold → detach)
		Object.defineProperty(div, "scrollTop", {
			value: 1449,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);
		ctrl.detach();
	});

	it("does NOT re-follow when distFromBottom is exactly at REFOLLOW_THRESHOLD (5px)", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "scrollTop", {
			value: 200,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);
		// distFromBottom = 2000 - 1495 - 500 = 5 (exactly at threshold → NOT re-follow)
		div.scrollTop = 1495;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);
		ctrl.detach();
	});

	it("re-follows when distFromBottom is 1px inside REFOLLOW_THRESHOLD", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		Object.defineProperty(div, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(div, "clientHeight", {
			value: 500,
			configurable: true,
		});
		Object.defineProperty(div, "scrollTop", {
			value: 200,
			writable: true,
			configurable: true,
		});
		ctrl.attach(div);
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);
		// distFromBottom = 2000 - 1496 - 500 = 4 (inside threshold → re-follow)
		div.scrollTop = 1496;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});
});
