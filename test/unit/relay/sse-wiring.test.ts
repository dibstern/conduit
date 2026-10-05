import { Effect, Ref } from "effect";
import { assert, describe, expect, it, vi } from "vitest";
import {
	OverridesStateTag,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { shouldCache } from "../../../src/lib/relay/event-pipeline.js";
import {
	extractSessionId,
	handleSSEEventEffect,
	type SSEWiringDeps,
	type wireSSEConsumerEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import { TRUNCATION_THRESHOLD } from "../../../src/lib/relay/truncate-content.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";
import { partialFake } from "../../helpers/partial-fake.js";
import {
	makeSSETestServices,
	runSSEEvent,
	wireSSEConsumerForTest,
} from "../../helpers/sse-effect-harness.js";

describe("extractSessionId", () => {
	it("returns top-level sessionID", async () => {
		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "s1" },
		};
		expect(extractSessionId(event)).toBe("s1");
	});

	it("returns sessionID nested in part", async () => {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { part: { sessionID: "s2" } },
		};
		expect(extractSessionId(event)).toBe("s2");
	});

	it("returns sessionID nested in info", async () => {
		const event: OpenCodeEvent = {
			type: "message.updated",
			properties: { info: { sessionID: "s3" } },
		};
		expect(extractSessionId(event)).toBe("s3");
	});

	it("returns id from info for session.updated", async () => {
		const event: OpenCodeEvent = {
			type: "session.updated",
			properties: { info: { id: "s4" } },
		};
		expect(extractSessionId(event)).toBe("s4");
	});

	it("returns undefined when no sessionID found", async () => {
		const event: OpenCodeEvent = {
			type: "unknown",
			properties: {},
		};
		expect(extractSessionId(event)).toBeUndefined();
	});

	it("prefers top-level sessionID over nested", async () => {
		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {
				sessionID: "top-level",
				part: { sessionID: "nested" },
			},
		};
		expect(extractSessionId(event)).toBe("top-level");
	});
});

