// ─── ChatPhase Discriminated Union Tests ─────────────────────────────────────
// Verifies that chatState.phase is the single source of truth for
// processing/streaming, with backward-compatible getters.
// Replaying is now tracked via loadLifecycle, not phase.

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

vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import type { ChatPhase } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	chatState,
	clearMessages,
	handleDelta,
	handleDone,
	handleStatus,
	isLoading,
	isProcessing,
	isReplaying,
	isStreaming,
	phaseEndReplay,
	phaseStartReplay,
	phaseToIdle,
	phaseToProcessing,
	phaseToStreaming,
	renderDeferredMarkdown,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

// Helper to create typed status messages
function statusMsg(status: string) {
	return { type: "status" as const, status };
}

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── LoadLifecycle ──────────────────────────────────────────────────────────

describe("LoadLifecycle", () => {
	it("defaults to 'empty'", () => {
		expect(chatState.loadLifecycle).toBe("empty");
	});

	it("isLoading() returns true only when loading", () => {
		chatState.loadLifecycle = "loading";
		expect(isLoading()).toBe(true);
		chatState.loadLifecycle = "empty";
		expect(isLoading()).toBe(false);
	});

	it("clearMessages resets loadLifecycle to 'empty'", () => {
		chatState.loadLifecycle = "loading";
		clearMessages();
		expect(chatState.loadLifecycle).toBe("empty");
	});
});

// ─── Phase field exists and defaults correctly ──────────────────────────────

describe("ChatPhase type", () => {
	it("chatState.phase defaults to 'idle'", () => {
		expect(chatState.phase).toBe("idle");
	});

	it("clearMessages resets phase to 'idle'", () => {
		phaseToStreaming();
		expect(chatState.phase).not.toBe("idle");
		clearMessages();
		expect(chatState.phase).toBe("idle");
	});
});

// ─── Backward-compatible getters derive from phase + loadLifecycle ──────────

describe("backward-compatible getters", () => {
	it("idle: processing=false, streaming=false, replaying=false", () => {
		expect(chatState.phase).toBe("idle");
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
		expect(isReplaying()).toBe(false);
	});

	it("processing: processing=true, streaming=false, replaying=false", () => {
		handleStatus(statusMsg("processing"));
		expect(chatState.phase).toBe("processing");
		expect(isProcessing()).toBe(true);
		expect(isStreaming()).toBe(false);
		expect(isReplaying()).toBe(false);
	});

	it("streaming: streaming=true, replaying=false", () => {
		handleDelta({ type: "delta", text: "hello" });
		expect(chatState.phase).toBe("streaming");
		expect(isStreaming()).toBe(true);
		expect(isReplaying()).toBe(false);
	});

	it("replaying: replaying=true, processing=false, streaming=false", () => {
		phaseStartReplay();
		expect(chatState.loadLifecycle).toBe("loading");
		expect(isReplaying()).toBe(true);
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});
});

// ─── Transitions change phase correctly ─────────────────────────────────────

describe("phase transitions", () => {
	it("handleStatus('processing') → phase='processing'", () => {
		handleStatus(statusMsg("processing"));
		expect(chatState.phase).toBe("processing");
	});

	it("handleDelta → phase='streaming'", () => {
		handleDelta({ type: "delta", text: "hello" });
		expect(chatState.phase).toBe("streaming");
	});

	it("handleDone → phase='idle'", () => {
		handleDelta({ type: "delta", text: "hello" });
		handleDone({ type: "done", code: 0 });
		expect(chatState.phase).toBe("idle");
	});

	it("phaseStartReplay → loadLifecycle='loading'", () => {
		phaseStartReplay();
		expect(chatState.loadLifecycle).toBe("loading");
	});

	it("phaseEndReplay(false) → loadLifecycle stays 'loading' (renderDeferredMarkdown sets ready), phase stays idle", () => {
		phaseStartReplay();
		phaseEndReplay(false);
		// phaseEndReplay no longer sets loadLifecycle — that's renderDeferredMarkdown's job
		expect(chatState.loadLifecycle).toBe("loading");
		expect(chatState.phase).toBe("idle");
	});

	it("phaseEndReplay(true) → phase='processing' when idle, loadLifecycle unchanged", () => {
		phaseStartReplay();
		phaseEndReplay(true);
		expect(chatState.loadLifecycle).toBe("loading");
		expect(chatState.phase).toBe("processing");
	});

	it("phaseToIdle → phase='idle' from any state", () => {
		phaseToStreaming();
		phaseToIdle();
		expect(chatState.phase).toBe("idle");
	});
});

