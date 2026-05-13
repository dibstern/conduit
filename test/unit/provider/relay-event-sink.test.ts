import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import type { MissingPendingInteractions } from "../../../src/lib/provider/errors.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import type { RelayMessage } from "../../../src/lib/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent<T extends CanonicalEvent["type"]>(
	type: T,
	data: Extract<CanonicalEvent, { type: T }>["data"],
	metadata: Record<string, unknown> = {},
): CanonicalEvent {
	return {
		eventId: `evt_${Math.random()}`,
		sessionId: "ses-1",
		type,
		data,
		metadata,
		provider: "claude",
		createdAt: Date.now(),
	} as CanonicalEvent;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createRelayEventSink — translation", () => {
	it("maps text.delta → delta RelayMessage", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });
		await Effect.runPromise(
			sink.push(
				makeEvent("text.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "Hello",
				}),
			),
		);
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			sessionId: "ses-1",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("maps turn.completed → result + done(0)", async () => {
		const send = vi.fn();
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("turn.completed", {
					messageId: "msg_1",
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
					cost: 0.01,
					duration: 1234,
				}),
			),
		);
		const calls = send.mock.calls.map((c) => c[0] as RelayMessage);
		expect(calls.some((m) => m.type === "result")).toBe(true);
		expect(calls.some((m) => m.type === "done" && m.code === 0)).toBe(true);
		expect(clearTimeout).toHaveBeenCalled();
	});

	it("maps turn.error → error + done(1)", async () => {
		const send = vi.fn();
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("turn.error", {
					messageId: "msg_1",
					error: "boom",
					code: "provider_error",
				}),
			),
		);
		const calls = send.mock.calls.map((c) => c[0] as RelayMessage);
		expect(
			calls.some((m) => m.type === "error" && m.code === "provider_error"),
		).toBe(true);
		expect(calls.some((m) => m.type === "done" && m.code === 1)).toBe(true);
		expect(clearTimeout).toHaveBeenCalled();
	});

	// Regression: before this fix, api_retry system events never reached the
	// UI, so users saw silence for 1-5 minutes while the SDK retried 502s.
	it("maps session.status:retry → non-terminal error(RETRY)", async () => {
		const send = vi.fn();
		const clearTimeout = vi.fn();
		const resetTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			clearTimeout,
			resetTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent(
					"session.status",
					{ sessionId: "ses-1", status: "retry" },
					{
						correlationId: "Retrying (attempt 3/10) · HTTP 502 · next in 2.2s",
					},
				),
			),
		);
		const calls = send.mock.calls.map((c) => c[0] as RelayMessage);
		expect(calls).toHaveLength(1);
		const msg = calls[0];
		expect(msg).toBeDefined();
		if (msg?.type !== "error") throw new Error("expected error");
		expect(msg.code).toBe("RETRY");
		expect(msg.message).toMatch(/attempt 3\/10/);
		// RETRY is NON-terminal — must NOT clear the processing timeout.
		expect(clearTimeout).not.toHaveBeenCalled();
		// It DOES reset the timeout (activity observed).
		expect(resetTimeout).toHaveBeenCalled();
	});

	it("clears timeout on non-RETRY errors", async () => {
		const send = vi.fn();
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("turn.error", {
					messageId: "msg_1",
					error: "rate limit",
					code: "provider_error",
				}),
			),
		);
		expect(clearTimeout).toHaveBeenCalled();
	});

	it("does not clear timeout on idle/busy session.status", async () => {
		const send = vi.fn();
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("session.status", { sessionId: "ses-1", status: "idle" }),
			),
		);
		await Effect.runPromise(
			sink.push(
				makeEvent("session.status", { sessionId: "ses-1", status: "busy" }),
			),
		);
		expect(send).not.toHaveBeenCalled();
		expect(clearTimeout).not.toHaveBeenCalled();
	});

	it("maps tool.started → tool_start + tool_executing", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });
		await Effect.runPromise(
			sink.push(
				makeEvent("tool.started", {
					messageId: "msg_1",
					partId: "part_1",
					toolName: "Bash",
					callId: "call_1",
					input: { command: "ls" },
				}),
			),
		);
		const calls = send.mock.calls.map((c) => c[0] as RelayMessage);
		expect(calls[0]).toMatchObject({
			type: "tool_start",
			id: "call_1",
			name: "Bash",
		});
		expect(calls[1]).toMatchObject({
			type: "tool_executing",
			id: "call_1",
			name: "Bash",
		});
	});

	it("maps thinking.delta → thinking_delta", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });
		await Effect.runPromise(
			sink.push(
				makeEvent("thinking.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "pondering",
				}),
			),
		);
		expect(send).toHaveBeenCalledWith({
			type: "thinking_delta",
			sessionId: "ses-1",
			text: "pondering",
			messageId: "msg_1",
		});
	});
});

