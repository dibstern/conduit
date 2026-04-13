import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	buildSeedSnapshot,
	diffAndSynthesize,
	MessagePoller,
	type MessagePollerOptions,
	type PartSnapshot,
	synthesizeTextPart,
	synthesizeToolPart,
} from "../../../src/lib/relay/message-poller.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Constants (mirror source) ──────────────────────────────────────────────

const POLL_INTERVAL_MS = 750;
const SSE_SILENCE_THRESHOLD_MS = 2000;
const IDLE_TIMEOUT_MS = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockClient(messages: Message[] = []) {
	return {
		session: { messages: vi.fn().mockResolvedValue(messages) },
	};
}

function makeMessage(
	overrides: Partial<Message> & { id: string; sessionID: string },
): Message {
	return {
		role: "assistant",
		parts: [],
		...overrides,
	};
}

function makeTextPart(id: string, text: string) {
	return { id, type: "text", text };
}

function makeReasoningPart(
	id: string,
	text: string,
	time?: { start?: number; end?: number },
) {
	return { id, type: "reasoning", text, time };
}

function makeToolPart(
	id: string,
	tool: string,
	status: string,
	extra: {
		input?: unknown;
		output?: string;
		error?: string;
		callID?: string;
	} = {},
) {
	return {
		id,
		type: "tool",
		tool,
		callID: extra.callID ?? id,
		state: {
			status,
			input: extra.input,
			output: extra.output,
			error: extra.error,
		},
	};
}

