// ─── Frontend Logger Tests ───────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { featureFlags } from "../../../src/lib/frontend/stores/feature-flags.svelte.js";
import {
	createFrontendLogger,
	createSilentFrontendLogger,
	type FrontendLogger,
} from "../../../src/lib/frontend/utils/logger.js";

// ─── Spies ──────────────────────────────────────────────────────────────────

let debugSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
	infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	featureFlags.debug = false;
});

// ─── createFrontendLogger ───────────────────────────────────────────────────

describe("createFrontendLogger", () => {
	it("prefixes all messages with [tag]", () => {
		const log = createFrontendLogger("ws");

		log.info("connected");
		expect(infoSpy).toHaveBeenCalledWith("[ws]", "connected");

		log.warn("timeout");
		expect(warnSpy).toHaveBeenCalledWith("[ws]", "timeout");

		log.error("fatal");
		expect(errorSpy).toHaveBeenCalledWith("[ws]", "fatal");
	});

	it("passes multiple arguments through", () => {
		const log = createFrontendLogger("ws");
		const err = new Error("boom");

		log.warn("parse failed:", err);
		expect(warnSpy).toHaveBeenCalledWith("[ws]", "parse failed:", err);
	});

	it("debug and verbose map to console.debug when debug flag is enabled", () => {
		featureFlags.debug = true;
		const log = createFrontendLogger("test");

		log.debug("dbg msg");
		expect(debugSpy).toHaveBeenCalledWith("[test]", "dbg msg");

		debugSpy.mockClear();
		log.verbose("verbose msg");
		expect(debugSpy).toHaveBeenCalledWith("[test]", "verbose msg");
	});

	it("debug and verbose are silent when debug flag is disabled", () => {
		featureFlags.debug = false;
		const log = createFrontendLogger("test");

		log.debug("dbg msg");
		log.verbose("verbose msg");
		expect(debugSpy).not.toHaveBeenCalled();
	});

	it("info always fires (not DEV-gated)", () => {
		const log = createFrontendLogger("app");

		log.info("startup");
		expect(infoSpy).toHaveBeenCalledWith("[app]", "startup");
	});

	it("warn always fires (not DEV-gated)", () => {
		const log = createFrontendLogger("app");

		log.warn("deprecation");
		expect(warnSpy).toHaveBeenCalledWith("[app]", "deprecation");
	});

	it("error always fires (not DEV-gated)", () => {
		const log = createFrontendLogger("app");

		log.error("crash");
		expect(errorSpy).toHaveBeenCalledWith("[app]", "crash");
	});
});

// ─── child() ────────────────────────────────────────────────────────────────

describe("child()", () => {
	it("chains tags with colon separator", () => {
		const log = createFrontendLogger("ws");
		const child = log.child("parse");

		child.warn("invalid JSON");
		expect(warnSpy).toHaveBeenCalledWith("[ws:parse]", "invalid JSON");
	});

	it("supports multi-level nesting", () => {
		const log = createFrontendLogger("relay");
		const grandchild = log.child("sse").child("event");

		grandchild.info("received");
		expect(infoSpy).toHaveBeenCalledWith("[relay:sse:event]", "received");
	});
});

// ─── createSilentFrontendLogger ─────────────────────────────────────────────

describe("createSilentFrontendLogger", () => {
	it("does not call any console methods", () => {
		const log = createSilentFrontendLogger();

		log.debug("x");
		log.verbose("x");
		log.info("x");
		log.warn("x");
		log.error("x");

		expect(debugSpy).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("child() returns another silent logger", () => {
		const log = createSilentFrontendLogger();
		const child = log.child("anything");

		child.warn("should not appear");
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

// ─── onError hook ───────────────────────────────────────────────────────────

describe("onError hook", () => {
	it("calls onError after console.error", () => {
		const onError = vi.fn();
		const log = createFrontendLogger("reg", { onError });

		log.error("invariant violated");
		expect(errorSpy).toHaveBeenCalledWith("[reg]", "invariant violated");
		expect(onError).toHaveBeenCalledWith("invariant violated");
	});

	it("onError receives all args", () => {
		const onError = vi.fn();
		const log = createFrontendLogger("reg", { onError });
		const detail = { id: "t1" };

		log.error("bad transition", detail);
		expect(onError).toHaveBeenCalledWith("bad transition", detail);
	});

	it("onError is not called for non-error levels", () => {
		const onError = vi.fn();
		const log = createFrontendLogger("reg", { onError });

		log.debug("x");
		log.verbose("x");
		log.info("x");
		log.warn("x");
		expect(onError).not.toHaveBeenCalled();
	});

	it("onError propagates to child loggers", () => {
		const onError = vi.fn();
		const log = createFrontendLogger("parent", { onError });
		const child = log.child("child");

		child.error("boom");
		expect(errorSpy).toHaveBeenCalledWith("[parent:child]", "boom");
		expect(onError).toHaveBeenCalledWith("boom");
	});
});

// ─── Interface Compatibility ────────────────────────────────────────────────

describe("interface compatibility", () => {
	it("has the same method names as backend Logger", () => {
		const log = createFrontendLogger("test");
		const methods: (keyof FrontendLogger)[] = [
			"debug",
			"verbose",
			"info",
			"warn",
			"error",
			"child",
		];

		for (const method of methods) {
			expect(typeof log[method]).toBe("function");
		}
	});
});