describe("shouldCache", () => {
	it("returns true for chat-relevant types", async () => {
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

	it("returns false for non-chat types", async () => {
		const nonCacheable = [
			"permission_request",
			"permission_resolved",
			"pty_created",
			"pty_output",
			"status",
		] as const;
		for (const type of nonCacheable) {
			expect(shouldCache(type)).toBe(false);
		}
	});
});

describe("handleSSEEventEffect", () => {
	it("translates and firehoses events to every client on the project (Phase 0b)", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.translator.translate).toHaveBeenCalledWith(event, {
			sessionId: "active-session",
		});
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		// sendToSession no longer used for chat events — only for viewer-scoped
		// status routing (handled elsewhere).
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		// Cross-session notification_event only fires when no viewers — mock has c1 viewing.
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("firehoses events regardless of which session they belong to (Phase 0b)", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"other-session",
			translated,
		);
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("firehoses events even when no clients are actively viewing the session (Phase 0b)", async () => {
		// Phase 0b: delivery is no longer viewer-gated. The event goes to all
		// connected clients. The frontend dispatcher handles routing into the
		// correct per-session slot.
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		// Event still fires on the firehose — the "no viewers" signal only
		// controls cross-session notification_event fallback (not tested here
		// because delta is not notification-worthy).
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"other-session",
			translated,
		);
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
	});

	it.each([
		[
			"clears processing timeout when done event arrives for a session",
			"done",
			"active-session",
			"clear",
		],
		[
			"clears processing timeout for done on any session (not just active)",
			"done",
			"other-session",
			"clear",
		],
		[
			"resets processing timeout on non-done events (inactivity timer)",
			"delta",
			"active-session",
			"reset",
		],
		[
			"resets processing timeout on non-done events for active session",
			"delta",
			"active-session",
			"reset",
		],
		[
			"resets processing timeout on non-done events for any session (per-session timer)",
			"delta",
			"other-session",
			"reset",
		],
		[
			"resets processing timeout on retry events for active session",
			"retry",
			"active-session",
			"reset",
		],
		[
			"does not reset processing timeout when no sessionID is present",
			"delta",
			undefined,
			"same",
		],
	] as const)("%s", async (_name, kind, sessionId, expected) => {
		const deps = createMockSSEWiringDeps();
		const services = makeSSETestServices();
		const message: RelayMessage =
			kind === "done"
				? { type: "done", sessionId: "s1", code: 0, alertId: "done-1" }
				: kind === "retry"
					? {
							type: "error",
							sessionId: "s1",
							alertId: "error-1",
							code: "RETRY",
							message: "Retrying...",
						}
					: { type: "delta", sessionId: "s1", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [message],
		});
		const event: OpenCodeEvent = {
			type: kind === "delta" ? "message.part.delta" : "session.status",
			properties: sessionId ? { sessionID: sessionId } : {},
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const timeoutSessionId = sessionId ?? "active-session";
				yield* startProcessingTimeout(
					timeoutSessionId,
					"1 minute",
					() => Effect.void,
				);
				const ref = yield* OverridesStateTag;
				const before = (yield* Ref.get(ref)).sessions.get(
					timeoutSessionId,
				)?.processingTimeoutToken;
				yield* handleSSEEventEffect(deps, event);
				const after = (yield* Ref.get(ref)).sessions.get(
					timeoutSessionId,
				)?.processingTimeoutToken;
				expect(before).toBeDefined();
				if (expected === "clear") expect(after).toBeUndefined();
				else if (expected === "reset") expect(after).not.toBe(before);
				else expect(after).toBe(before);
			}).pipe(Effect.provide(services.layer)),
		);
	});

	it("records permission.asked events through pending permission state", async () => {
		const deps = createMockSSEWiringDeps();
		const services = makeSSETestServices();
		vi.spyOn(services.pendingInteractions, "recordPermissionRequest");

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Bash",
				sessionID: "session-1",
				patterns: ["git *"],
				metadata: { command: "git status" },
				always: ["git *"],
			},
		};
		await runSSEEvent(deps, event, services);

		expect(
			services.pendingInteractions.recordPermissionRequest,
		).toHaveBeenCalledWith({
			requestId: "perm-1",
			sessionId: "session-1",
			toolName: "Bash",
			toolInput: {
				patterns: ["git *"],
				metadata: { command: "git status" },
			},
			always: ["git *"],
		});
	});

	it("broadcast permission_request includes sessionId from the event", async () => {
		const deps = createMockSSEWiringDeps();

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Bash",
				sessionID: "ses-abc",
			},
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				sessionId: "ses-abc",
			}),
		);
	});

	it("translates and routes question.asked events to the question's session", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "ask_user",
			sessionId: "s1",
			toolId: "que_q1",
			questions: [],
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "question.asked",
			properties: { id: "q-1", questions: [], sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		// ask_user messages are routed to the question's session, not broadcast
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(translated);
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: "active-session",
			alertId: "active-session:question:que_q1",
		});
	});

	it("broadcasts question resolutions so family viewers drop replayed questions", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "ask_user_resolved",
			sessionId: "child-session",
			toolId: "que_q1",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		await runSSEEvent(deps, {
			type: "question.replied",
			properties: { sessionID: "child-session", requestID: "que_q1" },
		});

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(translated);
	});

	it("routes permission.replied events to pending permission state", async () => {
		const deps = createMockSSEWiringDeps();
		const services = makeSSETestServices();
		vi.spyOn(services.pendingInteractions, "markPermissionReplied");

		const event: OpenCodeEvent = {
			type: "permission.replied",
			properties: {
				sessionID: "s1",
				requestID: "perm-1",
				reply: "once",
			},
		};
		await runSSEEvent(deps, event, services);

		expect(
			services.pendingInteractions.markPermissionReplied,
		).toHaveBeenCalledWith("perm-1");
	});

	it("does not record non-cacheable events to cache", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "compaction",
			sessionId: "active-session",
			state: "started",
			detail: "",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.compacted",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		// Non-cacheable events still firehose via Phase 0b.
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("routes user_message events normally (echo suppression removed in Task 50.5)", async () => {
		const deps = createMockSSEWiringDeps();

		const translated: RelayMessage = {
			type: "user_message",
			sessionId: "s1",
			text: "Hello world",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		// user_message events are firehosed normally — no suppression.
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("does nothing when translator returns not ok", async () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "mock skip",
		});

		const event: OpenCodeEvent = {
			type: "unknown.event",
			properties: {},
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("handles array of translated messages", async () => {
		const deps = createMockSSEWiringDeps();
		const messages: RelayMessage[] = [
			{ type: "tool_start", sessionId: "s1", id: "call-1", name: "Bash" },
			{
				type: "tool_executing",
				sessionId: "s1",
				id: "call-1",
				name: "Bash",
				input: { command: "ls" },
			},
		];
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages,
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledTimes(2);
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			messages[0],
		);
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			messages[1],
		);
	});

	it("does not route events with no sessionID", async () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {}, // no sessionID
		};
		await runSSEEvent(deps, event);

		// No sessionID means we can't attribute the event — Phase 0b firehose
		// is keyed on sessionId, so missing-id events are dropped.
		expect(deps.wsHandler.broadcastPerSessionEvent).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("broadcasts permission_request even when sessionID is missing from SSE event", async () => {
		const deps = createMockSSEWiringDeps();

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Bash",
				metadata: { command: "git status" },
			},
			// No sessionID!
		};
		await runSSEEvent(deps, event);

		// The permission MUST be broadcast even without sessionID
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-1",
				toolName: "Bash",
			}),
		);
	});

	it("broadcasts permission_request with sessionID when present in SSE event", async () => {
		const deps = createMockSSEWiringDeps();

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-2",
				permission: "Write",
				sessionID: "sess-abc",
			},
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-2",
				sessionId: "sess-abc",
				toolName: "Write",
			}),
		);
	});

	it("sends push notification for permission.asked", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: { id: "perm-1", permission: "Bash", sessionID: "s1" },
		};
		await runSSEEvent(deps, event);

		assert.exists(mockPush, "expected push service");
		expect(mockPush.sendToAll).toHaveBeenCalledWith({
			type: "permission_request",
			title: "Permission Needed",
			body: "Bash needs approval",
			tag: "perm-perm-1",
			slug: "test-project",
			sessionId: "s1",
			alertId: "s1:permission:perm-1",
		});
	});

	it("sends push notification for question.asked", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });

		const event: OpenCodeEvent = {
			type: "question.asked",
			properties: { id: "q-1", sessionID: "s1", questions: [] },
		};
		await runSSEEvent(deps, event);

		assert.exists(mockPush, "expected push service");
		expect(mockPush.sendToAll).toHaveBeenCalledWith({
			type: "ask_user",
			title: "Question from Agent",
			body: "Agent has a question for you.",
			tag: "opencode-ask",
			slug: "test-project",
			sessionId: "s1",
			alertId: "s1:question:q-1",
		});
	});

	it("keeps anonymous done status hints on the UI channel", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = { type: "done", sessionId: "s1", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			expect.objectContaining({ type: "done", code: 0 }),
		);
		expect(mockPush?.sendToAll).not.toHaveBeenCalled();
	});

	it("sends push notification for error events", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = {
			type: "error",
			alertId: "error-1",
			sessionId: "s1",
			code: "SEND_FAILED",
			message: "Something broke",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.error",
			properties: {
				sessionID: "active-session",
				error: { name: "err", data: { message: "Something broke" } },
			},
		};
		await runSSEEvent(deps, event);

		assert.exists(mockPush, "expected push service");
		expect(mockPush.sendToAll).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				title: "Error",
				body: "Something broke",
			}),
		);
	});

	it("sends push notification for done/error on ANY session (not just active)", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = {
			type: "done",
			sessionId: "s1",
			code: 0,
			alertId: "done-1",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		assert.exists(mockPush, "expected push service");
		const calls = vi.mocked(mockPush.sendToAll).mock.calls;
		const doneCalls = calls.filter(
			(c) => (c[0] as { type: string }).type === "done",
		);
		expect(doneCalls).toHaveLength(1);
	});

	it("calls notifySSEIdle on status poller when session.status:idle arrives", async () => {
		const mockStatusPoller = { notifySSEIdle: vi.fn(() => Effect.void) };
		const deps = createMockSSEWiringDeps({ statusPoller: mockStatusPoller });
		// Translator returns ok: false for idle (no relay messages produced)
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "idle" },
			},
		};
		await runSSEEvent(deps, event);

		expect(mockStatusPoller.notifySSEIdle).toHaveBeenCalledWith("sess-123");
	});

	it("does not call notifySSEIdle for session.status:busy", async () => {
		const mockStatusPoller = { notifySSEIdle: vi.fn(() => Effect.void) };
		const deps = createMockSSEWiringDeps({ statusPoller: mockStatusPoller });
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "busy" },
			},
		};
		await runSSEEvent(deps, event);

		expect(mockStatusPoller.notifySSEIdle).not.toHaveBeenCalled();
	});

	it("does not call notifySSEIdle when no statusPoller is configured", async () => {
		const deps = createMockSSEWiringDeps();
		// No statusPoller in deps
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "idle" },
			},
		};
		// Should not throw even without statusPoller
		await expect(runSSEEvent(deps, event)).resolves.toBeUndefined();
	});
});