/** Collect all emitted event arrays flattened into a single array. */
function collectEvents(poller: MessagePoller): RelayMessage[] {
	const collected: RelayMessage[] = [];
	poller.on("events", (evts) => collected.push(...evts));
	return collected;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("MessagePoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createPoller(
		client: ReturnType<typeof createMockClient>,
		interval = POLL_INTERVAL_MS,
	) {
		return new MessagePoller(new ServiceRegistry(), {
			client: client as unknown as MessagePollerOptions["client"],
			interval,
			log: createSilentLogger(),
		});
	}

	// ─── Core lifecycle ───────────────────────────────────────────────────

	describe("core lifecycle", () => {
		it("startPolling() starts an interval timer and does an immediate first poll", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");

			// Immediate poll fires synchronously (as a microtask)
			await vi.advanceTimersByTimeAsync(0);
			expect(client.session.messages).toHaveBeenCalledTimes(1);
			expect(client.session.messages).toHaveBeenCalledWith("sess_1");

			// After one interval, second poll fires
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(client.session.messages).toHaveBeenCalledTimes(2);

			poller.stopPolling();
		});

		it("stopPolling() clears the timer and resets state", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			const callsBefore = client.session.messages.mock.calls.length;

			poller.stopPolling();

			expect(poller.isPolling()).toBe(false);
			expect(poller.getPollingSessionId()).toBeNull();

			// No further polls after stop
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
			expect(client.session.messages).toHaveBeenCalledTimes(callsBefore);
		});

		it("isPolling() returns correct state", () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			expect(poller.isPolling()).toBe(false);
			poller.startPolling("sess_1");
			expect(poller.isPolling()).toBe(true);
			poller.stopPolling();
			expect(poller.isPolling()).toBe(false);
		});

		it("getPollingSessionId() returns the active session ID", () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			expect(poller.getPollingSessionId()).toBeNull();
			poller.startPolling("sess_42");
			expect(poller.getPollingSessionId()).toBe("sess_42");
			poller.stopPolling();
			expect(poller.getPollingSessionId()).toBeNull();
		});

		it("starting polling for same session is a no-op (idempotent)", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			const callsAfterFirst = client.session.messages.mock.calls.length;

			// Start again for the same session — should be a no-op
			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// No additional immediate poll from the second startPolling
			expect(client.session.messages).toHaveBeenCalledTimes(callsAfterFirst);

			poller.stopPolling();
		});

		it("starting polling for a different session stops the old one first", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(poller.getPollingSessionId()).toBe("sess_1");

			// Switch to a different session
			poller.startPolling("sess_2");
			expect(poller.getPollingSessionId()).toBe("sess_2");

			// The immediate poll should target sess_2
			await vi.advanceTimersByTimeAsync(0);
			const lastCall =
				client.session.messages.mock.calls[
					client.session.messages.mock.calls.length - 1
				];
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(lastCall![0]).toBe("sess_2");

			poller.stopPolling();
		});
	});

	// ─── Diff + Synthesis ─────────────────────────────────────────────────

	describe("diffAndSynthesize", () => {
		it("first poll seeds, second poll with new text emits delta", async () => {
			// First poll seeds the baseline (no events emitted).
			// New content on second poll produces events.
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(events).toHaveLength(0); // Seed — no events

			// New content appears
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello world")],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "delta",
				text: "Hello world",
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("subsequent polls with more text emit delta with only the new suffix", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// Clear collected events
			events.length = 0;

			// Text grows
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [makeTextPart("p1", "Hello world")],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "delta",
				text: " world",
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("no changes between polls → no events emitted", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Static text")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// First poll seeds — no events emitted
			expect(events).toHaveLength(0);

			// Same data on second poll — still no events
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(events).toHaveLength(0);

			poller.stopPolling();
		});

		it("user message (role=user) emits a user_message event", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// New user message appears
			const msg = makeMessage({
				id: "msg_u1",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p1", "What is 2+2?")],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "user_message",
				text: "What is 2+2?",
			});

			poller.stopPolling();
		});

		it("reasoning/thinking part emits thinking_start then thinking_delta", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// New reasoning part appears
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeReasoningPart("p1", "Let me think...")],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			const thinkingStart = events.find((e) => e.type === "thinking_start");
			const thinkingDelta = events.find((e) => e.type === "thinking_delta");

			expect(thinkingStart).toEqual({
				type: "thinking_start",
				messageId: "msg_1",
			});
			expect(thinkingDelta).toEqual({
				type: "thinking_delta",
				text: "Let me think...",
				messageId: "msg_1",
			});

			// thinking_start should come before thinking_delta
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const startIdx = events.indexOf(thinkingStart!);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const deltaIdx = events.indexOf(thinkingDelta!);
			expect(startIdx).toBeLessThan(deltaIdx);

			poller.stopPolling();
		});

		it("tool part pending → emits tool_start", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// New pending tool appears
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeToolPart("t1", "read", "pending")],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "tool_start",
				id: "t1",
				name: "Read",
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("tool part running → emits tool_executing", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// New running tool appears
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeToolPart("t1", "bash", "running", {
						input: { command: "ls" },
					}),
				],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "tool_executing",
				id: "t1",
				name: "Bash",
				input: { command: "ls" },
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("tool part completed → emits tool_result", async () => {
			// First see it as running
			const runningMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeToolPart("t1", "read", "running", { input: { path: "/a" } }),
				],
			});
			const client = createMockClient([runningMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			events.length = 0;

			// Now completed
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [
						makeToolPart("t1", "read", "completed", {
							input: { path: "/a" },
							output: "file contents",
						}),
					],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "tool_result",
				id: "t1",
				content: "file contents",
				is_error: false,
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("tool part error → emits tool_result with is_error=true", async () => {
			// First see it as running
			const runningMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeToolPart("t1", "bash", "running", { input: { command: "fail" } }),
				],
			});
			const client = createMockClient([runningMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			events.length = 0;

			// Now errored
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [
						makeToolPart("t1", "bash", "error", {
							input: { command: "fail" },
							error: "command not found",
						}),
					],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "tool_result",
				id: "t1",
				content: "command not found",
				is_error: true,
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("tool part jumps from new to completed → emits tool_start + tool_executing + tool_result (catch-up)", async () => {
			// Never saw this tool before — it appears already completed
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// Completed tool appears (skipped pending/running states)
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeToolPart("t1", "write", "completed", {
						input: { path: "/a" },
						output: "ok",
					}),
				],
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			const toolEvents = events.filter(
				(e) =>
					e.type === "tool_start" ||
					e.type === "tool_executing" ||
					e.type === "tool_result",
			);

			expect(toolEvents).toHaveLength(3);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(toolEvents[0]!.type).toBe("tool_start");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(toolEvents[1]!.type).toBe("tool_executing");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(toolEvents[2]!.type).toBe("tool_result");

			// Verify tool_result content
			const result = toolEvents[2] as Extract<
				RelayMessage,
				{ type: "tool_result" }
			>;
			expect(result.content).toBe("ok");
			expect(result.is_error).toBe(false);

			poller.stopPolling();
		});

		it("assistant message with cost/token data emits a result event", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // Seed from empty

			// New assistant message with cost data appears
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p1", "Answer")],
				cost: 0.005,
				tokens: {
					input: 100,
					output: 50,
					cache: { read: 10, write: 5 },
				},
				time: { created: 1000, completed: 2000 },
			});
			client.session.messages.mockResolvedValue([msg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			const resultEvent = events.find((e) => e.type === "result") as Extract<
				RelayMessage,
				{ type: "result" }
			>;
			expect(resultEvent).toBeDefined();
			expect(resultEvent.cost).toBe(0.005);
			expect(resultEvent.duration).toBe(1000);
			expect(resultEvent.sessionId).toBe("sess_1");
			expect(resultEvent.usage).toEqual({
				input: 100,
				output: 50,
				cache_read: 10,
				cache_creation: 5,
			});

			poller.stopPolling();
		});
	});

	// ─── SSE suppression ──────────────────────────────────────────────────

	describe("SSE suppression", () => {
		it("after notifySSEEvent(), isSSEActive() returns true", () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			expect(poller.isSSEActive()).toBe(false);

			poller.notifySSEEvent("sess_1");
			expect(poller.isSSEActive()).toBe(true);

			poller.stopPolling();
		});

		it("when SSE is active, poll() is skipped (no REST calls)", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll
			const callsAfterStart = client.session.messages.mock.calls.length;

			// Activate SSE
			poller.notifySSEEvent("sess_1");

			// Advance past several poll intervals
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

			// No new REST calls while SSE is active
			expect(client.session.messages).toHaveBeenCalledTimes(callsAfterStart);

			poller.stopPolling();
		});

		it("after SSE_SILENCE_THRESHOLD_MS, isSSEActive() returns false and polling resumes", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll
			const callsAfterStart = client.session.messages.mock.calls.length;

			// Activate SSE
			poller.notifySSEEvent("sess_1");

			// Advance past the silence threshold
			await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS);
			expect(poller.isSSEActive()).toBe(false);

			// Advance one more poll interval — polling should resume
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(client.session.messages.mock.calls.length).toBeGreaterThan(
				callsAfterStart,
			);

			poller.stopPolling();
		});

		it("after SSE silence, first poll reseeds instead of synthesizing", async () => {
			const seedMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});
			const client = createMockClient([seedMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			// Start polling with seed messages
			poller.startPolling("sess_1", [seedMsg]);
			await vi.advanceTimersByTimeAsync(0); // immediate poll — no events (seeded)
			expect(events).toHaveLength(0);
			events.length = 0;

			// Simulate SSE delivering new content
			poller.notifySSEEvent("sess_1");

			// Update what the REST API returns (SSE delivered new text)
			const updatedMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello world — SSE delivered this")],
			});
			client.session.messages.mockResolvedValue([updatedMsg]);

			// Wait for SSE silence
			await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS);

			const callsBefore = client.session.messages.mock.calls.length;

			// First poll after SSE silence — should reseed, no events emitted
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(client.session.messages.mock.calls.length).toBeGreaterThan(
				callsBefore,
			);
			expect(events).toHaveLength(0); // Reseed poll emits nothing

			// Second poll after SSE silence — normal diffing, no new content
			events.length = 0;
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(events).toHaveLength(0); // Snapshot is current, nothing new

			poller.stopPolling();
		});

		it("reseed prevents duplicate events for SSE-delivered content", async () => {
			// Start with an empty message list
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll — empty, no events
			expect(events).toHaveLength(0);

			// Simulate SSE delivering content (notifySSEEvent marks needsReseed)
			poller.notifySSEEvent("sess_1");

			// Now the REST API returns messages that SSE already delivered
			const deliveredMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Content delivered by SSE")],
			});
			client.session.messages.mockResolvedValue([deliveredMsg]);

			// Wait for SSE silence
			await vi.advanceTimersByTimeAsync(SSE_SILENCE_THRESHOLD_MS);

			// First poll after silence — reseed, no events despite new messages
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(events).toHaveLength(0);

			// Second poll — normal diff, but snapshot is current so still no events
			events.length = 0;
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(events).toHaveLength(0);

			poller.stopPolling();
		});

		it("needsReseed is cleared on startPolling", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			// Start polling and notify SSE (sets needsReseed = true)
			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll (seeds)
			poller.notifySSEEvent("sess_1");

			// Now restart polling for a different session (clears needsReseed
			// AND needsSeedOnFirstPoll, so first poll seeds fresh for new session)
			const msg = makeMessage({
				id: "msg_2",
				sessionID: "sess_2",
				parts: [makeTextPart("p1", "New session content")],
			});
			client.session.messages.mockResolvedValue([msg]);

			poller.startPolling("sess_2");
			await vi.advanceTimersByTimeAsync(0); // immediate poll (seeds for sess_2)

			// First poll seeds for the new session (no events on seed poll).
			// Verify: the poller should fetch messages and build a seed snapshot,
			// NOT do a reseed (needsReseed was cleared by startPolling).
			expect(client.session.messages).toHaveBeenLastCalledWith("sess_2");

			poller.stopPolling();
		});
	});

	// ─── Idle timeout ─────────────────────────────────────────────────────

	describe("idle timeout", () => {
		it("after IDLE_TIMEOUT_MS with no content changes, poller auto-stops", async () => {
			// Return empty messages so no content is ever detected
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll

			expect(poller.isPolling()).toBe(true);

			// Advance past idle timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + POLL_INTERVAL_MS);

			expect(poller.isPolling()).toBe(false);
		});

		it("content detection resets the idle timer", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll — emits delta, resets idle

			// Advance close to idle timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(true);

			// New content appears — should reset idle timer
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [makeTextPart("p1", "Hello world")],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(true);

			// Advance close to idle timeout again from this new content point
			// Should still be polling since idle timer was reset by new content
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(true);

			poller.stopPolling();
		});

		it("after auto-stop, isPolling() returns false", async () => {
			const client = createMockClient([]);
			const poller = createPoller(client);

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// Advance past idle timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + POLL_INTERVAL_MS);

			expect(poller.isPolling()).toBe(false);
			expect(poller.getPollingSessionId()).toBeNull();
		});
	});

	// ─── Viewer-aware idle suppression ───────────────────────────────────

	describe("hasViewers idle suppression", () => {
		it("poller stays alive past IDLE_TIMEOUT_MS when hasViewers returns true", async () => {
			const client = createMockClient([]);
			const poller = new MessagePoller(new ServiceRegistry(), {
				client: client as unknown as MessagePollerOptions["client"],
				interval: POLL_INTERVAL_MS,
				log: createSilentLogger(),
				hasViewers: () => true,
			});

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// Advance well past idle timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + POLL_INTERVAL_MS * 3);

			// Poller should STILL be running because hasViewers returns true
			expect(poller.isPolling()).toBe(true);

			poller.stopPolling();
		});

		it("poller auto-stops when hasViewers returns false after idle timeout", async () => {
			let viewers = true;
			const client = createMockClient([]);
			const poller = new MessagePoller(new ServiceRegistry(), {
				client: client as unknown as MessagePollerOptions["client"],
				interval: POLL_INTERVAL_MS,
				log: createSilentLogger(),
				hasViewers: () => viewers,
			});

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// With viewers, poller stays alive past timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(true);

			// Remove all viewers
			viewers = false;

			// Now it should auto-stop after the next poll detects idle + no viewers
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(false);
		});

		it("poller without hasViewers option still auto-stops (backward compatible)", async () => {
			const client = createMockClient([]);
			const poller = new MessagePoller(new ServiceRegistry(), {
				client: client as unknown as MessagePollerOptions["client"],
				interval: POLL_INTERVAL_MS,
				log: createSilentLogger(),
				// No hasViewers — defaults to undefined
			});

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);

			// Should auto-stop after idle timeout
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + POLL_INTERVAL_MS);
			expect(poller.isPolling()).toBe(false);
		});
	});

	// ─── emitDone ─────────────────────────────────────────────────────────

	describe("emitDone", () => {
		it("emitDone() emits a done event for the active session", () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			poller.emitDone("sess_1");

			expect(events).toContainEqual({ type: "done", code: 0 });

			poller.stopPolling();
		});

		it("emitDone() for a different session does nothing", () => {
			const client = createMockClient([]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1");
			poller.emitDone("sess_other");

			expect(events).toHaveLength(0);

			poller.stopPolling();
		});
	});

	// ─── Error handling ───────────────────────────────────────────────────

	describe("error handling", () => {
		it("poll failure (getMessages throws) is caught, logged, and polling continues", async () => {
			const client = createMockClient([]);
			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };
			const poller = new MessagePoller(new ServiceRegistry(), {
				client: client as unknown as MessagePollerOptions["client"],
				interval: POLL_INTERVAL_MS,
				log,
			});

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // first poll succeeds

			// Make next poll fail
			client.session.messages.mockRejectedValue(new Error("network timeout"));
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			// Error should be logged
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("poll failed"),
			);

			// Poller should still be running
			expect(poller.isPolling()).toBe(true);

			// Restore success and verify polling continues
			client.session.messages.mockResolvedValue([]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			expect(client.session.messages.mock.calls.length).toBeGreaterThanOrEqual(
				3,
			);

			poller.stopPolling();
		});
	});

	// ─── Snapshot seeding (prevents duplicate events) ─────────────────────

	describe("snapshot seeding", () => {
		it("seeded text parts are not re-emitted on first poll", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello world")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			// Start with seed messages matching what the REST API returns
			poller.startPolling("sess_1", [msg]);
			await vi.advanceTimersByTimeAsync(0);

			// No delta events should be emitted — text was already known
			const deltas = events.filter((e) => e.type === "delta");
			expect(deltas).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded reasoning parts are not re-emitted on first poll", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeReasoningPart("p1", "Let me think...", { start: 100, end: 200 }),
				],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [msg]);
			await vi.advanceTimersByTimeAsync(0);

			// No thinking events should be emitted
			const thinkingEvents = events.filter(
				(e) =>
					e.type === "thinking_start" ||
					e.type === "thinking_delta" ||
					e.type === "thinking_stop",
			);
			expect(thinkingEvents).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded user messages are not re-emitted on first poll", async () => {
			const userMsg = makeMessage({
				id: "msg_u1",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p1", "What is 2+2?")],
			});
			const client = createMockClient([userMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [userMsg]);
			await vi.advanceTimersByTimeAsync(0);

			const userEvents = events.filter((e) => e.type === "user_message");
			expect(userEvents).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded tool parts (completed) are not re-emitted on first poll", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [
					makeToolPart("t1", "read", "completed", { output: "file contents" }),
				],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [msg]);
			await vi.advanceTimersByTimeAsync(0);

			const toolEvents = events.filter(
				(e) =>
					e.type === "tool_start" ||
					e.type === "tool_executing" ||
					e.type === "tool_result",
			);
			expect(toolEvents).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded result (cost/token data) is not re-emitted on first poll", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p1", "Answer")],
				cost: 0.005,
				tokens: { input: 100, output: 50 },
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [msg]);
			await vi.advanceTimersByTimeAsync(0);

			const resultEvents = events.filter((e) => e.type === "result");
			expect(resultEvents).toHaveLength(0);

			poller.stopPolling();
		});

		it("new content AFTER seed is still emitted", async () => {
			const seedMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});

			// First poll returns same as seed
			const client = createMockClient([seedMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [seedMsg]);
			await vi.advanceTimersByTimeAsync(0);

			// No events yet (seeded content)
			expect(events.filter((e) => e.type === "delta")).toHaveLength(0);

			// New text appears on next poll
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [makeTextPart("p1", "Hello world")],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			// Only the new suffix should be emitted
			expect(events).toContainEqual({
				type: "delta",
				text: " world",
				messageId: "msg_1",
			});

			poller.stopPolling();
		});

		it("new messages AFTER seed are emitted", async () => {
			const seedMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p1", "First question")],
			});
			const client = createMockClient([seedMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [seedMsg]);
			await vi.advanceTimersByTimeAsync(0);

			// No events from seed
			expect(events).toHaveLength(0);

			// New message appears
			const newMsg = makeMessage({
				id: "msg_2",
				sessionID: "sess_1",
				parts: [makeTextPart("p2", "Response text")],
			});
			client.session.messages.mockResolvedValue([seedMsg, newMsg]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			// New delta emitted for msg_2
			expect(events).toContainEqual({
				type: "delta",
				text: "Response text",
				messageId: "msg_2",
			});

			poller.stopPolling();
		});

		it("seeded with empty array auto-seeds on first poll (same as unseeded)", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			// Empty seed — seeds on first poll, no events emitted
			poller.startPolling("sess_1", []);
			await vi.advanceTimersByTimeAsync(0);
			expect(events).toHaveLength(0); // Seed — no events

			poller.stopPolling();
		});

		it("unseeded poller auto-seeds on first poll (no events)", async () => {
			const msg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeTextPart("p1", "Hello")],
			});
			const client = createMockClient([msg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			// No seed parameter — first poll seeds, no events emitted
			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(events).toHaveLength(0); // Seed — no events

			poller.stopPolling();
		});

		it("unseeded restart after stop auto-seeds and does NOT re-emit history (prevents duplication)", async () => {
			// Verifies the fix for the synthesis duplication bug:
			// An unseeded poller now seeds on first poll instead of treating
			// ALL messages as new. Only genuinely new content (appearing after
			// the seed) produces events.

			// Turn 1 messages (already complete)
			const userMsg1 = makeMessage({
				id: "msg_u1",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p_u1", "What is 2+2?")],
			});
			const assistantMsg1 = makeMessage({
				id: "msg_a1",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p_a1", "The answer is 4.")],
			});

			// Start poller seeded with turn 1 messages
			const client = createMockClient([userMsg1, assistantMsg1]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [userMsg1, assistantMsg1]);
			await vi.advanceTimersByTimeAsync(0);
			expect(events).toHaveLength(0); // Seeded — no events

			// Simulate turn 1 complete, poller stopped
			poller.stopPolling();
			events.length = 0;

			// Turn 2 messages appear
			const userMsg2 = makeMessage({
				id: "msg_u2",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p_u2", "And 3+3?")],
			});
			const assistantMsg2 = makeMessage({
				id: "msg_a2",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p_a2", "The answer is 6.")],
			});

			// Restart poller WITHOUT seed — first poll auto-seeds (no events)
			client.session.messages.mockResolvedValue([
				userMsg1,
				assistantMsg1,
				userMsg2,
				assistantMsg2,
			]);

			poller.startPolling("sess_1"); // No seed!
			await vi.advanceTimersByTimeAsync(0);

			// First poll auto-seeds: NO events emitted (fix for the duplication bug)
			expect(events).toHaveLength(0);

			// New content after the seed would be detected on subsequent polls
			events.length = 0;
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			// Same data → still no events
			expect(events).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded restart after stop emits only new messages (the correct behavior)", async () => {
			// Verifies the fix: when a poller is stopped and restarted with
			// proper seeding, only new content is emitted.

			// Turn 1 messages (already complete)
			const userMsg1 = makeMessage({
				id: "msg_u1",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p_u1", "What is 2+2?")],
			});
			const assistantMsg1 = makeMessage({
				id: "msg_a1",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p_a1", "The answer is 4.")],
			});

			// Start poller seeded with turn 1 messages
			const client = createMockClient([userMsg1, assistantMsg1]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [userMsg1, assistantMsg1]);
			await vi.advanceTimersByTimeAsync(0);
			expect(events).toHaveLength(0);

			// Simulate turn 1 complete, poller stopped
			poller.stopPolling();
			events.length = 0;

			// Turn 2 messages appear
			const userMsg2 = makeMessage({
				id: "msg_u2",
				sessionID: "sess_1",
				role: "user",
				parts: [makeTextPart("p_u2", "And 3+3?")],
			});
			const assistantMsg2 = makeMessage({
				id: "msg_a2",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p_a2", "The answer is 6.")],
			});

			const allMessages = [userMsg1, assistantMsg1, userMsg2, assistantMsg2];

			// Restart poller WITH proper seed (all existing messages)
			client.session.messages.mockResolvedValue(allMessages);

			poller.startPolling("sess_1", allMessages);
			await vi.advanceTimersByTimeAsync(0);

			// No events: seed covers all existing messages, poll finds nothing new
			expect(events).toHaveLength(0);

			// Now new content appears (turn 2 assistant continues)
			const assistantMsg2Updated = makeMessage({
				id: "msg_a2",
				sessionID: "sess_1",
				role: "assistant",
				parts: [makeTextPart("p_a2", "The answer is 6. Want more math?")],
			});

			client.session.messages.mockResolvedValue([
				userMsg1,
				assistantMsg1,
				userMsg2,
				assistantMsg2Updated,
			]);

			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			// Only the NEW text suffix is emitted
			const deltas = events.filter((e) => e.type === "delta");
			expect(deltas).toHaveLength(1);
			expect(deltas[0]).toEqual({
				type: "delta",
				text: " Want more math?",
				messageId: "msg_a2",
			});

			// No user_message events for old turns
			const userMessages = events.filter((e) => e.type === "user_message");
			expect(userMessages).toHaveLength(0);

			poller.stopPolling();
		});

		it("seeded reasoning part with new text appended still emits the new suffix", async () => {
			const seedMsg = makeMessage({
				id: "msg_1",
				sessionID: "sess_1",
				parts: [makeReasoningPart("p1", "Initial thought")],
			});
			const client = createMockClient([seedMsg]);
			const poller = createPoller(client);
			const events = collectEvents(poller);

			poller.startPolling("sess_1", [seedMsg]);
			await vi.advanceTimersByTimeAsync(0);

			// No events from seed
			expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);

			// Reasoning grows
			client.session.messages.mockResolvedValue([
				makeMessage({
					id: "msg_1",
					sessionID: "sess_1",
					parts: [makeReasoningPart("p1", "Initial thought and more")],
				}),
			]);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			expect(events).toContainEqual({
				type: "thinking_delta",
				text: " and more",
				messageId: "msg_1",
			});

			poller.stopPolling();
		});
	});

	// ─── TrackedService drain ────────────────────────────────────────────

	describe("TrackedService drain", () => {
		it("after drain(), interval no longer fires", async () => {
			const client = createMockClient([]);
			const registry = new ServiceRegistry();
			const poller = new MessagePoller(registry, {
				client: client as unknown as MessagePollerOptions["client"],
				interval: POLL_INTERVAL_MS,
				log: createSilentLogger(),
			});

			poller.startPolling("sess_1");
			await vi.advanceTimersByTimeAsync(0); // immediate poll
			const callsAfterStart = client.session.messages.mock.calls.length;

			// Drain the registry — should cancel the interval
			await registry.drainAll();

			// Advance past several poll intervals
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);

			// No new REST calls after drain
			expect(client.session.messages).toHaveBeenCalledTimes(callsAfterStart);
		});

		it("registry registers the poller (size increases)", () => {
			const registry = new ServiceRegistry();
			expect(registry.size).toBe(0);

			new MessagePoller(registry, {
				client: createMockClient(
					[],
				) as unknown as MessagePollerOptions["client"],
				log: createSilentLogger(),
			});

			expect(registry.size).toBe(1);
		});
	});
});

