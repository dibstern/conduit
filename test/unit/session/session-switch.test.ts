import { describe, expect, it, vi } from "vitest";
import type {
	SessionHistorySource,
	SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";
import {
	buildSessionSwitchedMessage,
	classifyHistorySource,
	countUniqueMessages,
	resolveSessionHistory,
	switchClientToSession,
} from "../../../src/lib/session/session-switch.js";
import type { RequestId } from "../../../src/lib/shared-types.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("classifyHistorySource", () => {
	it('returns "needs-rest" when events is null', () => {
		expect(classifyHistorySource(null)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is undefined', () => {
		expect(classifyHistorySource(undefined)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is empty array', () => {
		expect(classifyHistorySource([])).toBe("needs-rest");
	});

	it('returns "needs-rest" when events have no chat content (only status/done)', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("needs-rest");
	});

	it('returns "cached-events" when events contain user_message', () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events contain delta', () => {
		const events: RelayMessage[] = [{ type: "delta", text: "response" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events have mixed content with at least one user_message', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "user_message", text: "hello" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});
});

describe("buildSessionSwitchedMessage", () => {
	it("builds message from cached-events source", () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_1", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_1",
			events,
		});
	});

	it("builds message from rest-history source", () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const, parts: [] }],
			hasMore: true,
			total: 42,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_2", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_2",
			history: { messages: history.messages, hasMore: true, total: 42 },
		});
	});

	it("omits total from history when undefined", () => {
		const history = {
			messages: [],
			hasMore: false,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_3", source);

		expect(msg.history).toEqual({ messages: [], hasMore: false });
		expect("total" in (msg.history ?? {})).toBe(false);
	});

	it("builds bare message from empty source", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_4", source);

		expect(msg).toEqual({ type: "session_switched", id: "ses_4" });
	});

	it("includes inputText when draft is provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_5", source, {
			draft: "work in progress",
		});

		expect(msg.inputText).toBe("work in progress");
	});

	it("omits inputText when draft is empty string", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_6", source, { draft: "" });

		expect("inputText" in msg).toBe(false);
	});

	it("omits inputText when draft is undefined", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_7", source, {});

		expect("inputText" in msg).toBe(false);
	});

	it("includes requestId when provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_8", source, {
			requestId: "req-abc" as RequestId,
		});

		expect(msg.requestId).toBe("req-abc");
	});

	it("omits requestId when not provided (exactOptionalPropertyTypes safe)", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_9", source);

		expect("requestId" in msg).toBe(false);
	});

	it("includes both draft and requestId with cached-events", () => {
		const events: RelayMessage[] = [{ type: "delta", text: "hi" }];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_10", source, {
			draft: "draft text",
			requestId: "req-xyz" as RequestId,
		});

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_10",
			events,
			inputText: "draft text",
			requestId: "req-xyz",
		});
	});
});

function createMinimalDeps(
	overrides?: Partial<
		Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "client">
	>,
): Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "client"> {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
		},
		client: { getMessages: vi.fn().mockResolvedValue([]) },
		log: { info: vi.fn(), warn: vi.fn() },
		...overrides,
	};
}

