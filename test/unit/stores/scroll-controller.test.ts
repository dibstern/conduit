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
import {
	createScrollController,
	repositionWithoutController,
	turnTargetTop,
} from "../../../src/lib/frontend/stores/scroll-controller.svelte.js";

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

	describe("observed layout changes", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it.each([
			200, 1470, 1500,
		])("records clearance shifts at scrollTop %s without reader follow", (top) => {
			const onReaderFollow = vi.fn();
			const ctrl = createScrollController(() => "ready", undefined, {
				onReaderFollow,
			});
			const div = createScrollableDiv();
			ctrl.attach(div);
			div.scrollTop = top;
			div.dispatchEvent(new Event("scroll"));
			Object.defineProperty(div, "scrollHeight", { value: 2060 });
			ctrl.onClearanceChange(60);
			expect(div.scrollTop).toBe(top === 1500 ? 2060 : top + 60);
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe(top === 200 ? "detached" : "following");
			expect(onReaderFollow).not.toHaveBeenCalled();
			ctrl.detach();
		});

		it("notifies a latest command while navigation is busy only when intent changes", () => {
			const onReaderFollow = vi.fn();
			let busy = false;
			const ctrl = createScrollController(
				() => "ready",
				() => ({ historical: false, busy, topClearance: 0, identity: 0 }),
				{ onReaderFollow },
			);
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			busy = true;
			expect(ctrl.place("latest")).toBe(true);
			expect(ctrl.state).toBe("detached");
			expect(onReaderFollow).toHaveBeenCalledTimes(1);
			ctrl.place("latest");
			expect(onReaderFollow).toHaveBeenCalledTimes(1);
			ctrl.detach();
		});

		it("notifies reader follows, but not growth, reset, fit, clamp or reposition", async () => {
			const onReaderFollow = vi.fn();
			const ctrl = createScrollController(() => "ready", undefined, {
				onReaderFollow,
			});
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			div.scrollTop = 1500;
			div.dispatchEvent(new Event("scroll"));
			div.dispatchEvent(new Event("scroll"));
			expect(onReaderFollow).toHaveBeenCalledTimes(1);

			simulateScrollUp(div);
			ctrl.place("latest");
			div.dispatchEvent(new Event("scroll"));
			expect(onReaderFollow).toHaveBeenCalledTimes(2);
			Object.defineProperty(div, "scrollHeight", { value: 2500 });
			ctrl.onNewContent();
			ctrl.resetForSession();

			simulateScrollUp(div);
			Object.defineProperty(div, "scrollHeight", { value: 500 });
			div.scrollTop = 0;
			div.append(document.createElement("span"));
			await Promise.resolve();
			expect(ctrl.state).toBe("following");

			Object.defineProperty(div, "scrollHeight", { value: 2000 });
			div.scrollTop = 1400;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("detached");
			Object.defineProperty(div, "scrollHeight", { value: 1000 });
			div.scrollTop = 500;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("following");
			expect(onReaderFollow).toHaveBeenCalledTimes(2);

			Object.defineProperty(div, "scrollHeight", { value: 2000 });
			simulateScrollUp(div);
			await ctrl.reposition({ top: () => 1500 });
			expect(ctrl.state).toBe("following");
			expect(onReaderFollow).toHaveBeenCalledTimes(2);
			ctrl.detach();
		});

		it("settles a message placement clamped to the bottom without reader intent", () => {
			const onReaderFollow = vi.fn();
			const ctrl = createScrollController(() => "ready", undefined, {
				onReaderFollow,
			});
			const div = createScrollableDiv();
			let top = 200;
			Object.defineProperty(div, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = Math.max(0, Math.min(value, 1500));
				},
			});
			const row = document.createElement("div");
			row.className = "msg-user";
			row.dataset["messageId"] = "last";
			row.getClientRects = () =>
				[new DOMRect(0, 1900, 200, 50)] as unknown as DOMRectList;
			row.getBoundingClientRect = () => new DOMRect(0, 1900, 200, 50);
			div.append(row);
			ctrl.attach(div);
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("detached");
			expect(ctrl.place({ messageId: "last" })).toBe(true);
			expect(div.scrollTop).toBe(1500);
			expect(ctrl.state).toBe("following");
			div.dispatchEvent(new Event("scroll"));
			expect(onReaderFollow).not.toHaveBeenCalled();
			ctrl.detach();
		});

		it("keeps the reading row and intent when earlier messages are prepended", () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			Object.defineProperty(div, "scrollHeight", { value: 2400 });
			ctrl.onPrepend(2000, 200);
			vi.advanceTimersToNextFrame();
			expect(div.scrollTop).toBe(600);
			expect(ctrl.state).toBe("detached");
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("detached");
			ctrl.detach();
		});

		it("also follows a reader reaching the current bottom after growth", async () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			simulateScrollUp(div);
			Object.defineProperty(div, "scrollHeight", { value: 2200 });
			div.append(document.createElement("span"));
			await Promise.resolve();
			div.scrollTop = 1700;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("following");
			ctrl.detach();
		});

		it.each([
			1600, 1700,
		])("follows a reader reaching the old bottom before growth to %i is consumed", async (extent) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			let top = 1500;
			Object.defineProperty(div, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = Math.max(
						0,
						Math.min(value, div.scrollHeight - div.clientHeight),
					);
				},
			});
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();
			simulateScrollUp(div);
			expect(ctrl.state).toBe("detached");

			div.scrollTop = 1500;
			Object.defineProperty(div, "scrollHeight", { value: extent + 500 });
			div.append(document.createElement("span"));
			await Promise.resolve();
			div.dispatchEvent(new Event("scroll"));

			expect(ctrl.state).toBe("following");
			expect(div.scrollTop).toBe(extent);
			ctrl.detach();
		});

		it.each([
			"latest",
			"historical",
			"busy",
		] as const)("re-pins fitting content without a scroll event, preserving %s navigation", async (mode) => {
			let navigation: "latest" | "historical" | "busy" = "latest";
			const ctrl = createScrollController(
				() => "ready",
				() => ({
					historical: navigation === "historical",
					busy: navigation === "busy",
					topClearance: 0,
					identity: 1,
				}),
			);
			const div = createScrollableDiv();
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();
			div.scrollTop = 0;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.isDetached).toBe(true);

			navigation = mode;
			Object.defineProperty(div, "scrollHeight", { value: 500 });
			// Already at zero: shrinking to fit produces no clamp scroll event.
			div.append(document.createElement("span"));
			await Promise.resolve();
			expect(ctrl.isPinned).toBe(true);
			expect(ctrl.state).toBe(mode === "latest" ? "following" : "detached");
			ctrl.onNewContent();
			if (mode !== "latest") expect(div.scrollTop).toBe(0);
			navigation = "latest";
			expect(ctrl.state).toBe("following");
			ctrl.detach();
		});

		it.each([
			false,
			true,
		])("preserves a reader's scroll before its scroll event is handled (own scroll pending: %s)", async (ownScrollPending) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();
			if (ownScrollPending) ctrl.onNewContent();

			// Hover/focus can mutate the DOM before the browser delivers scroll.
			div.scrollTop = 1486;
			if (ownScrollPending) div.dispatchEvent(new Event("scroll"));
			div.append(document.createElement("span"));
			await Promise.resolve();
			expect(div.scrollTop).toBe(1486);
			ctrl.detach();
		});

		it("preserves a following reader's position on mutations without layout growth", async () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();
			div.scrollTop = 1486;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("following");

			div.append(document.createElement("span"));
			await Promise.resolve();
			vi.advanceTimersToNextFrame();
			expect(div.scrollTop).toBe(1486);
			ctrl.detach();
		});

		it("follows content growth observed while at the bottom", async () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();

			Object.defineProperty(div, "scrollHeight", { value: 2400 });
			div.append(document.createElement("span"));
			await Promise.resolve();
			expect(div.scrollTop).toBe(2400);
			expect(ctrl.state).toBe("following");
			ctrl.detach();
		});

		it("follows growth that lands before its own scroll event is consumed", async () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();

			ctrl.onNewContent();
			Object.defineProperty(div, "scrollHeight", { value: 3000 });
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("following");
			expect(ctrl.isPinned).toBe(true);
			div.append(document.createElement("span"));
			await Promise.resolve();
			expect(div.scrollTop).toBe(3000);
			ctrl.detach();
		});

		// A no-op write emits no scroll event; multiple writes and a reader's
		// scroll in one frame coalesce into one event at the reader's position.
		// Neither may hide user intent or let subsequent growth snap back.
		it.each([
			false,
			true,
		])("detaches on a same-frame reader scroll after a bottom write (moved: %s)", (grew) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			let top = div.scrollTop;
			// jsdom does not clamp scrollTop as a browser does.
			Object.defineProperty(div, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = Math.max(
						0,
						Math.min(value, div.scrollHeight - div.clientHeight),
					);
				},
			});
			ctrl.attach(div);
			vi.advanceTimersToNextFrame();
			if (grew) Object.defineProperty(div, "scrollHeight", { value: 2400 });
			ctrl.onNewContent();
			ctrl.onContainerResize();
			const readerTop = div.scrollTop - 400;
			div.scrollTop = readerTop;
			div.dispatchEvent(new Event("scroll"));
			expect(ctrl.state).toBe("detached");
			expect(ctrl.isPinned).toBe(false);

			Object.defineProperty(div, "scrollHeight", { value: 3000 });
			ctrl.onNewContent();
			ctrl.onContainerResize();
			vi.advanceTimersToNextFrame();
			expect(div.scrollTop).toBe(readerTop);
			ctrl.detach();
		});
	});

	// Failure cases: a short historical window looks like latest at its bottom;
	// an already queued prepend applies to a different navigation/window.
	describe("transcript windows", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());
		it("does not follow the physical bottom of a historical window", async () => {
			const ctrl = createScrollController(
				() => "ready",
				() => ({ historical: true, busy: false, topClearance: 0, identity: 1 }),
			);
			const div = createScrollableDiv();
			ctrl.attach(div);
			await ctrl.reposition({ top: () => null });
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

	describe("reposition transactions", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("honours a reader reaching the bottom in the next frame before queued growth", async () => {
			const ctrl = createScrollController(() => "ready");
			const div = createScrollableDiv();
			let top = 200;
			Object.defineProperty(div, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = Math.min(value, div.scrollHeight - div.clientHeight);
				},
			});
			div.setAttribute("aria-label", "Transcript");
			const target = document.createElement("div");
			div.append(target);
			ctrl.attach(div);
			div.dispatchEvent(new Event("scroll"));
			await ctrl.reposition({ top: () => turnTargetTop(target) });
			vi.advanceTimersToNextFrame();
			div.scrollTop = 1500;
			Object.defineProperty(div, "scrollHeight", { value: 2100 });
			div.append(document.createElement("span"));
			await Promise.resolve();
			div.dispatchEvent(new Event("scroll"));
			vi.advanceTimersToNextFrame();
			expect(ctrl.state).toBe("following");
			expect(div.scrollTop).toBe(1600);
			ctrl.detach();
		});

		it("preserves a pending reveal through content that temporarily fits", async () => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			await ctrl.reposition({
				change: () => {
					div.scrollTop = 0;
					Object.defineProperty(div, "scrollHeight", { value: 500 });
					div.append(document.createElement("span"));
				},
				top: () => {
					expect(ctrl.isDetached).toBe(true);
					Object.defineProperty(div, "scrollHeight", { value: 2000 });
					return 0;
				},
			});
			expect(div.scrollTop).toBe(0);
			vi.advanceTimersToNextFrame();
			expect(ctrl.isDetached).toBe(true);
			ctrl.detach();
		});

		// A return expands the steps while the launching row is already visible.
		// Neither a stale bottom-scroll event nor content timing may undo it.
		it.each([
			"before expansion",
			"after expansion",
			"after settling",
		])("preserves the revealed row when new content arrives %s", async (order) => {
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
			await ctrl.reposition({
				change: () => {
					div.dispatchEvent(new Event("scroll"));
					if (order === "before expansion") ctrl.onNewContent();
					Object.defineProperty(div, "scrollHeight", { value: 2033 });
					if (order === "after expansion") ctrl.onNewContent();
					ctrl.onContainerResize();
				},
				top: () => null,
			});
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
		])("settles using the normal at-bottom rule with a %ipx gap, without a scroll event", async (gap) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			await ctrl.reposition({ top: () => 1500 - gap });
			expect(ctrl.isPinned).toBe(gap < 5);
			expect(ctrl.isDetached).toBe(gap >= 5);
			ctrl.detach();
		});

		it.each([
			"reposition",
			"resetForSession",
			"detach",
		] as const)("%s supersedes a pending reposition", async (method) => {
			const ctrl = makeController();
			lifecycle = "ready";
			const div = createScrollableDiv();
			ctrl.attach(div);
			const top = vi.fn(() => 200);
			const pending = ctrl.reposition({ top });
			if (method === "reposition") await ctrl.reposition({ top: () => 1400 });
			else ctrl[method]();
			await pending;
			expect(top).not.toHaveBeenCalled();
			expect(ctrl.state).toBe(
				method === "resetForSession" ? "following" : "detached",
			);
			expect(div.scrollTop).toBe(
				method === "reposition"
					? 1400
					: method === "resetForSession"
						? 2000
						: 1500,
			);
			ctrl.detach();
		});

		it("keeps a fully visible picked card still when its change grows content below it", async () => {
			const ctrl = createScrollController(() => "ready");
			const div = createScrollableDiv();
			div.setAttribute("aria-label", "Transcript");
			const card = document.createElement("div");
			card.getBoundingClientRect = () => new DOMRect(0, 100, 200, 80);
			div.append(card);
			ctrl.attach(div);
			await ctrl.reposition({
				change: () => {
					Object.defineProperty(div, "scrollHeight", { value: 2200 });
					div.append(document.createElement("span"));
					ctrl.onNewContent();
				},
				top: () => turnTargetTop(card),
			});
			expect(div.scrollTop).toBe(1500);
			expect(ctrl.state).toBe("detached");
			ctrl.detach();
		});

		it("settles even when a synchronous change throws", async () => {
			const ctrl = createScrollController(() => "ready");
			const div = createScrollableDiv();
			ctrl.attach(div);
			await expect(
				ctrl.reposition({
					change: () => {
						throw new Error("change failed");
					},
					top: () => 200,
				}),
			).rejects.toThrow("change failed");
			expect(ctrl.state).toBe("following");
			Object.defineProperty(div, "scrollHeight", { value: 2300 });
			ctrl.onNewContent();
			expect(div.scrollTop).toBe(2300);
			ctrl.detach();
		});

		it.each([
			true,
			false,
		])("repositions without a controller only with a transcript (root: %s)", async (withRoot) => {
			const div = createScrollableDiv();
			const change = vi.fn();
			const top = vi.fn(() => 200);
			const pending = repositionWithoutController(withRoot ? div : undefined, {
				change,
				top,
			});
			expect(change).toHaveBeenCalledOnce();
			expect(div.scrollTop).toBe(1500);
			await pending;
			expect(div.scrollTop).toBe(withRoot ? 200 : 1500);
			expect(top).toHaveBeenCalledTimes(withRoot ? 1 : 0);
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
		"latest",
		"onNewContent",
	] as const)("a programmatic scroll from %s pins without reading as a user scroll", (method) => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		expect(ctrl.isPinned).toBe(false);
		ctrl.place("latest");
		div.scrollTop = 200;
		if (method === "latest") ctrl.place("latest");
		else ctrl[method]();
		expect(div.scrollTop).toBe(div.scrollHeight);
		// The resulting scroll event must retain pinning.
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

	// Collapsing a long Turn can shrink the transcript until it fits. The
	// browser clamps scrollTop and fires one scroll; nothing is left to scroll
	// away from, so Jump to live must not stay up.
	it("re-follows when the content shrinks until it no longer overflows", () => {
		const ctrl = makeController();
		lifecycle = "ready";
		const div = createScrollableDiv();
		ctrl.attach(div);
		simulateScrollUp(div);
		expect(ctrl.isDetached).toBe(true);
		Object.defineProperty(div, "scrollHeight", { value: 400 });
		div.scrollTop = 0;
		div.dispatchEvent(new Event("scroll"));
		expect(ctrl.isDetached).toBe(false);
		expect(ctrl.isPinned).toBe(true);
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