// ─── Direct tests for extracted pure functions ──────────────────────────────

describe("synthesizeTextPart (direct)", () => {
	function makeSnap(overrides: Partial<PartSnapshot> = {}): PartSnapshot {
		return {
			type: "reasoning",
			textLength: 0,
			text: "",
			emittedExecuting: false,
			emittedResult: false,
			emittedStop: false,
			...overrides,
		};
	}

	it("emits thinking_stop when time.end is set AND textLength > 0 AND no new text", () => {
		// Simulate: previous poll saw "Let me think..." (textLength=15),
		// this poll sees same text with time.end set → should emit thinking_stop.
		const snap = makeSnap({ textLength: 15, text: "Let me think..." });
		const events: RelayMessage[] = [];
		const part = {
			id: "p1",
			type: "reasoning",
			text: "Let me think...",
			time: { start: 100, end: 200 },
		};

		synthesizeTextPart(part, snap, events, "msg_1", "thinking_delta");

		expect(events).toEqual([{ type: "thinking_stop", messageId: "msg_1" }]);
		expect(snap.emittedStop).toBe(true);
	});

	it("does NOT emit thinking_stop when textLength === 0 (premature stop guard)", () => {
		// Simulate: first poll sees a reasoning part with time.end already set
		// but textLength is still 0 (no text was ever seen). The premature stop
		// guard prevents emitting thinking_stop in this case.
		const snap = makeSnap({ textLength: 0, text: "" });
		const events: RelayMessage[] = [];
		const part = {
			id: "p1",
			type: "reasoning",
			text: "",
			time: { start: 100, end: 200 },
		};

		synthesizeTextPart(part, snap, events, "msg_1", "thinking_delta");

		const stopEvents = events.filter((e) => e.type === "thinking_stop");
		expect(stopEvents).toHaveLength(0);
		expect(snap.emittedStop).toBe(false);
	});
});

