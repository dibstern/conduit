import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	applyPipelineResult,
	type PipelineDeps,
	type PipelineResult,
	processEvent,
	resolveRoute,
	resolveTimeout,
	shouldCache,
	truncateIfNeeded,
} from "../../../src/lib/relay/event-pipeline.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── truncateIfNeeded ────────────────────────────────────────────────────────

describe("truncateIfNeeded", () => {
	it("passes through non-tool_result messages unchanged", () => {
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result = truncateIfNeeded(msg);
		expect(result.msg).toBe(msg);
		expect(result.fullContent).toBeUndefined();
	});

	it("truncates tool_result with content over threshold", () => {
		const content = "x".repeat(60_000);
		const msg: RelayMessage = {
			type: "tool_result",
			id: "t1",
			content,
			is_error: false,
		};
		const result = truncateIfNeeded(msg);
		expect(result.msg.type).toBe("tool_result");
		if (result.msg.type === "tool_result") {
			expect(result.msg.content.length).toBeLessThan(content.length);
			expect(result.msg.isTruncated).toBe(true);
			expect(result.msg.fullContentLength).toBe(content.length);
		}
		expect(result.fullContent).toBe(content);
	});

	it("does not truncate tool_result under threshold", () => {
		const msg: RelayMessage = {
			type: "tool_result",
			id: "t1",
			content: "short",
			is_error: false,
		};
		const result = truncateIfNeeded(msg);
		expect(result.msg).toBe(msg);
		expect(result.fullContent).toBeUndefined();
	});
});

// ─── resolveRoute ────────────────────────────────────────────────────────────

describe("resolveRoute", () => {
	it("returns send when viewers exist", () => {
		const result = resolveRoute("delta", "ses_abc", ["client1"]);
		expect(result).toEqual({ action: "send", sessionId: "ses_abc" });
	});

	it("returns drop with reason when no viewers", () => {
		const result = resolveRoute("tool_result", "ses_abc", []);
		expect(result).toEqual({
			action: "drop",
			reason: "no viewers for session ses_abc",
		});
	});

	it("returns drop when no sessionId", () => {
		const result = resolveRoute("delta", undefined, []);
		expect(result).toEqual({ action: "drop", reason: "no session ID" });
	});

	it("returns drop when sessionId is undefined even with viewers listed", () => {
		const result = resolveRoute("delta", undefined, ["c1"]);
		expect(result).toEqual({ action: "drop", reason: "no session ID" });
	});
});

// ─── shouldCache ─────────────────────────────────────────────────────────────

describe("shouldCache", () => {
	it("returns true for chat event types", () => {
		const cacheableTypes = [
			"user_message",
			"delta",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"tool_start",
			"tool_executing",
			"tool_result",
			"result",
			"done",
			"error",
		] as const;
		for (const type of cacheableTypes) {
			expect(shouldCache(type)).toBe(true);
		}
	});

	it("returns false for non-chat event types", () => {
		const nonCacheable = [
			"permission_request",
			"permission_resolved",
			"file_changed",
			"session_list",
			"todo_state",
			"pty_created",
			"pty_output",
			// status events are sent directly via wsHandler, never through the
			// pipeline — so they should NOT be cacheable.
			"status",
		] as const;
		for (const type of nonCacheable) {
			expect(shouldCache(type)).toBe(false);
		}
	});
});

// ─── resolveTimeout ──────────────────────────────────────────────────────────

describe("resolveTimeout", () => {
	it("returns clear for done events with sessionId", () => {
		expect(resolveTimeout("done", "ses_abc")).toBe("clear");
	});

	it("returns clear for ask_user events with sessionId", () => {
		expect(resolveTimeout("ask_user", "ses_abc")).toBe("clear");
	});

	it("returns reset for non-done events with sessionId", () => {
		expect(resolveTimeout("delta", "ses_abc")).toBe("reset");
		expect(resolveTimeout("tool_result", "ses_abc")).toBe("reset");
		expect(resolveTimeout("status", "ses_abc")).toBe("reset");
	});

	it("returns none when no sessionId", () => {
		expect(resolveTimeout("delta", undefined)).toBe("none");
		expect(resolveTimeout("done", undefined)).toBe("none");
	});
});

// ─── processEvent (composed pipeline) ────────────────────────────────────────

describe("processEvent (composed pipeline)", () => {
	it("composes all decisions for a normal message with viewers", () => {
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result = processEvent(msg, "ses_abc", ["c1"]);
		expect(result.msg).toBe(msg);
		expect(result.fullContent).toBeUndefined();
		expect(result.route).toEqual({ action: "send", sessionId: "ses_abc" });
		expect(result.cache).toBe(true);
		expect(result.timeout).toBe("reset");
		expect(result.source).toBe("sse");
	});

	it("marks done events with clear timeout", () => {
		const msg: RelayMessage = { type: "done", code: 0 };
		const result = processEvent(msg, "ses_abc", ["c1"]);
		expect(result.timeout).toBe("clear");
		expect(result.cache).toBe(true);
		expect(result.route).toEqual({ action: "send", sessionId: "ses_abc" });
		expect(result.source).toBe("sse");
	});

	it("drops events with no sessionId", () => {
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result = processEvent(msg, undefined, []);
		expect(result.route).toEqual({ action: "drop", reason: "no session ID" });
		expect(result.cache).toBe(false);
		expect(result.timeout).toBe("none");
		expect(result.source).toBe("sse");
	});

	it("caches but drops routing when no viewers", () => {
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result = processEvent(msg, "ses_abc", []);
		expect(result.cache).toBe(true);
		expect(result.route).toEqual({
			action: "drop",
			reason: "no viewers for session ses_abc",
		});
		expect(result.source).toBe("sse");
	});

	it("does not cache non-cacheable types", () => {
		const msg: RelayMessage = {
			type: "file_changed",
			path: "/foo.ts",
			changeType: "edited",
		};
		const result = processEvent(msg, "ses_abc", ["c1"]);
		expect(result.cache).toBe(false);
		expect(result.route).toEqual({ action: "send", sessionId: "ses_abc" });
		expect(result.source).toBe("sse");
	});

	it("truncates large tool_result and preserves full content", () => {
		const content = "x".repeat(60_000);
		const msg: RelayMessage = {
			type: "tool_result",
			id: "t1",
			content,
			is_error: false,
		};
		const result = processEvent(msg, "ses_abc", ["c1"]);
		expect(result.fullContent).toBe(content);
		if (result.msg.type === "tool_result") {
			expect(result.msg.content.length).toBeLessThan(content.length);
			expect(result.msg.isTruncated).toBe(true);
		}
		expect(result.source).toBe("sse");
	});

	it("includes explicit source when provided", () => {
		const msg: RelayMessage = { type: "done", code: 0 };
		const result = processEvent(msg, "ses_abc", ["c1"], "status-poller");
		expect(result.source).toBe("status-poller");
	});
});

