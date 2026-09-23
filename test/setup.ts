// Global test setup — suppress log output so test results aren't drowned
// in JSON log lines or console noise. Only "error" remains visible so
// critical failures are still surfaced.

// 1. Backend (pino) — set minimum level to "error".
import { setLogLevel } from "../src/lib/logger.js";

setLogLevel("error");

// 2. Frontend — silence console.debug/info/warn produced by stores and
//    createFrontendLogger. console.error is left untouched.
const noop = () => {};
console.debug = noop;
console.info = noop;
console.warn = noop;

// 3. jsdom ships HTMLDialogElement but not showModal/show/close, so any
//    component rendering a <dialog> throws on mount. Shim just enough for the
//    open/closed state machine and the close event.
if (
	typeof HTMLDialogElement !== "undefined" &&
	!HTMLDialogElement.prototype.showModal
) {
	function open(this: HTMLDialogElement): void {
		this.open = true;
	}
	HTMLDialogElement.prototype.showModal = open;
	HTMLDialogElement.prototype.show = open;
	HTMLDialogElement.prototype.close = function close(
		this: HTMLDialogElement,
		returnValue?: string,
	): void {
		this.open = false;
		if (returnValue !== undefined) this.returnValue = returnValue;
		this.dispatchEvent(new Event("close"));
	};
}

// 4. jsdom has no IntersectionObserver, so any component that observes a scroll
//    sentinel throws on mount. This inert shim never reports an intersection,
//    which is the right default: a test that wants paging to fire stubs its own
//    (see test/unit/components/history-loader.test.ts).
if (typeof globalThis.IntersectionObserver === "undefined") {
	class InertIntersectionObserver implements IntersectionObserver {
		readonly root = null;
		readonly rootMargin = "";
		readonly scrollMargin = "";
		readonly thresholds: ReadonlyArray<number> = [];
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
		takeRecords(): IntersectionObserverEntry[] {
			return [];
		}
	}
	globalThis.IntersectionObserver = InertIntersectionObserver;
}
