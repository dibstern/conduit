// Global test setup — suppress log output so test results aren't drowned
// in JSON log lines or console noise. Only "error" remains visible so
// critical failures are still surfaced.

// 0. Git hooks (lefthook pre-commit runs the suite) export GIT_DIR,
//    GIT_INDEX_FILE and friends. A test that inherits them and runs `git init`
//    or `git commit` in a temp dir acts on the committing repo instead: it
//    rewrote the shared .git/config and committed onto a real branch
//    (conduit-test-3rvb). Tests must only ever see their own repos.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) delete process.env[key];
}

// 1. Backend (pino) — set minimum level to "error".
import { setLogLevel } from "../src/lib/logger.js";

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