describe("synthesizeToolPart (direct)", () => {
	function makeToolSnap(overrides: Partial<PartSnapshot> = {}): PartSnapshot {
		return {
			type: "tool",
			textLength: 0,
			text: "",
			emittedExecuting: false,
			emittedResult: false,
			emittedStop: false,
			...overrides,
		};
	}

	it("tool seeded as running → first poll does not re-emit tool_executing", () => {
		// When a tool was seeded as "running", buildSeedSnapshot sets
		// emittedExecuting=true. On the next poll, if the tool is still
		// running, synthesizeToolPart should NOT re-emit tool_executing.
		const prevSnap = makeToolSnap({
			toolName: "Read",
			callID: "t1",
			toolStatus: "running",
			emittedExecuting: true,
		});
		const snap = makeToolSnap({
			toolName: "Read",
			callID: "t1",
			toolStatus: "running",
			emittedExecuting: true,
		});
		const events: RelayMessage[] = [];
		const part = {
			id: "t1",
			type: "tool",
			tool: "read",
			callID: "t1",
			state: { status: "running", input: { path: "/a" } },
		};

		synthesizeToolPart(part, snap, prevSnap, events, "msg_1");

		const executingEvents = events.filter((e) => e.type === "tool_executing");
		expect(executingEvents).toHaveLength(0);
	});
});