// ─── Impossible states are unrepresentable ──────────────────────────────────

describe("impossible states prevented", () => {
	it("phase is always one of the valid values", () => {
		const validPhases: ChatPhase[] = ["idle", "processing", "streaming"];

		// Run through various transitions
		expect(validPhases).toContain(chatState.phase);

		handleStatus(statusMsg("processing"));
		expect(validPhases).toContain(chatState.phase);

		handleDelta({ type: "delta", text: "x" });
		expect(validPhases).toContain(chatState.phase);

		handleDone({ type: "done", code: 0 });
		expect(validPhases).toContain(chatState.phase);

		phaseStartReplay();
		expect(validPhases).toContain(chatState.phase);

		phaseEndReplay(false);
		expect(validPhases).toContain(chatState.phase);
	});

	it("streaming=true and processing=false cannot coexist when phase is correct", () => {
		// With the old booleans, you could do chatState.streaming = true
		// without setting processing = true. With the union, streaming
		// phase means streaming getter returns true, and processing getter
		// derives from phase — no inconsistency possible.
		phaseToStreaming();
		// streaming is true — and phase is "streaming"
		expect(isStreaming()).toBe(true);
		expect(chatState.phase).toBe("streaming");
	});
});

// ─── Phase split: replaying removed from ChatPhase ──────────────────────────

describe("Phase split: replaying removed from ChatPhase", () => {
	it("isProcessing() returns false during loading even if phase is processing", () => {
		chatState.phase = "processing";
		chatState.loadLifecycle = "loading";
		expect(isProcessing()).toBe(false);
	});

	it("isProcessing() returns true when not loading and phase is processing", () => {
		chatState.phase = "processing";
		chatState.loadLifecycle = "ready";
		expect(isProcessing()).toBe(true);
	});

	it("phaseToStreaming sets phase directly (no _replayInnerStreaming)", () => {
		chatState.loadLifecycle = "loading";
		phaseToStreaming();
		expect(chatState.phase).toBe("streaming");
		expect(isStreaming()).toBe(false);
	});

	it("phaseToProcessing sets phase even during loading", () => {
		chatState.loadLifecycle = "loading";
		phaseToProcessing();
		expect(chatState.phase).toBe("processing");
	});

	it("phaseEndReplay with streaming phase preserves streaming, loadLifecycle unchanged", () => {
		phaseStartReplay();
		expect(chatState.loadLifecycle).toBe("loading");
		phaseToStreaming();
		expect(chatState.phase).toBe("streaming");
		expect(isStreaming()).toBe(false); // gated by loading
		phaseEndReplay(true);
		// phaseEndReplay does NOT set loadLifecycle (that's renderDeferredMarkdown's job).
		// But it also doesn't change phase since it's already streaming (not idle).
		expect(chatState.loadLifecycle).toBe("loading");
		expect(chatState.phase).toBe("streaming");
		// Still gated by loading — isStreaming/isProcessing stay false until
		// renderDeferredMarkdown sets loadLifecycle = "ready"
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
	});
});

// ─── LoadLifecycle 'ready' transition ───────────────────────────────────────

describe("LoadLifecycle 'ready' transition", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("renderDeferredMarkdown sets loadLifecycle to 'ready' after all messages rendered", () => {
		chatState.loadLifecycle = "committed";
		chatState.messages = [
			{
				type: "assistant",
				uuid: "1",
				rawText: "hello",
				html: "hello",
				needsRender: true,
				finalized: true,
			},
		];
		renderDeferredMarkdown();
		vi.runAllTimers();
		expect(chatState.loadLifecycle).toBe("ready");
	});

	it("loadLifecycle stays 'committed' while deferred markdown is still processing", () => {
		chatState.loadLifecycle = "committed";
		chatState.messages = Array.from({ length: 10 }, (_, i) => ({
			type: "assistant" as const,
			uuid: String(i),
			rawText: `msg ${i}`,
			html: `msg ${i}`,
			needsRender: true as const,
			finalized: true,
		}));
		renderDeferredMarkdown();
		vi.runOnlyPendingTimers();
		// First batch processed (5 messages), but 5 more remain
		expect(chatState.loadLifecycle).toBe("committed");
	});
});
