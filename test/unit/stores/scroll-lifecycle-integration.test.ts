// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Standard localStorage mock
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

import {
	clearMessages,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { createScrollController } from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testMessages } from "../../helpers/test-session-slot.js";

let tm: SessionMessages;

describe("Scroll lifecycle integration", () => {
	beforeEach(() => {
		sessionState.currentId = "test-session";
		clearMessages();
		tm = testMessages();
	});

	it("full flow: empty -> loading -> ready -> detach -> follow", () => {
		const ctrl = createScrollController(() => tm.loadLifecycle);
		const div = document.createElement("div");
		ctrl.attach(div);

		// 1. Start: empty
		expect(ctrl.state).toBe("loading");

		// 2. Cold transcript view starts loading
		tm.loadLifecycle = "loading";
		expect(ctrl.state).toBe("loading");

		// 3. The transcript is ready
		tm.loadLifecycle = "ready";
		expect(ctrl.state).toBe("following");

		// 4. User scrolls up (position-based detach)
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
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.state).toBe("detached");
		expect(ctrl.isDetached).toBe(true);

		// 5. User clicks scroll-to-bottom
		ctrl.requestFollow();
		expect(ctrl.state).toBe("following");
		expect(ctrl.isDetached).toBe(false);

		ctrl.detach();
	});

	it("session switch resets state correctly", () => {
		const ctrl = createScrollController(() => tm.loadLifecycle);
		const div = document.createElement("div");
		ctrl.attach(div);

		// Get to following + detached
		tm.loadLifecycle = "ready";
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
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(true);

		// Session switch
		ctrl.resetForSession();
		tm.loadLifecycle = "loading";
		expect(ctrl.state).toBe("loading");
		expect(ctrl.isDetached).toBe(false);

		ctrl.detach();
	});

	it("detach during loading is suppressed", () => {
		const ctrl = createScrollController(() => tm.loadLifecycle);
		const div = document.createElement("div");
		ctrl.attach(div);

		// During loading, scroll events shouldn't cause detach
		tm.loadLifecycle = "loading";
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
		div.dispatchEvent(new Event("scroll"));
		// State should still be loading (not detached)
		expect(ctrl.state).toBe("loading");

		ctrl.detach();
	});
});
