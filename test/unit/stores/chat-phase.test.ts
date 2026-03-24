// ─── ChatPhase Discriminated Union Tests ─────────────────────────────────────
// Verifies that chatState.phase is the single source of truth for
// processing/streaming/replaying, with backward-compatible getters.

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
	isProcessing,
	isReplaying,
	isStreaming,
	phaseEndReplay,
	phaseStartReplay,
	phaseToIdle,
	phaseToStreaming,
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

// ─── Backward-compatible getters derive from phase ──────────────────────────

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
		expect(chatState.phase).toBe("replaying");
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

	it("phaseStartReplay → phase='replaying'", () => {
		phaseStartReplay();
		expect(chatState.phase).toBe("replaying");
	});

	it("phaseEndReplay(false) → phase='idle'", () => {
		phaseStartReplay();
		phaseEndReplay(false);
		expect(chatState.phase).toBe("idle");
	});

	it("phaseEndReplay(true) → phase='processing'", () => {
		phaseStartReplay();
		phaseEndReplay(true);
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
		const validPhases: ChatPhase[] = [
			"idle",
			"processing",
			"streaming",
			"replaying",
		];

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