describe("countUniqueMessages", () => {
	it("counts user messages and unique assistant messageIds", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "Turn 1" },
			{ type: "delta", text: "Response 1", messageId: "msg_asst1" },
			{ type: "delta", text: "Response 1 cont", messageId: "msg_asst1" },
			{ type: "user_message", text: "Turn 2" },
			{ type: "delta", text: "Response 2", messageId: "msg_asst2" },
		];
		// 2 user messages + 2 unique assistant messageIds = 4
		expect(countUniqueMessages(events)).toBe(4);
	});

	it("returns 0 for empty events", () => {
		expect(countUniqueMessages([])).toBe(0);
	});

	it("counts only user_messages when no messageIds present", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response without messageId" },
		];
		expect(countUniqueMessages(events)).toBe(1);
	});

	it("ignores non-chat events", () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(countUniqueMessages(events)).toBe(0);
	});

	// ── Conservative heuristic documentation ────────────────────────────
	// These tests document intentional undercounting. SSE-path events may
	// lack messageId (translator only includes it when props.messageID is
	// non-null). Undercounting triggers a harmless REST fallback — this is
	// the designed safety margin, NOT a bug to fix.

	it("undercounts SSE-path deltas without messageId (triggers safe REST fallback)", () => {
		// SSE-path: translator may omit messageId when props.messageID is null
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" }, // no messageId
		];
		// Only user_message counted — assistant turn invisible to heuristic
		expect(countUniqueMessages(events)).toBe(1);
		// If OpenCode has 2 messages (1 user + 1 assistant), 1 < 2 → REST
		// fallback. Cache was complete but we serve from REST anyway. Safe.
	});

	it("undercounts tool-only turns where tool events lack messageId", () => {
		// Session where LLM only used tools, no text deltas
		const events: RelayMessage[] = [
			{ type: "user_message", text: "run the build" },
			{ type: "tool_start", id: "t1", name: "bash" }, // no messageId
			{
				type: "tool_result",
				id: "t1",
				content: "ok",
				is_error: false,
			},
		];
		// Only user_message counted — tool_start without messageId is invisible
		expect(countUniqueMessages(events)).toBe(1);
		// OpenCode has 2 messages → 1 < 2 → REST fallback on complete cache
	});

	it("correctly counts tool-only turns when tool events have messageId (poller path)", () => {
		// Poller-synthesized events always include messageId
		const events: RelayMessage[] = [
			{ type: "user_message", text: "run the build" },
			{ type: "tool_start", id: "t1", name: "bash", messageId: "msg_a1" },
			{
				type: "tool_result",
				id: "t1",
				content: "ok",
				is_error: false,
			},
		];
		// user_message (1) + unique messageId "msg_a1" (1) = 2
		expect(countUniqueMessages(events)).toBe(2);
		// Matches OpenCode's 2 messages → cache served, no REST fallback
	});
});

describe("resolveSessionHistory", () => {
	it("returns cached-events when cache has chat content", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});

		const result = await resolveSessionHistory("ses_1", deps);

		expect(result.kind).toBe("cached-events");
		expect(result.kind === "cached-events" && result.events).toEqual(events);
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("returns rest-history when cache misses", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
			total: 5,
		};
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_2", deps);

		expect(result.kind).toBe("rest-history");
		if (result.kind === "rest-history") {
			expect(result.history.messages).toEqual(history.messages);
			expect(result.history.hasMore).toBe(true);
			expect(result.history.total).toBe(5);
		}
	});

	it("returns rest-history when cache has events but no chat content", async () => {
		const events: RelayMessage[] = [{ type: "status", status: "idle" }];
		const history = { messages: [], hasMore: false };
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_3", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_3",
		);
	});

	it("returns empty when REST API fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("API down")),
			},
		});

		const result = await resolveSessionHistory("ses_4", deps);

		expect(result.kind).toBe("empty");
		expect(deps.log.warn).toHaveBeenCalled();
	});

	it("logs the session ID and error when REST fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockRejectedValue(new Error("timeout")),
			},
		});

		await resolveSessionHistory("ses_5", deps);

		const warnCall = vi.mocked(deps.log.warn).mock.calls[0]?.[0] as string;
		expect(warnCall).toContain("ses_5");
		expect(warnCall).toContain("timeout");
	});

	it("falls back to REST when cache has fewer messages than OpenCode", async () => {
		// Cache has events from 3 user turns, but OpenCode has 10 messages total
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "Turn 1" },
			{ type: "delta", text: "Response 1", messageId: "msg_asst1" },
			{ type: "user_message", text: "Turn 2" },
			{ type: "delta", text: "Response 2", messageId: "msg_asst2" },
			{ type: "user_message", text: "Turn 3" },
			{ type: "delta", text: "Response 3", messageId: "msg_asst3" },
		];
		const restHistory = {
			messages: Array.from({ length: 10 }, (_, i) => ({
				id: `m${i}`,
				role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			})),
			hasMore: false,
			total: 10,
		};
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(cachedEvents) },
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(restHistory),
			},
			client: {
				getMessages: vi.fn().mockResolvedValue([]),
				getMessageCount: vi.fn().mockResolvedValue(10),
			},
		});

		const result = await resolveSessionHistory("ses_stale", deps);

		expect(result.kind).toBe("rest-history");
		if (result.kind === "rest-history") {
			expect(result.history.total).toBe(10);
		}
	});

	it("uses cache when message count matches OpenCode", async () => {
		// Cache has 1 user_message + 1 delta with messageId = 2 unique messages
		// OpenCode also has 2 messages (1 user + 1 assistant)
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi there", messageId: "msg_asst1" },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(cachedEvents) },
			client: {
				getMessages: vi.fn().mockResolvedValue([]),
				getMessageCount: vi.fn().mockResolvedValue(2),
			},
		});

		const result = await resolveSessionHistory("ses_fresh", deps);

		expect(result.kind).toBe("cached-events");
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("uses cache when getMessageCount is unavailable (graceful degradation)", async () => {
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(cachedEvents) },
			// client has no getMessageCount — graceful degradation
		});

		const result = await resolveSessionHistory("ses_no_count", deps);

		expect(result.kind).toBe("cached-events");
	});

	it("uses cache when getMessageCount rejects (network error)", async () => {
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		const deps = createMinimalDeps({
			client: {
				getMessages: vi.fn().mockResolvedValue([]),
				getMessageCount: vi.fn().mockRejectedValue(new Error("timeout")),
			},
			messageCache: { getEvents: vi.fn().mockReturnValue(cachedEvents) },
		});

		const result = await resolveSessionHistory("ses_err", deps);

		// Graceful degradation: serve stale cache rather than nothing
		expect(result.kind).toBe("cached-events");
	});

	it("uses cache for user-message-only session (no assistant response yet)", async () => {
		// User just sent a message, assistant hasn't responded
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(cachedEvents) },
			client: {
				getMessages: vi.fn().mockResolvedValue([]),
				getMessageCount: vi.fn().mockResolvedValue(1),
			},
		});

		const result = await resolveSessionHistory("ses_pending", deps);

		expect(result.kind).toBe("cached-events");
	});
});

