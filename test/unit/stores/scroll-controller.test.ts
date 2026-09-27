// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

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

	function makeController(onUserScroll?: () => void) {
		lifecycle = "empty";
		return createScrollController(() => lifecycle, onUserScroll);
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

	it("onUserScroll fires for a user scroll below the detach threshold", () => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		div.scrollTop = 1490;
		div.dispatchEvent(new Event("scroll"));
		expect(onUserScroll).toHaveBeenCalledTimes(1);
		expect(ctrl.state).toBe("following");
		ctrl.detach();
	});

	it.each([
		"requestFollow",
		"onNewContent",
	] as const)("onUserScroll does not fire for a programmatic scroll from %s", (method) => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		div.scrollTop = 200;
		ctrl[method]();
		expect(div.scrollTop).toBe(div.scrollHeight);
		// This regression test must fail if the programmaticScrollCount guard is removed.
		div.dispatchEvent(new Event("scroll"));
		expect(onUserScroll).not.toHaveBeenCalled();
		ctrl.detach();
	});

	// Found in the real app, not in a test: the session bar arrived collapsed on
	// load because a coalesced scroll event from the settle loop's own re-pin was
	// delivered after the programmatic counter's safety reset had zeroed its
	// slot, and so read as a user scroll. Every such stray lands at the bottom,
	// which is what tells it apart from a real scroll.
	it("onUserScroll does not fire for a scroll that lands at the bottom", () => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		// No programmatic slot left to consume: this is exactly the event that
		// escaped the counter.
		div.scrollTop = div.scrollHeight - div.clientHeight;
		div.dispatchEvent(new Event("scroll"));
		expect(onUserScroll).not.toHaveBeenCalled();
		ctrl.detach();
	});

	it.each([
		"empty",
		"loading",
		"committed",
	] as const)("onUserScroll does not fire while the transcript is hydrating (%s)", (lc) => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = lc;
		const div = createScrollableDiv();
		ctrl.attach(div);
		// Off the bottom, so the distance guard would let this one through. The
		// controller is force-pinning while the transcript hydrates, so any
		// position off the bottom is transient and reports nothing.
		simulateScrollUp(div);
		expect(onUserScroll).not.toHaveBeenCalled();
		ctrl.detach();
	});

	it("onUserScroll does not fire for a non-overflowing container", () => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = "ready";
		const div = createScrollableDiv();
		Object.defineProperty(div, "scrollHeight", { value: 500 });
		ctrl.attach(div);
		div.scrollTop = 0;
		div.dispatchEvent(new Event("scroll"));
		expect(onUserScroll).not.toHaveBeenCalled();
		ctrl.detach();
	});

	it("onContainerResize re-pins scrollTop when following without counting user intent", () => {
		const onUserScroll = vi.fn();
		const ctrl = makeController(onUserScroll);
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		Object.defineProperty(div, "clientHeight", { value: 450 });
		ctrl.onContainerResize();
		expect(div.scrollTop).toBe(div.scrollHeight);
		div.dispatchEvent(new Event("scroll"));
		expect(onUserScroll).not.toHaveBeenCalled();
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
		"committed",
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

	it("transitions to 'settling' when lifecycle becomes 'committed'", () => {
		const ctrl = makeController();
		lifecycle = "committed";
		expect(ctrl.state).toBe("settling");
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