describe("wireSSEConsumerEffect", () => {
	it("registers event listeners on consumer", async () => {
		const deps = createMockSSEWiringDeps();
		const consumer = {
			on: vi.fn(),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);

		const registeredEvents = vi.mocked(consumer.on).mock.calls.map((c) => c[0]);
		expect(registeredEvents).toContain("connected");
		expect(registeredEvents).toContain("disconnected");
		expect(registeredEvents).toContain("reconnecting");
		expect(registeredEvents).toContain("error");
		expect(registeredEvents).toContain("event");
	});

	it("event listener delegates to handleSSEEventEffect", async () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);

		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hi",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		const eventListener = listeners.get("event");
		assert.exists(eventListener, "expected event listener");
		eventListener(event);

		expect(deps.translator.translate).toHaveBeenCalledWith(event, {
			sessionId: "active-session",
		});
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("forwards a schema-valid event without a decode warning (conduit-test-8g7)", async () => {
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), warn: warnSpy };
		const deps = createMockSSEWiringDeps({ log });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];
		await wireSSEConsumerForTest(deps, consumer);

		const event = {
			type: "message.part.delta",
			properties: {
				sessionID: "s1",
				partID: "p1",
				field: "text",
				delta: "hi",
			},
		};
		const eventListener = listeners.get("event");
		assert.exists(eventListener, "expected event listener");
		eventListener(event);

		expect(deps.translator.translate).toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("failed OpenCodeEventSchema decode"),
		);
	});

	it("warns but still forwards an event that fails schema decode — never drops (conduit-test-8g7)", async () => {
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), warn: warnSpy };
		const deps = createMockSSEWiringDeps({ log });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];
		await wireSSEConsumerForTest(deps, consumer);

		// Well-formed envelope, but an event type not in the modeled union.
		const unknownEvent = {
			type: "server.brand.new.v99",
			properties: { sessionID: "s1" },
		};
		const eventListener = listeners.get("event");
		assert.exists(eventListener, "expected event listener");
		eventListener(unknownEvent);

		// Forwarded raw despite decode failure (never dropped)…
		expect(deps.translator.translate).toHaveBeenCalledWith(
			unknownEvent,
			expect.anything(),
		);
		// …and the drift is surfaced as a warning.
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("failed OpenCodeEventSchema decode"),
		);
	});

	it("logs SSE lifecycle events", async () => {
		const infoSpy = vi.fn();
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), info: infoSpy, warn: warnSpy };
		const deps = createMockSSEWiringDeps({ log });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);

		const connectedListener = listeners.get("connected");
		assert.exists(connectedListener, "expected connected listener");
		connectedListener();
		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Connected"));

		const disconnectedListener = listeners.get("disconnected");
		assert.exists(disconnectedListener, "expected disconnected listener");
		disconnectedListener(undefined);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Disconnected"),
		);

		const reconnectingListener = listeners.get("reconnecting");
		assert.exists(reconnectingListener, "expected reconnecting listener");
		reconnectingListener({ attempt: 3, delay: 5000 });
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Reconnecting"),
		);
	});

	it("broadcasts connection_status 'connected' on connected event", async () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);
		const connectedListener = listeners.get("connected");
		assert.exists(connectedListener, "expected connected listener");
		connectedListener();

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "connected",
		});
	});

	it("broadcasts connection_status 'disconnected' on disconnected event", async () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);
		const disconnectedListener = listeners.get("disconnected");
		assert.exists(disconnectedListener, "expected disconnected listener");
		disconnectedListener(new Error("connection lost"));

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "disconnected",
		});
	});

	it("broadcasts connection_status 'reconnecting' on reconnecting event", async () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumerEffect>[1];

		await wireSSEConsumerForTest(deps, consumer);
		const reconnectingListener = listeners.get("reconnecting");
		assert.exists(reconnectingListener, "expected reconnecting listener");
		reconnectingListener({ attempt: 1, delay: 1000 });

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "reconnecting",
		});
	});
});