// ─── switchClientToSession (orchestrator) ──────────────────────────────────

function createFullDeps(
	overrides?: Partial<SessionSwitchDeps>,
): SessionSwitchDeps {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
		},
		wsHandler: {
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		client: { getMessages: vi.fn().mockResolvedValue([]) },
		log: { info: vi.fn(), warn: vi.fn() },
		getInputDraft: vi.fn().mockReturnValue(undefined),
		...overrides,
	};
}

describe("switchClientToSession", () => {
	it("does nothing when sessionId is empty", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "");
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalled();
	});

	it("sets client session in registry", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith("c1", "ses_1");
	});

	it("sends session_switched with cache-hit events", async () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hi" }];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		// Session is idle and cache has no done — synthetic done is appended
		const sentEvents = (switchMsg?.[1] as { events?: RelayMessage[] }).events;
		expect(sentEvents).toEqual([...events, { type: "done", code: 0 }]);
	});

	it("sends session_switched with REST history on cache miss", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
		};
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});
		await switchClientToSession(deps, "c1", "ses_2");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect((switchMsg?.[1] as { history?: unknown }).history).toEqual({
			messages: history.messages,
			hasMore: true,
		});
	});

	it("sends session_switched with empty payload when REST fails", async () => {
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockRejectedValue(new Error("fail")),
			},
		});
		await switchClientToSession(deps, "c1", "ses_3");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload["id"]).toBe("ses_3");
		expect(payload["events"]).toBeUndefined();
		expect(payload["history"]).toBeUndefined();
	});

	it("sends status message (idle) after session_switched", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect(statusMsg).toBeDefined();
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("sends status 'processing' when session is busy", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("processing");
	});

	it("defaults to idle when statusPoller is undefined", async () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { statusPoller, ...rest } = createFullDeps();
		const deps = rest as SessionSwitchDeps;
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("includes inputText from draft", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue("my draft"),
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { inputText?: string }).inputText).toBe(
			"my draft",
		);
	});

	it("includes requestId when provided", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", {
			requestId: "req-abc" as RequestId,
		});
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { requestId?: string }).requestId).toBe(
			"req-abc",
		);
	});

	it("skips history lookup when skipHistory is true", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", { skipHistory: true });
		expect(deps.messageCache.getEvents).not.toHaveBeenCalled();
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload["events"]).toBeUndefined();
		expect(payload["history"]).toBeUndefined();
	});

	it("seeds poller when pollerManager is not polling", async () => {
		const msgs = [{ id: "m1" }];
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
			client: { getMessages: vi.fn().mockResolvedValue(msgs) },
		});
		await switchClientToSession(deps, "c1", "ses_1");
		await vi.waitFor(() => {
			expect(deps.pollerManager?.startPolling).toHaveBeenCalled();
		});
		expect(deps.client.getMessages).toHaveBeenCalledWith("ses_1");
		expect(deps.pollerManager?.startPolling).toHaveBeenCalledWith(
			"ses_1",
			msgs,
		);
	});

	it("skips poller seeding when skipPollerSeed is true", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1", {
			skipPollerSeed: true,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(deps.client.getMessages).not.toHaveBeenCalled();
	});

	it("skips poller seeding when pollerManager is undefined", async () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { pollerManager, ...rest } = createFullDeps();
		const deps = rest as SessionSwitchDeps;
		await switchClientToSession(deps, "c1", "ses_1");
	});

	it("logs but does not throw when poller seeding fails", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
			client: {
				getMessages: vi.fn().mockRejectedValue(new Error("fail")),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1");
		await vi.waitFor(() => {
			expect(deps.log.warn).toHaveBeenCalled();
		});
	});

	// ─── Ordering and argument correctness ──────────────────────────────

	it("sends session_switched before status", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		const statusIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "status",
		);
		expect(switchIdx).toBeGreaterThanOrEqual(0);
		expect(statusIdx).toBeGreaterThanOrEqual(0);
		expect(switchIdx).toBeLessThan(statusIdx);
	});

	it("sets client session before sending any messages", async () => {
		const callOrder: string[] = [];
		const deps = createFullDeps({
			wsHandler: {
				setClientSession: vi.fn(() => callOrder.push("setClient")),
				sendTo: vi.fn(() => callOrder.push("sendTo")),
			},
		});
		await switchClientToSession(deps, "c1", "ses_1");
		expect(callOrder[0]).toBe("setClient");
		expect(callOrder.filter((c) => c === "sendTo").length).toBeGreaterThan(0);
	});

	it("calls getInputDraft with the target sessionId", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_42");
		expect(deps.getInputDraft).toHaveBeenCalledWith("ses_42");
	});

	it("omits inputText when getInputDraft returns empty string", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue(""),
		});
		await switchClientToSession(deps, "c1", "ses_1");
		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect("inputText" in (switchMsg?.[1] ?? {})).toBe(false);
	});

	it("appends synthetic done to cached-events when session is idle and cache lacks done", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		// Last event should be synthetic done
		const lastEvent = payload.events?.[payload.events.length - 1];
		expect(lastEvent).toEqual({ type: "done", code: 0 });
	});

	it("does NOT append done when session is processing", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "thinking..." },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const doneEvents = payload.events?.filter((e) => e.type === "done") ?? [];
		expect(doneEvents).toHaveLength(0);
	});

	it("does NOT append done when cache already has one", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
			{ type: "done", code: 0 },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const doneEvents = payload.events?.filter((e) => e.type === "done") ?? [];
		expect(doneEvents).toHaveLength(1); // Original only, no duplicate
	});

	it("appends synthetic done when statusPoller is undefined (assumes idle)", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi" },
		];
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { statusPoller, ...rest } = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});
		const deps = rest as SessionSwitchDeps;

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		const payload = switchMsg?.[1] as { events?: RelayMessage[] };
		const lastEvent = payload.events?.[payload.events.length - 1];
		expect(lastEvent).toEqual({ type: "done", code: 0 });
	});
});
