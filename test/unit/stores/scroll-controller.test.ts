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

	it("does NOT detach when distFromBottom is exactly at DETACH_THRESHOLD (100px)", () => {
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
			value: 1400,
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
		Object.defineProperty(div, "scrollTop", {
			value: 1399,
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
		div.scrollTop = 1496;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});
});