describe("diffAndSynthesize (direct)", () => {
	it("multi-part message growth: poll 1 sees [textPart], poll 2 sees [textPart, toolPart]", () => {
		// Poll 1: message has only a text part
		const messages1: Message[] = [
			{
				id: "msg_1",
				role: "assistant",
				sessionID: "sess_1",
				parts: [{ id: "p1", type: "text", text: "Let me read that file." }],
			},
		];
		const emptySnapshot = new Map();
		const result1 = diffAndSynthesize(emptySnapshot, messages1);

		expect(result1.events).toContainEqual({
			type: "delta",
			text: "Let me read that file.",
			messageId: "msg_1",
		});

		// Poll 2: message now has text part + tool part
		const messages2: Message[] = [
			{
				id: "msg_1",
				role: "assistant",
				sessionID: "sess_1",
				parts: [
					{ id: "p1", type: "text", text: "Let me read that file." },
					{
						id: "t1",
						type: "tool",
						tool: "read",
						callID: "t1",
						state: { status: "running", input: { path: "/a" } },
					},
				],
			},
		];
		const result2 = diffAndSynthesize(result1.newSnapshot, messages2);

		// No new delta for text (unchanged)
		const deltas = result2.events.filter((e) => e.type === "delta");
		expect(deltas).toHaveLength(0);

		// Tool events should appear
		expect(result2.events).toContainEqual({
			type: "tool_start",
			id: "t1",
			name: "Read",
			messageId: "msg_1",
		});
		expect(result2.events).toContainEqual(
			expect.objectContaining({
				type: "tool_executing",
				id: "t1",
				name: "Read",
			}),
		);
	});

	it("user message text parts are NOT emitted as delta events", () => {
		// Regression: user message text parts were incorrectly processed by
		// synthesizePartEvents, emitting delta events that the client appended
		// to the current assistant message (corrupting the assistant's text).
		const messages: Message[] = [
			{
				id: "msg_1",
				role: "assistant",
				sessionID: "sess_1",
				parts: [{ id: "p1", type: "text", text: "Shall I proceed?" }],
			},
			{
				id: "msg_2",
				role: "user",
				sessionID: "sess_1",
				parts: [{ id: "p2", type: "text", text: "Yes" }],
			},
		];

		const emptySnapshot = new Map();
		const result = diffAndSynthesize(emptySnapshot, messages);

		// Should have exactly one delta (for the assistant text)
		const deltas = result.events.filter((e) => e.type === "delta");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toEqual({
			type: "delta",
			text: "Shall I proceed?",
			messageId: "msg_1",
		});

		// Should have exactly one user_message event
		const userMsgs = result.events.filter((e) => e.type === "user_message");
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0]).toEqual({
			type: "user_message",
			text: "Yes",
		});

		// No delta should contain the user's text
		const userTextDeltas = deltas.filter(
			(e) => "text" in e && (e as { text: string }).text === "Yes",
		);
		expect(userTextDeltas).toHaveLength(0);
	});
});

describe("buildSeedSnapshot (direct)", () => {
	it("running tool correctly marks emittedExecuting = true", () => {
		const messages: Message[] = [
			{
				id: "msg_1",
				role: "assistant",
				sessionID: "sess_1",
				parts: [
					{
						id: "t1",
						type: "tool",
						tool: "bash",
						callID: "t1",
						state: { status: "running", input: { command: "ls" } },
					},
				],
			},
		];

		const snapshot = buildSeedSnapshot(messages);

		const msgSnap = snapshot.get("msg_1");
		expect(msgSnap).toBeDefined();
		const partSnap = msgSnap?.parts.get("t1");
		expect(partSnap).toBeDefined();
		expect(partSnap?.emittedExecuting).toBe(true);
		expect(partSnap?.emittedResult).toBe(false);
		expect(partSnap?.toolStatus).toBe("running");
		expect(partSnap?.toolName).toBe("Bash");
	});
});