describe("handleSSEEventEffect – tool_result truncation", () => {
	it("truncates tool_result over threshold before sending and caching", async () => {
		const deps = createMockSSEWiringDeps();
		const largeContent = "x".repeat(TRUNCATION_THRESHOLD + 1000);
		const translated: RelayMessage = {
			type: "tool_result",
			sessionId: "s1",
			id: "tool-1",
			content: largeContent,
			is_error: false,
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		// broadcastPerSessionEvent should receive truncated content under Phase 0b
		const call = vi.mocked(deps.wsHandler.broadcastPerSessionEvent).mock
			.calls[0];
		assert.exists(call, "expected per-session broadcast");
		const sendArg = call[1];
		expect(sendArg.type).toBe("tool_result");
		if (sendArg.type === "tool_result") {
			expect(sendArg.content.length).toBeLessThan(largeContent.length);
			expect(sendArg.isTruncated).toBe(true);
			expect(sendArg.fullContentLength).toBe(largeContent.length);
		}
	});

	it("passes through tool_result under threshold unchanged", async () => {
		const deps = createMockSSEWiringDeps();
		const smallContent = "short result";
		const translated: RelayMessage = {
			type: "tool_result",
			sessionId: "s1",
			id: "tool-3",
			content: smallContent,
			is_error: false,
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		await runSSEEvent(deps, event);

		// broadcastPerSessionEvent should receive original message unchanged.
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});
});

// When the pipeline drops a notification-worthy event (done, error) because no
// clients are viewing that session, the server should broadcast a
// notification_event so clients on other sessions can fire sound/browser alerts.

// Notification routing through resolveNotifications (F2 wiring)
// Verifies that handleSSEEventEffect gates push and cross-session broadcast through
// resolveNotifications() — not inline logic. These tests exercise the REAL
// wiring path, not the policy function in isolation.

describe("notification routing: push gating via resolveNotifications", () => {
	it("does NOT call push for non-notification-worthy events (delta)", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{ type: "delta", sessionId: "s1", text: "hello" } as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "s1" },
		};
		await runSSEEvent(deps, event);

		expect(mockPush.sendToAll).not.toHaveBeenCalled();
	});

	it("calls push for done event from root session (no parent)", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
		});
		const services = makeSSETestServices();
		vi.mocked(services.sessionService.getSessionParentMap).mockReturnValue(
			Effect.succeed(new Map()),
		);
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{
					type: "done",
					sessionId: "s1",
					code: 0,
					alertId: "done-1",
				} as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "root-session" },
		};
		await runSSEEvent(deps, event, services);

		expect(mockPush.sendToAll).toHaveBeenCalled();
	});

	it("does NOT call push for done event from subagent session", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
		});
		const services = makeSSETestServices();
		vi.mocked(services.sessionService.getSessionParentMap).mockReturnValue(
			Effect.succeed(new Map([["child-session", "parent-session"]])),
		);
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{
					type: "done",
					sessionId: "s1",
					code: 0,
					alertId: "done-1",
				} as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "child-session" },
		};
		await runSSEEvent(deps, event, services);

		expect(mockPush.sendToAll).not.toHaveBeenCalled();
	});

	it("does NOT broadcast cross-session notification for subagent done", async () => {
		const deps = createMockSSEWiringDeps({});
		const services = makeSSETestServices();
		vi.mocked(services.sessionService.getSessionParentMap).mockReturnValue(
			Effect.succeed(new Map([["child-session", "parent-session"]])),
		);
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{
					type: "done",
					sessionId: "s1",
					code: 0,
					alertId: "done-1",
				} as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "child-session" },
		};
		await runSSEEvent(deps, event, services);

		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		const notifCalls = broadcastCalls.filter(
			(call) => (call[0] as RelayMessage).type === "notification_event",
		);
		expect(notifCalls).toHaveLength(0);
	});

	it("DOES call push for subagent error (errors always notify)", async () => {
		const mockPush = partialFake<NonNullable<SSEWiringDeps["pushManager"]>>({
			sendToAll: vi
				.fn<NonNullable<SSEWiringDeps["pushManager"]>["sendToAll"]>()
				.mockResolvedValue({
					delivered: ["device-1"],
					expired: [],
					failed: [],
				}),
		});
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
		});
		const services = makeSSETestServices();
		vi.mocked(services.sessionService.getSessionParentMap).mockReturnValue(
			Effect.succeed(new Map([["child-session", "parent-session"]])),
		);
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{
					type: "error",
					alertId: "error-1",
					sessionId: "s1",
					code: "FATAL",
					message: "crashed",
				} as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "session.error",
			properties: { sessionID: "child-session" },
		};
		await runSSEEvent(deps, event, services);

		expect(mockPush.sendToAll).toHaveBeenCalled();
	});
});

