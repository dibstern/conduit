// test/unit/provider/claude/claude-adapter-lifecycle.test.ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import type {
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
} from "../../../../src/lib/provider/claude/types.js";

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

	describe("sendTurn()", () => {
		it("throws not-implemented error", async () => {
			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			await expect(adapter.sendTurn({} as never)).rejects.toThrow(
				"not implemented",
			);
		});
	});
});