// ─── applyPipelineResult ─────────────────────────────────────────────────────

function makeDeps(): PipelineDeps & {
	toolContentStore: { store: ReturnType<typeof vi.fn> };
	overrides: {
		clearProcessingTimeout: ReturnType<typeof vi.fn>;
		resetProcessingTimeout: ReturnType<typeof vi.fn>;
	};
	messageCache: { recordEvent: ReturnType<typeof vi.fn> };
	wsHandler: { sendToSession: ReturnType<typeof vi.fn> };
	log: ReturnType<typeof createSilentLogger> & {
		debug: ReturnType<typeof vi.fn>;
		verbose: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
	};
} {
	const debugSpy = vi.fn();
	const verboseSpy = vi.fn();
	const infoSpy = vi.fn();
	return {
		toolContentStore: { store: vi.fn() },
		overrides: {
			clearProcessingTimeout: vi.fn(),
			resetProcessingTimeout: vi.fn(),
		},
		messageCache: { recordEvent: vi.fn() },
		wsHandler: { sendToSession: vi.fn() },
		log: {
			...createSilentLogger(),
			debug: debugSpy,
			verbose: verboseSpy,
			info: infoSpy,
		},
	};
}

describe("applyPipelineResult", () => {
	it("stores full content when truncated", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: {
				type: "tool_result",
				id: "t1",
				content: "short",
				is_error: false,
				isTruncated: true,
				fullContentLength: 60000,
			},
			fullContent: "x".repeat(60000),
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.toolContentStore.store).toHaveBeenCalledWith(
			"t1",
			result.fullContent,
			"ses_abc",
		);
	});

	it("skips fullContent storage when no sessionId", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "tool_result", id: "t1", content: "short", is_error: false },
			fullContent: "full content here",
			route: { action: "drop", reason: "no session ID" },
			cache: false,
			timeout: "none",
			source: "sse",
		};
		applyPipelineResult(result, undefined, deps);
		expect(deps.toolContentStore.store).not.toHaveBeenCalled();
	});

	it("clears timeout for done events", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "done", code: 0 },
			fullContent: undefined,
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "clear",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"ses_abc",
		);
		expect(deps.overrides.resetProcessingTimeout).not.toHaveBeenCalled();
	});

	it("resets timeout for normal events", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "delta", text: "hi" },
			fullContent: undefined,
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledWith(
			"ses_abc",
		);
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("caches cacheable messages", () => {
		const deps = makeDeps();
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result: PipelineResult = {
			msg,
			fullContent: undefined,
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith("ses_abc", msg);
	});

	it("does not cache non-cacheable messages", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "file_changed", path: "/foo.ts", changeType: "edited" },
			fullContent: undefined,
			route: { action: "send", sessionId: "ses_abc" },
			cache: false,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
	});

	it("sends to session when route action is send", () => {
		const deps = makeDeps();
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result: PipelineResult = {
			msg,
			fullContent: undefined,
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("ses_abc", msg);
		expect(deps.log.debug).not.toHaveBeenCalled();
	});

	it("logs drop reason when route action is drop", () => {
		const deps = makeDeps();
		const msg: RelayMessage = { type: "delta", text: "hi" };
		const result: PipelineResult = {
			msg,
			fullContent: undefined,
			route: { action: "drop", reason: "no viewers for session ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.log.info).toHaveBeenCalledWith(
			"no viewers for session ses_abc — delta (sse)",
		);
	});

	it("does not store fullContent when msg is not a tool_result", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "delta", text: "hi" },
			fullContent: "some content that somehow got set",
			route: { action: "send", sessionId: "ses_abc" },
			cache: true,
			timeout: "reset",
			source: "sse",
		};
		applyPipelineResult(result, "ses_abc", deps);
		expect(deps.toolContentStore.store).not.toHaveBeenCalled();
	});

	it("skips timeout actions when no sessionId", () => {
		const deps = makeDeps();
		const result: PipelineResult = {
			msg: { type: "delta", text: "hi" },
			fullContent: undefined,
			route: { action: "drop", reason: "no session ID" },
			cache: false,
			timeout: "none",
			source: "sse",
		};
		applyPipelineResult(result, undefined, deps);
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
		expect(deps.overrides.resetProcessingTimeout).not.toHaveBeenCalled();
	});
});
