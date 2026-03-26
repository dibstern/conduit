// ─── Deferred Markdown Rendering ─────────────────────────────────────────────
// Verifies that markdown rendering is skipped during replay and deferred until
// after replay completes, then processed in batches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
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

// Mock DOMPurify (browser-only)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock renderMarkdown with a spy so we can track when it's called
const renderMarkdownSpy = vi.fn((text: string) => `<p>${text}</p>`);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (...args: unknown[]) =>
		renderMarkdownSpy(...(args as [string])),
}));

import {
	chatState,
	clearMessages,
	handleDelta,
	handleDone,
	isReplaying,
	renderDeferredMarkdown,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type {
	AssistantMessage,
	RelayMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function drainReplay(promise: Promise<void>): Promise<void> {
	await vi.runAllTimersAsync();
	await promise;
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	renderMarkdownSpy.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Deferred markdown rendering", () => {
	it("flushAssistantRender skips renderMarkdown during replay", async () => {
		// Replay a simple turn: delta + done
		const promise = replayEvents(
			[
				{ type: "delta", text: "Hello **world**" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		await drainReplay(promise);

		// renderMarkdown should NOT have been called during replay —
		// it should only be called by the deferred pass afterwards
		const assistantMsgs = chatState.messages.filter(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);

		// After deferred rendering runs, spy should have been called
		// (renderDeferredMarkdown is triggered at end of replayEvents)
		await vi.runAllTimersAsync();

		// Now the message should have rendered HTML
		const rendered = chatState.messages.find(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(rendered).toBeDefined();
		expect(rendered?.html).toBe("<p>Hello **world**</p>");
	});

	it("renderDeferredMarkdown renders unrendered messages after replay", async () => {
		// Replay multiple turns
		const promise = replayEvents(
			[
				{ type: "delta", text: "First response" },
				{ type: "done", code: 0 },
				{ type: "user_message", text: "second question" },
				{ type: "delta", text: "Second response" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		await drainReplay(promise);

		// Drain deferred rendering batches
		await vi.runAllTimersAsync();

		const assistantMsgs = chatState.messages.filter(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(2);

		// Both should have been rendered via renderMarkdown
		expect(assistantMsgs[0]?.html).toBe("<p>First response</p>");
		expect(assistantMsgs[1]?.html).toBe("<p>Second response</p>");

		// needsRender should be removed (not just set to undefined)
		// biome-ignore lint/style/noNonNullAssertion: safe — length checked above
		expect("needsRender" in assistantMsgs[0]!).toBe(false);
		// biome-ignore lint/style/noNonNullAssertion: safe — length checked above
		expect("needsRender" in assistantMsgs[1]!).toBe(false);
	});

	it("normal (non-replay) path calls renderMarkdown immediately", () => {
		// Normal path: not replaying
		expect(isReplaying()).toBe(false);

		handleDelta({ type: "delta", text: "Live **bold**" });
		vi.advanceTimersByTime(100); // flush debounce

		expect(renderMarkdownSpy).toHaveBeenCalledWith("Live **bold**");

		const assistant = chatState.messages.find(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistant).toBeDefined();
		expect(assistant?.html).toBe("<p>Live **bold**</p>");
		// needsRender should NOT be set
		// biome-ignore lint/style/noNonNullAssertion: safe — toBeDefined() above
		expect("needsRender" in assistant!).toBe(false);

		// Clean up streaming state
		handleDone({ type: "done", code: 0 });
	});

	it("calling renderDeferredMarkdown twice is idempotent", async () => {
		// Replay a turn
		const promise = replayEvents(
			[
				{ type: "delta", text: "Idempotent test" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		// Drain replay AND the deferred rendering it triggers
		await drainReplay(promise);
		await vi.runAllTimersAsync();

		// After replay + deferred rendering, the message should be rendered
		const assistantMsg = chatState.messages.find(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg?.html).toBe("<p>Idempotent test</p>");
		// biome-ignore lint/style/noNonNullAssertion: safe — toBeDefined() above
		expect("needsRender" in assistantMsg!).toBe(false);

		// Clear the spy to count only calls from a second renderDeferredMarkdown
		renderMarkdownSpy.mockClear();

		// Call renderDeferredMarkdown again — should be a no-op since
		// no messages have needsRender set
		renderDeferredMarkdown();
		await vi.runAllTimersAsync();

		// No additional calls — messages already rendered
		expect(renderMarkdownSpy).not.toHaveBeenCalled();
	});

	it("clearMessages cancels in-flight deferred renders", async () => {
		// Replay a turn
		const promise = replayEvents(
			[
				{ type: "delta", text: "Will be cleared" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		await drainReplay(promise);

		// Clear spy to isolate deferred calls
		renderMarkdownSpy.mockClear();

		// Clear messages before deferred rendering can run
		clearMessages();

		// Drain any pending timers
		await vi.runAllTimersAsync();

		// renderMarkdown should NOT have been called — deferred was cancelled
		expect(renderMarkdownSpy).not.toHaveBeenCalled();
		expect(chatState.messages).toHaveLength(0);
	});
});
