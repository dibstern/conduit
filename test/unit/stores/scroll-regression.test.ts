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

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import type { LoadLifecycle } from "../../../src/lib/frontend/stores/chat.svelte.js";
import { createScrollController } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";

describe("Scroll behavior regression suite", () => {
	let lifecycle: LoadLifecycle;
	function makeCtrl() {
		lifecycle = "ready";
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

	describe("Scroll-to-bottom button visibility", () => {
		it("isDetached is false when no user scroll-up has occurred", () => {
			const ctrl = makeCtrl();
			const div = document.createElement("div");
			ctrl.attach(div);
			expect(ctrl.isDetached).toBe(false);
			ctrl.detach();
		});

		it("does NOT detach on wheel-up when container has no overflow", () => {
			const ctrl = makeCtrl();
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
			div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
			expect(ctrl.isDetached).toBe(false);
			ctrl.detach();
		});

		it("does NOT detach on wheel-up when already at the bottom", () => {
			const ctrl = makeCtrl();
			const div = document.createElement("div");
			Object.defineProperty(div, "scrollHeight", {
				value: 1000,
				configurable: true,
			});
			Object.defineProperty(div, "clientHeight", {
				value: 500,
				configurable: true,
			});
			Object.defineProperty(div, "scrollTop", {
				value: 500,
				writable: true,
				configurable: true,
			});
			ctrl.attach(div);
			div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
			expect(ctrl.isDetached).toBe(false);
			ctrl.detach();
		});

		it("isDetached becomes true after scrolling away from bottom", () => {
			const ctrl = makeCtrl();
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			expect(ctrl.isDetached).toBe(true);
			ctrl.detach();
		});

		it("isDetached becomes false after requestFollow()", () => {
			const ctrl = makeCtrl();
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			expect(ctrl.isDetached).toBe(true);
			ctrl.requestFollow();
			expect(ctrl.isDetached).toBe(false);
			ctrl.detach();
		});
	});

	describe("Session switch clears detached state", () => {
		it("resetForSession clears userDetached", () => {
			const ctrl = makeCtrl();
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			expect(ctrl.isDetached).toBe(true);
			ctrl.resetForSession();
			expect(ctrl.isDetached).toBe(false);
			ctrl.detach();
		});

		it("resetForSession stops any active settle loop", () => {
			const ctrl = makeCtrl();
			lifecycle = "committed";
			const div = document.createElement("div");
			ctrl.attach(div);
			ctrl.onNewContent();
			ctrl.resetForSession();
			ctrl.detach();
		});
	});

	describe("Loading state suppresses scroll", () => {
		it("onNewContent is no-op during loading", () => {
			const ctrl = makeCtrl();
			lifecycle = "loading";
			const div = document.createElement("div");
			Object.defineProperty(div, "scrollHeight", {
				value: 1000,
				writable: true,
			});
			Object.defineProperty(div, "scrollTop", {
				value: 0,
				writable: true,
			});
			ctrl.attach(div);
			ctrl.onNewContent();
			expect(div.scrollTop).toBe(0);
			ctrl.detach();
		});
	});

	describe("Detached state prevents auto-scroll", () => {
		it("onNewContent does not scroll when detached", () => {
			const ctrl = makeCtrl();
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			expect(ctrl.isDetached).toBe(true);
			ctrl.onNewContent();
			expect(div.scrollTop).toBe(200);
			ctrl.detach();
		});
	});
});
