// Global test setup — suppress log output so test results aren't drowned
// in JSON log lines or console noise. Only "error" remains visible so
// critical failures are still surfaced.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Reused SQLite forks still need fresh module state for each test file.
vi.resetModules();

// Startup capture and legacy SDK/config readers must never inherit a real
// daemon.json, account folder or home from the reviewer's shell.
const testEnvironment = mkdtempSync(join(tmpdir(), "conduit-test-env-"));
const reviewerHome = homedir();
process.env["HOME"] = join(testEnvironment, "home");
process.env["CONDUIT_CONFIG_DIR"] = join(testEnvironment, "conduit");
// Real-SDK E2E runs still need the reviewer's login folder. They read it under
// this test-only name, so no SDK or config reader can inherit it by accident.
const reviewerClaudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];
if (reviewerClaudeConfigDir !== undefined)
	process.env["CONDUIT_TEST_REAL_CLAUDE_CONFIG_DIR"] = reviewerClaudeConfigDir;
delete process.env["CLAUDE_CONFIG_DIR"];
// Likewise for Codex: a daemon started by a test otherwise finds a signed-in
// Codex and adds a Codex instance while the test asserts on the list.
process.env["CONDUIT_TEST_REAL_CODEX_HOME"] =
	process.env["CODEX_HOME"] || join(reviewerHome, ".codex");
delete process.env["CODEX_HOME"];
mkdirSync(process.env["HOME"], { recursive: true });
// A store closing (or a drain it kicked) can still be writing here; Node
// retries ENOTEMPTY with backoff instead of failing the whole file.
afterAll(() =>
	rmSync(testEnvironment, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	}),
);

// 0. Git hooks (lefthook pre-commit runs the suite) export GIT_DIR,
//    GIT_INDEX_FILE and friends. A test that inherits them and runs `git init`
//    or `git commit` in a temp dir acts on the committing repo instead: it
//    rewrote the shared .git/config and committed onto a real branch
//    (conduit-test-3rvb). Tests must only ever see their own repos.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) delete process.env[key];
}

// 1. Backend (pino) — set minimum level to "error".
const { setLogLevel } = await import("../src/lib/logger.js");

setLogLevel("error");

// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends, and lefthook's
// pre-commit runs this suite. Any git a test spawns would then act on
// conduit's own repository, not the temp repo in its cwd: `git init` plus
// `git config` in session-git.test.ts once pointed core.worktree at a temp
// dir and set user.name to "Test User". The list is `git rev-parse
// --local-env-vars`.
for (const name of [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
])
	delete process.env[name];

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

// 5. jsdom has no ResizeObserver or layout engine. Use an inert default for
//    components that observe their size; tests exercising resize behavior can
//    stub their own observer, as they do for IntersectionObserver above.
if (typeof globalThis.ResizeObserver === "undefined") {
	class InertResizeObserver implements ResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	globalThis.ResizeObserver = InertResizeObserver;
}

// 6. jsdom has no matchMedia. Default to desktop and let tests that exercise
//    media changes provide their own query results and listeners.
if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = (media): MediaQueryList => ({
		matches: false,
		media,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
}

// 7. jsdom does not load fonts or expose document.fonts. An inert event target
//    lets components register and clean up font-loading listeners.
if (typeof document !== "undefined" && !document.fonts) {
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: new EventTarget(),
	});
}

// 8. jsdom has no Web Animations API, which Svelte transitions and animate:
//    directives run on. Finish each animation on the next microtask (not a
//    timer, so fake timers cannot stall it): intros settle and outroing
//    nodes leave the DOM, as they would once a real animation ends.
if (typeof Element !== "undefined" && !Element.prototype.animate) {
	Element.prototype.animate = function animate(): Animation {
		const animation = {
			playState: "running",
			currentTime: 0,
			effect: null,
			onfinish: null as (() => void) | null,
			cancel() {
				animation.playState = "idle";
			},
		};
		queueMicrotask(() => {
			if (animation.playState !== "running") return;
			animation.playState = "finished";
			animation.onfinish?.();
		});
		return animation as unknown as Animation;
	};
	Element.prototype.getAnimations = () => [];
}