describe("createRelayEventSink — persistence", () => {
	it("runs Effect persistence when persist deps are provided", async () => {
		const send = vi.fn();
		const persistEvent = vi.fn(() => Effect.void);

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: { persistEvent },
		});

		const event = makeEvent("text.delta", {
			messageId: "msg_1",
			partId: "part_1",
			text: "Hello",
		});
		await Effect.runPromise(sink.push(event));

		expect(persistEvent).toHaveBeenCalledWith(event);
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			sessionId: "ses-1",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("still sends to WebSocket when persist is not provided", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });

		await Effect.runPromise(
			sink.push(
				makeEvent("text.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "Hello",
				}),
			),
		);

		expect(send).toHaveBeenCalledWith({
			type: "delta",
			sessionId: "ses-1",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("continues sending to WebSocket even if Effect persistence fails", async () => {
		const send = vi.fn();
		const persistEvent = vi.fn(() => Effect.fail(new Error("disk full")));

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: { persistEvent },
		});

		await Effect.runPromise(
			sink.push(
				makeEvent("text.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "Hello",
				}),
			),
		);

		expect(send).toHaveBeenCalledWith({
			type: "delta",
			sessionId: "ses-1",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("runs Effect-native persistence programs before sending to WebSocket", async () => {
		const order: string[] = [];
		const send = vi.fn(() => {
			order.push("send");
		});
		const persisted: string[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: {
				persistEvent: (event) =>
					Effect.sync(() => {
						order.push("persist");
						persisted.push(event.type);
					}),
			},
		});

		await Effect.runPromise(
			sink.push(
				makeEvent("text.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "Hello",
				}),
			),
		);

		expect(persisted).toEqual(["text.delta"]);
		expect(order).toEqual(["persist", "send"]);
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			sessionId: "ses-1",
			text: "Hello",
			messageId: "msg_1",
		});
	});
});

