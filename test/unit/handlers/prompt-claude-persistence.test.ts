import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type {
	CanonicalEvent,
	StoredEvent,
} from "../../../src/lib/persistence/events.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { RelayEventSinkPersist } from "../../../src/lib/provider/relay-event-sink.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mock claudeEventPersist that records append() calls in order. */
function createMockClaudeEventPersist() {
	const appendedEvents: CanonicalEvent[] = [];
	const projectedEvents: StoredEvent[] = [];

	const persist: RelayEventSinkPersist = {
		ensureSession: vi.fn(),
		eventStore: {
			append: vi.fn().mockImplementation((event: CanonicalEvent) => {
				appendedEvents.push(event);
				// Return a StoredEvent (add sequence + streamVersion)
				return {
					...event,
					sequence: appendedEvents.length,
					streamVersion: 1,
				} as StoredEvent;
			}),
		},
		projectionRunner: {
			projectEvent: vi.fn().mockImplementation((event: StoredEvent) => {
				projectedEvents.push(event);
			}),
		},
	};

	return { persist, appendedEvents, projectedEvents };
}

/** Build a mock OrchestrationEngine that routes to "claude". */
function createMockOrchestrationEngine(): OrchestrationEngine {
	return {
		dispatch: vi.fn().mockResolvedValue({
			status: "completed" as const,
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		}),
		bindSession: vi.fn(),
		unbindSession: vi.fn(),
		getProviderForSession: vi.fn().mockReturnValue("claude"),
		listBoundSessions: vi.fn().mockReturnValue([]),
		shutdown: vi.fn().mockResolvedValue(undefined),
	} as unknown as OrchestrationEngine;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("handleMessage – Claude persistence event ordering", () => {
	it("emits session.created before message.created and text.delta", async () => {
		const { persist, appendedEvents } = createMockClaudeEventPersist();
		const engine = createMockOrchestrationEngine();

		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
			claudeEventPersist: persist,
		});

		// resolveSession reads from wsHandler.getClientSession
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");

		await handleMessage(deps, "client-1", { text: "Hello Claude" });

		// Should have appended exactly 3 events
		expect(appendedEvents).toHaveLength(3);
		expect(appendedEvents[0]?.type).toBe("session.created");
		expect(appendedEvents[1]?.type).toBe("message.created");
		expect(appendedEvents[2]?.type).toBe("text.delta");
	});

	it("session.created payload contains sessionId, title, and provider", async () => {
		const { persist, appendedEvents } = createMockClaudeEventPersist();
		const engine = createMockOrchestrationEngine();

		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
			claudeEventPersist: persist,
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-2");

		await handleMessage(deps, "client-1", { text: "Hi" });

		const sessionEvt = appendedEvents[0];
		expect(sessionEvt).toBeDefined();
		expect(sessionEvt?.type).toBe("session.created");
		expect(sessionEvt?.sessionId).toBe("ses-2");
		expect(sessionEvt?.data).toEqual({
			sessionId: "ses-2",
			title: "Claude Session",
			provider: "claude",
		});
		expect(sessionEvt?.provider).toBe("claude");
	});

	it("projects every appended event via projectionRunner", async () => {
		const { persist, projectedEvents } = createMockClaudeEventPersist();
		const engine = createMockOrchestrationEngine();

		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
			claudeEventPersist: persist,
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-3");

		await handleMessage(deps, "client-1", { text: "Test" });

		// Each appended event should be projected
		expect(projectedEvents).toHaveLength(3);
		expect(projectedEvents[0]?.type).toBe("session.created");
		expect(projectedEvents[1]?.type).toBe("message.created");
		expect(projectedEvents[2]?.type).toBe("text.delta");
	});

	it("calls ensureSession before emitting any events", async () => {
		const { persist } = createMockClaudeEventPersist();
		const engine = createMockOrchestrationEngine();

		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
			claudeEventPersist: persist,
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-4");

		// Track call order
		const callOrder: string[] = [];
		vi.mocked(persist.ensureSession).mockImplementation(() => {
			callOrder.push("ensureSession");
		});
		vi.mocked(persist.eventStore.append).mockImplementation(
			(event: CanonicalEvent) => {
				callOrder.push(`append:${event.type}`);
				return { ...event, sequence: 1, streamVersion: 1 } as StoredEvent;
			},
		);

		await handleMessage(deps, "client-1", { text: "Order test" });

		expect(callOrder[0]).toBe("ensureSession");
		expect(callOrder[1]).toBe("append:session.created");
		expect(callOrder[2]).toBe("append:message.created");
		expect(callOrder[3]).toBe("append:text.delta");
	});

	it("does not emit persistence events when claudeEventPersist is undefined", async () => {
		const engine = createMockOrchestrationEngine();
		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
		});
		// Ensure claudeEventPersist is not set (default from mock factory)
		(deps as unknown as { claudeEventPersist?: unknown }).claudeEventPersist =
			undefined;
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-5");

		// Should not throw; no persistence events emitted
		await handleMessage(deps, "client-1", { text: "No persist" });

		// Engine dispatch should still be called
		expect(engine.dispatch).toHaveBeenCalled();
	});

	it("does not emit persistence events for non-claude providers", async () => {
		const { persist, appendedEvents } = createMockClaudeEventPersist();
		const engine = createMockOrchestrationEngine();
		// Return "opencode" instead of "claude"
		vi.mocked(engine.getProviderForSession).mockReturnValue("opencode");

		const deps = createMockHandlerDeps({
			orchestrationEngine: engine,
			claudeEventPersist: persist,
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-6");

		await handleMessage(deps, "client-1", { text: "OpenCode msg" });

		// No events should be appended for non-claude provider
		expect(appendedEvents).toHaveLength(0);
		expect(persist.ensureSession).not.toHaveBeenCalled();
	});
});
