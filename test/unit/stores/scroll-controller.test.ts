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
		const div = document.createElement("div");
		ctrl.attach(div);
		div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
		expect(ctrl.isDetached).toBe(true);
		ctrl.resetForSession();
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});

	it("wheel up in following state transitions to detached", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		ctrl.attach(div);
		div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
		expect(ctrl.isDetached).toBe(true);
		ctrl.detach();
	});

	it("wheel down in following state stays following", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = document.createElement("div");
		ctrl.attach(div);
		div.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
		expect(ctrl.isDetached).toBe(false);
		ctrl.detach();
	});
});
