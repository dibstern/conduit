// ─── patchMissingDone — Claude SDK processing timeout guard (F3 fix) ────────
// Covers the widened guard in patchMissingDone that checks
// overrides?.hasActiveProcessingTimeout(sessionId) in addition to
// statusPoller?.isProcessing().
//
// Server Task 1: F3 fix — Claude SDK sessions may be processing via the
// in-process adapter without the OpenCode status poller knowing about it.

import { describe, expect, it, vi } from "vitest";
import {
	patchMissingDone,
	type SessionHistorySource,
	type SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";

/** Build a cached-events source with an active (unterminated) LLM turn. */
function makeActiveTurnSource(sessionId: string): SessionHistorySource {
	return {
		kind: "cached-events",
		events: [
			{ type: "user_message", sessionId, text: "hello" },
			{ type: "delta", sessionId, text: "I am responding" },
			// No done event — turn is active
		],
		hasMore: false,
	};
}

/** Build a cached-events source with a terminated LLM turn. */
function makeCompletedTurnSource(sessionId: string): SessionHistorySource {
	return {
		kind: "cached-events",
		events: [
			{ type: "user_message", sessionId, text: "hello" },
			{ type: "delta", sessionId, text: "done responding" },
			{ type: "done", sessionId, code: 0 },
		],
		hasMore: false,
	};
}

describe("patchMissingDone — Claude SDK processing timeout guard", () => {
	const SID = "ses_claude_1";

	// ── F3: poller idle but processingTimeout active → SKIP patch ───────────

	it("skips patch when poller says idle but processingTimeout is active", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(false),
		};
		const overrides: SessionSwitchDeps["overrides"] = {
			hasActiveProcessingTimeout: vi.fn().mockReturnValue(true),
		};

		const result = patchMissingDone(source, statusPoller, SID, overrides);

		// Source should be returned unchanged — no synthetic done appended
		expect(result).toBe(source);
		if (result.kind === "cached-events") {
			const hasDone = result.events.some((e) => e.type === "done");
			expect(hasDone).toBe(false);
		}
	});

	// ── Both poller idle and no processingTimeout → APPLY patch ─────────────

	it("applies patch when both poller idle and no processingTimeout", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(false),
		};
		const overrides: SessionSwitchDeps["overrides"] = {
			hasActiveProcessingTimeout: vi.fn().mockReturnValue(false),
		};

		const result = patchMissingDone(source, statusPoller, SID, overrides);

		// A new source should be returned with synthetic done appended
		expect(result).not.toBe(source);
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
		}
	});

	it("applies patch when overrides is undefined (no Claude SDK)", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(false),
		};

		const result = patchMissingDone(source, statusPoller, SID, undefined);

		expect(result).not.toBe(source);
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
		}
	});

	it("applies patch when both statusPoller and overrides are undefined", () => {
		const source = makeActiveTurnSource(SID);

		const result = patchMissingDone(source, undefined, SID, undefined);

		expect(result).not.toBe(source);
		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
		}
	});

	// ── Poller says processing → SKIP regardless of timeout ────────────────

	it("skips patch when poller says processing (regardless of timeout state)", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(true),
		};
		const overrides: SessionSwitchDeps["overrides"] = {
			hasActiveProcessingTimeout: vi.fn().mockReturnValue(false),
		};

		const result = patchMissingDone(source, statusPoller, SID, overrides);

		expect(result).toBe(source);
		if (result.kind === "cached-events") {
			const hasDone = result.events.some((e) => e.type === "done");
			expect(hasDone).toBe(false);
		}
	});

	it("skips patch when poller says processing AND timeout active", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(true),
		};
		const overrides: SessionSwitchDeps["overrides"] = {
			hasActiveProcessingTimeout: vi.fn().mockReturnValue(true),
		};

		const result = patchMissingDone(source, statusPoller, SID, overrides);

		expect(result).toBe(source);
	});

	// ── Synthesized done event should include sessionId ─────────────────────

	it("synthesized done event includes correct sessionId", () => {
		const source = makeActiveTurnSource(SID);

		const result = patchMissingDone(source, undefined, SID, undefined);

		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
			expect((done as { sessionId: string }).sessionId).toBe(SID);
			expect((done as { code: number }).code).toBe(0);
		}
	});

	it("synthesized done uses the provided sessionId, not a hardcoded value", () => {
		const customSid = "ses_custom_xyz";
		const source = makeActiveTurnSource(customSid);

		const result = patchMissingDone(source, undefined, customSid, undefined);

		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect((done as { sessionId: string }).sessionId).toBe(customSid);
		}
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it("does not patch when source is rest-history (not cached-events)", () => {
		const source: SessionHistorySource = {
			kind: "rest-history",
			history: { messages: [], hasMore: false },
		};

		const result = patchMissingDone(source, undefined, SID, undefined);

		expect(result).toBe(source);
		expect(result.kind).toBe("rest-history");
	});

	it("does not patch when source is empty", () => {
		const source: SessionHistorySource = { kind: "empty" };

		const result = patchMissingDone(source, undefined, SID, undefined);

		expect(result).toBe(source);
		expect(result.kind).toBe("empty");
	});

	it("does not patch when last turn is already terminated", () => {
		const source = makeCompletedTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(false),
		};

		const result = patchMissingDone(source, statusPoller, SID, undefined);

		// Source returned unchanged — no extra done needed
		expect(result).toBe(source);
	});

	it("overrides.hasActiveProcessingTimeout is called with correct sessionId", () => {
		const source = makeActiveTurnSource(SID);
		const statusPoller: SessionSwitchDeps["statusPoller"] = {
			isProcessing: vi.fn().mockReturnValue(false),
		};
		const overrides: SessionSwitchDeps["overrides"] = {
			hasActiveProcessingTimeout: vi.fn().mockReturnValue(true),
		};

		patchMissingDone(source, statusPoller, SID, overrides);

		expect(overrides.hasActiveProcessingTimeout).toHaveBeenCalledWith(SID);
	});
});