describe("notification_event broadcast for dropped notification-worthy events", () => {
	it("broadcasts notification_event when done is dropped (no viewers)", async () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = {
			type: "done",
			sessionId: "s1",
			code: 0,
			alertId: "done-1",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "notification_event",
			eventType: "done",
			alertId: "done-1",
			sessionId: "other-session",
		});
	});

	it("broadcasts notification_event with message when error is dropped", async () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = {
			type: "error",
			alertId: "error-1",
			sessionId: "s1",
			code: "FATAL",
			message: "Something broke",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "notification_event",
			eventType: "error",
			alertId: "error-1",
			message: "Something broke",
			sessionId: "other-session",
		});
	});

	it("does NOT broadcast notification_event when done is sent (has viewers)", async () => {
		const deps = createMockSSEWiringDeps();
		// Has viewers — event is sent normally
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue(["c1"]);
		const translated: RelayMessage = {
			type: "done",
			sessionId: "s1",
			code: 0,
			alertId: "done-1",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "my-session" },
		};
		await runSSEEvent(deps, event);

		// Should NOT broadcast notification_event — the event was sent to the session
		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		const notifCalls = broadcastCalls.filter(
			(call) => (call[0] as RelayMessage).type === "notification_event",
		);
		expect(notifCalls).toHaveLength(0);
	});

	it("does NOT broadcast notification_event for non-notification types (delta)", async () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});
});
