// test/unit/provider/claude/claude-adapter-lifecycle.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import type {
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
} from "../../../../src/lib/provider/claude/types.js";
import { createDeferred } from "../../../../src/lib/provider/deferred.js";
import type { TurnResult } from "../../../../src/lib/provider/types.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

function makeFakeSessionContext(
	sessionId: string,
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId,
		workspaceRoot: "/tmp/ws",
		startedAt: new Date().toISOString(),
		promptQueue: {
			close: vi.fn(),
			enqueue: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(async () => {}),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

describe("ClaudeAdapter lifecycle", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-lifecycle-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	describe("shutdown()", () => {
		it("closes all active sessions", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.shutdown();

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.close).toHaveBeenCalled();
			expect(
				(adapter as unknown as { sessions: Map<string, unknown> }).sessions
					.size,
			).toBe(0);
		});

		it("marks sessions as stopped", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.shutdown();

			expect(ctx.stopped).toBe(true);
		});

		it("resolves pending approvals with reject on shutdown", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
				createdAt: new Date().toISOString(),
				resolve: (decision) => {
					resolvedWith.push(decision);
				},
				reject: vi.fn(),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.shutdown();

			expect(resolvedWith).toContain("reject");
		});

		it("rejects pending questions on shutdown", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const rejected: Error[] = [];
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: vi.fn(),
				reject: (err) => {
					rejected.push(err);
				},
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.shutdown();

			expect(rejected).toHaveLength(1);
			expect(rejected[0]?.message).toContain("shutting down");
		});

		it("is idempotent for already-stopped sessions", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1", { stopped: true });
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.shutdown();

			// close/interrupt should NOT be called since session was already stopped
			expect(ctx.promptQueue.close).not.toHaveBeenCalled();
			expect(
				(adapter as unknown as { sessions: Map<string, unknown> }).sessions
					.size,
			).toBe(0);
		});
	});

	describe("interruptTurn()", () => {
		it("closes prompt queue and interrupts query", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.interruptTurn("sess-1");

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.interrupt).toHaveBeenCalled();
			expect(ctx.stopped).toBe(true);
		});

		it("resolves pending approvals with reject", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: {},
				createdAt: new Date().toISOString(),
				resolve: (decision) => {
					resolvedWith.push(decision);
				},
				reject: vi.fn(),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.interruptTurn("sess-1");

			expect(resolvedWith).toContain("reject");
			expect(ctx.pendingApprovals.size).toBe(0);
		});

		it("rejects pending questions", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const rejected: Error[] = [];
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: vi.fn(),
				reject: (err) => {
					rejected.push(err);
				},
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.interruptTurn("sess-1");

			expect(rejected).toHaveLength(1);
			expect(rejected[0]?.message).toContain("interrupted");
		});

		it("is a no-op when session does not exist", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			// Should not throw
			await adapter.interruptTurn("nonexistent");
		});

		it("clears in-flight tools", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1");
			ctx.inFlightTools.set(0, {
				itemId: "tool-1",
				toolName: "Bash",
				title: "Command run",
				input: {},
				partialInputJson: "",
			});
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.interruptTurn("sess-1");

			expect(ctx.inFlightTools.size).toBe(0);
		});

		it("cleanupSession with no eventSink skips tool.completed emission", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1", {
				eventSink: undefined,
			});
			ctx.inFlightTools.set(0, {
				itemId: "tool-1",
				toolName: "Bash",
				title: "Command run",
				input: {},
				partialInputJson: "",
			});
			ctx.inFlightTools.set(1, {
				itemId: "tool-2",
				toolName: "Read",
				title: "File read",
				input: {},
				partialInputJson: "",
			});
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			// Should not throw even though eventSink is undefined
			await adapter.interruptTurn("sess-1");

			// In-flight tools should still be cleared
			expect(ctx.inFlightTools.size).toBe(0);
			expect(ctx.stopped).toBe(true);
		});

		it("emits tool.completed events via EventSink for in-flight tools on interrupt", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const sink = createMockEventSink();
			const ctx = makeFakeSessionContext("sess-1");
			ctx.eventSink = sink;
			ctx.lastAssistantUuid = "asst-uuid";
			ctx.inFlightTools.set(0, {
				itemId: "tool-1",
				toolName: "Bash",
				title: "Command run",
				input: {},
				partialInputJson: "",
			});
			ctx.inFlightTools.set(1, {
				itemId: "tool-2",
				toolName: "Read",
				title: "File read",
				input: {},
				partialInputJson: "",
			});
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.interruptTurn("sess-1");

			const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
				.calls as Array<[CanonicalEvent]>;
			const completedEvents = pushCalls.filter(
				(call) => call[0].type === "tool.completed",
			);
			expect(completedEvents).toHaveLength(2);
			expect(completedEvents[0]?.[0].data).toMatchObject({
				partId: "tool-1",
				result: null,
			});
			expect(completedEvents[1]?.[0].data).toMatchObject({
				partId: "tool-2",
				result: null,
			});
		});
	});

	describe("resolvePermission()", () => {
		it("resolves the pending approval's deferred", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: {},
				createdAt: new Date().toISOString(),
				resolve: (decision) => {
					resolvedWith.push(decision);
				},
				reject: vi.fn(),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.resolvePermission("sess-1", "perm-1", "once");

			expect(resolvedWith).toContain("once");
		});

		it("is a no-op for unknown session", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			// Should not throw
			await adapter.resolvePermission("nonexistent", "perm-1", "once");
		});

		it("is a no-op for unknown requestId", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-1");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			// Should not throw
			await adapter.resolvePermission("sess-1", "nonexistent", "once");
		});
	});

	describe("endSession()", () => {
		it("closes query and removes session from map", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-end");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-end", ctx);

			await adapter.endSession("sess-end");

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.close).toHaveBeenCalled();
			expect(ctx.stopped).toBe(true);
			expect(
				(adapter as unknown as { sessions: Map<string, unknown> }).sessions
					.size,
			).toBe(0);
		});

		it("is a no-op for unknown session", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			// Should not throw
			await adapter.endSession("nonexistent");
		});

		it("rejects queued turn deferreds with reload reason", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const ctx = makeFakeSessionContext("sess-reject");
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-reject", ctx);

			// Simulate two queued turn deferreds
			const d1 = createDeferred<TurnResult>();
			const d2 = createDeferred<TurnResult>();
			(
				adapter as unknown as {
					turnDeferredQueues: Map<string, (typeof d1)[]>;
				}
			).turnDeferredQueues.set("sess-reject", [d1, d2]);

			// Swallow rejections to avoid unhandled-promise warnings
			const rejected: Error[] = [];
			d1.promise.catch((e) => rejected.push(e));
			d2.promise.catch((e) => rejected.push(e));

			await adapter.endSession("sess-reject");

			// Flush microtasks
			await Promise.resolve();
			await Promise.resolve();

			expect(rejected).toHaveLength(2);
			expect(rejected[0]?.message).toContain("reload");
			expect(rejected[1]?.message).toContain("reload");
			// The deferred queue should be cleared
			expect(
				(
					adapter as unknown as {
						turnDeferredQueues: Map<string, unknown>;
					}
				).turnDeferredQueues.has("sess-reject"),
			).toBe(false);
		});

		it("endSession followed by sendTurn creates a fresh query", async () => {
			const result1 = makeSuccessResult();
			const result2 = makeSuccessResult({ total_cost_usd: 0.13 } as Record<
				string,
				unknown
			>);

			const queryA = createMockQuery([result1]);
			const queryB = createMockQuery([result2]);

			let calls = 0;
			const factory = vi.fn(() => {
				calls++;
				return calls === 1 ? queryA : queryB;
			});

			const adapter = new ClaudeAdapter({
				workspaceRoot: workspace,
				queryFactory: factory,
			});

			const sink = createMockEventSink();
			// Establish session
			await adapter.sendTurn(
				makeBaseSendTurnInput({
					sessionId: "sess-reload-flow",
					turnId: "turn-1",
					eventSink: sink,
				}),
			);

			// End session (user-initiated reload)
			await adapter.endSession("sess-reload-flow");
			expect(
				(adapter as unknown as { sessions: Map<string, unknown> }).sessions.has(
					"sess-reload-flow",
				),
			).toBe(false);

			// Next sendTurn should create a brand new query
			const r2 = await adapter.sendTurn(
				makeBaseSendTurnInput({
					sessionId: "sess-reload-flow",
					turnId: "turn-2",
					eventSink: sink,
				}),
			);
			expect(r2.status).toBe("completed");
			expect(factory).toHaveBeenCalledTimes(2);
		});
	});

	describe("resolveQuestion()", () => {
		it("resolves the pending question's deferred", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			let resolvedAnswers: Record<string, unknown> | undefined;
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: (answers) => {
					resolvedAnswers = answers;
				},
				reject: vi.fn(),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			(
				adapter as unknown as { sessions: Map<string, ClaudeSessionContext> }
			).sessions.set("sess-1", ctx);

			await adapter.resolveQuestion("sess-1", "q-1", { answer: "yes" });

			expect(resolvedAnswers).toEqual({ answer: "yes" });
			expect(ctx.pendingQuestions.has("q-1")).toBe(false);
		});

		it("is a no-op for unknown session", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			await adapter.resolveQuestion("nonexistent", "q-1", {});
		});
	});

	// sendTurn() tests are in claude-adapter-send-turn.test.ts
});