describe("createRelayEventSink — permission/question", () => {
	it("rejects permission and question requests with a typed error when the pending interaction port is missing", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });

		await expect(
			sink.requestPermission({
				requestId: "req_1",
				toolName: "Bash",
				toolInput: { command: "whoami" },
				sessionId: "ses-1",
				turnId: "turn_1",
				providerItemId: "toolu_1",
			}),
		).rejects.toMatchObject({
			_tag: "MissingPendingInteractions",
			operation: "requestPermission",
			sessionId: "ses-1",
		} satisfies Partial<MissingPendingInteractions>);

		await expect(
			sink.requestQuestion({
				requestId: "que_1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
					},
				],
			}),
		).rejects.toMatchObject({
			_tag: "MissingPendingInteractions",
			operation: "requestQuestion",
			sessionId: "ses-1",
		} satisfies Partial<MissingPendingInteractions>);

		expect(send).not.toHaveBeenCalled();
	});

	it("emits permission_request and resolves when resolvePermission is called", async () => {
		const send = vi.fn();
		let resolvePermission:
			| ((response: { decision: "once" | "always" | "reject" }) => void)
			| undefined;
		const pendingInteractions = {
			beginPermissionRequest: vi.fn(
				() =>
					new Promise<{ decision: "once" | "always" | "reject" }>((resolve) => {
						resolvePermission = resolve;
					}),
			),
			resolvePermissionRequest: vi.fn((_requestId, response) => {
				resolvePermission?.(response);
				return true;
			}),
			beginQuestionRequest: vi.fn(),
			resolveQuestionRequest: vi.fn(),
		};
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			pendingInteractions,
		});
		const pending = sink.requestPermission({
			requestId: "req_1",
			toolName: "Bash",
			toolInput: { command: "rm -rf /" },
			sessionId: "ses-1",
			turnId: "turn_1",
			providerItemId: "item_1",
		});

		// The UI-facing message is queued
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "req_1",
				toolName: "Bash",
			}),
		);

		// Resolving unblocks the awaiting adapter
		sink.resolvePermission("req_1", { decision: "once" });
		const response = await pending;
		expect(response.decision).toBe("once");
		expect(pendingInteractions.resolvePermissionRequest).toHaveBeenCalledWith(
			"req_1",
			{ decision: "once" },
		);
	});

	it("tracks permission and question replay state through the pending interaction port", async () => {
		const send = vi.fn();
		let resolvePermission:
			| ((response: { decision: "once" | "always" | "reject" }) => void)
			| undefined;
		let resolveQuestion:
			| ((answers: Record<string, unknown>) => void)
			| undefined;
		const pendingInteractions = {
			beginPermissionRequest: vi.fn(
				() =>
					new Promise<{ decision: "once" | "always" | "reject" }>((resolve) => {
						resolvePermission = resolve;
					}),
			),
			resolvePermissionRequest: vi.fn((_requestId, response) => {
				resolvePermission?.(response);
				return true;
			}),
			beginQuestionRequest: vi.fn(
				() =>
					new Promise<Record<string, unknown>>((resolve) => {
						resolveQuestion = resolve;
					}),
			),
			resolveQuestionRequest: vi.fn((_requestId, answers) => {
				resolveQuestion?.(answers);
				return true;
			}),
		};
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			pendingInteractions,
		});

		const permission = sink.requestPermission({
			requestId: "req_1",
			toolName: "Bash",
			toolInput: { command: "whoami" },
			sessionId: "ses-1",
			turnId: "turn_1",
			providerItemId: "toolu_1",
			always: ["Bash"],
		});
		expect(pendingInteractions.beginPermissionRequest).toHaveBeenCalledWith({
			requestId: "req_1",
			sessionId: "ses-1",
			toolName: "Bash",
			toolInput: { command: "whoami" },
			always: ["Bash"],
		});
		sink.resolvePermission("req_1", { decision: "once" });
		await expect(permission).resolves.toEqual({ decision: "once" });
		expect(pendingInteractions.resolvePermissionRequest).toHaveBeenCalledWith(
			"req_1",
			{ decision: "once" },
		);

		const question = sink.requestQuestion({
			requestId: "que_1",
			questions: [
				{
					question: "Continue?",
					header: "Confirm",
					options: [{ label: "Yes", description: "Continue" }],
					multiSelect: false,
					custom: true,
				},
			],
		});
		expect(pendingInteractions.beginQuestionRequest).toHaveBeenCalledWith({
			requestId: "que_1",
			sessionId: "ses-1",
			questions: [
				{
					question: "Continue?",
					header: "Confirm",
					options: [{ label: "Yes", description: "Continue" }],
					multiSelect: false,
				},
			],
		});
		sink.resolveQuestion("que_1", { "0": "Yes" });
		await expect(question).resolves.toEqual({ "0": "Yes" });
		expect(pendingInteractions.resolveQuestionRequest).toHaveBeenCalledWith(
			"que_1",
			{ "0": "Yes" },
		);
	});
});

describe("createRelayEventSink — thinking lifecycle", () => {
	it("translates full thinking lifecycle to relay messages with messageId", async () => {
		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send: (msg) => sent.push(msg),
		});

		await Effect.runPromise(
			sink.push(
				makeEvent("thinking.start", {
					messageId: "msg-1",
					partId: "part-1",
				}),
			),
		);

		await Effect.runPromise(
			sink.push(
				makeEvent("thinking.delta", {
					messageId: "msg-1",
					partId: "part-1",
					text: "Let me think...",
				}),
			),
		);

		await Effect.runPromise(
			sink.push(
				makeEvent("thinking.end", {
					messageId: "msg-1",
					partId: "part-1",
				}),
			),
		);

		const types = sent.map((m) => m.type);
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("thinking_stop");

		// No tool_result should appear for thinking lifecycle
		expect(types).not.toContain("tool_result");

		// Verify messageId propagates through to relay messages
		const start = sent.find((m) => m.type === "thinking_start");
		const delta = sent.find((m) => m.type === "thinking_delta");
		const stop = sent.find((m) => m.type === "thinking_stop");
		expect((start as Record<string, unknown>)["messageId"]).toBe("msg-1");
		expect((delta as Record<string, unknown>)["messageId"]).toBe("msg-1");
		expect((stop as Record<string, unknown>)["messageId"]).toBe("msg-1");
	});
});
