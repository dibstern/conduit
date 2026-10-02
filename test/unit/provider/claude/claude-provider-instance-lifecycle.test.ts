// test/unit/provider/claude/claude-provider-instance-lifecycle.test.ts

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../../src/lib/persistence/events.js";
import type {
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
} from "../../../../src/lib/provider/claude/types.js";
import type { TurnResult } from "../../../../src/lib/provider/types.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import {
	getClaudeRuntimeSessionCountForTest,
	hasClaudeRuntimeSessionForTest,
	hasClaudeRuntimeTurnWaitersForTest,
	setClaudeRuntimeSessionForTest,
	setClaudeRuntimeTurnWaitersForTest,
} from "../../../helpers/claude-runtime-state.js";
import {
	createMockEventSink,
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";
import { partialFake } from "../../../helpers/partial-fake.js";

function makeFakeSessionContext(
	sessionId: string,
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId,
		workspaceRoot: "/tmp/ws",
		startedAt: new Date().toISOString(),
		promptQueue: partialFake<ClaudeSessionContext["promptQueue"]>({
			close: vi.fn(() => Effect.void),
			enqueue: vi.fn(() => Effect.void),
			[Symbol.asyncIterator]: vi.fn(),
		}),
		query: partialFake<ClaudeSessionContext["query"]>({
			interrupt: vi.fn(async () => undefined),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		}),
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

function collectTurnFailure(
	deferred: Deferred.Deferred<TurnResult, Error>,
	rejected: Error[],
): Promise<void> {
	return Effect.runPromise(Deferred.await(deferred).pipe(Effect.either)).then(
		(result) => {
			if (result._tag === "Left") rejected.push(result.left);
		},
	);
}

describe("ClaudeProviderInstance lifecycle", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-lifecycle-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	describe("setPermissionModeEffect()", () => {
		it.each([
			{ mode: "auto" as const, sdkMode: "auto" },
			{ mode: "ask" as const, sdkMode: "default" },
		])("updates a live query to $sdkMode for conduit $mode", async ({
			mode,
			sdkMode,
		}) => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const query = createMockQuery([]);
			const ctx = makeFakeSessionContext("sess-1", { query });
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.setPermissionModeEffect("sess-1", mode));

			expect(query.setPermissionMode).toHaveBeenCalledWith(sdkMode);
		});
	});

	describe("shutdown()", () => {
		it("leaves an in-flight question open while completing other tools", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const sink = {
				...createMockEventSink(),
				cancelSessionInteractions: vi.fn(() => Effect.void),
			};
			const ctx = makeFakeSessionContext("sess-1", {
				eventSink: sink,
				lastAssistantUuid: "message-1",
			});
			for (const [index, toolName] of ["AskUserQuestion", "Bash"].entries()) {
				ctx.inFlightTools.set(index, {
					itemId: `tool-${index}`,
					toolName,
					title: toolName,
					input: {},
					partialInputJson: "",
				});
			}
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			const completed = (sink.push as ReturnType<typeof vi.fn>).mock.calls
				.map(([event]) => event as CanonicalEvent)
				.filter((event) => event.type === "tool.completed");
			expect(completed.map((event) => event.data.partId)).toEqual(["tool-1"]);
			expect(sink.cancelSessionInteractions).toHaveBeenCalledWith(
				"Provider instance shutting down",
				{ recoverQuestions: true },
			);
		});
		it("rejects queued turn deferreds with the shutdown reason", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-shutdown");
			setClaudeRuntimeSessionForTest(instance, "sess-shutdown", ctx);
			const deferred = await Effect.runPromise(
				Deferred.make<TurnResult, Error>(),
			);
			setClaudeRuntimeTurnWaitersForTest(instance, "sess-shutdown", [deferred]);
			const result = Effect.runPromise(
				Deferred.await(deferred).pipe(Effect.either),
			);

			await Effect.runPromise(instance.shutdownEffect());

			expect(await result).toMatchObject({
				_tag: "Left",
				left: { message: "Provider instance shutting down" },
			});
		});

		it("closes all active sessions", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.close).toHaveBeenCalled();
			expect(getClaudeRuntimeSessionCountForTest(instance)).toBe(0);
		});

		it("marks sessions as stopped", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			expect(ctx.stopped).toBe(true);
		});

		it("resolves pending approvals with reject on shutdown", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
				createdAt: new Date().toISOString(),
				resolve: (decision) =>
					Effect.sync(() => {
						resolvedWith.push(decision);
					}),
				reject: vi.fn(() => Effect.void),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			expect(resolvedWith).toContain("reject");
		});

		it("rejects pending questions on shutdown", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const rejected: Error[] = [];
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: vi.fn(() => Effect.void),
				reject: (err) =>
					Effect.sync(() => {
						rejected.push(err);
					}),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			expect(rejected).toHaveLength(1);
			expect(rejected[0]?.message).toContain("shutting down");
		});

		it("is idempotent for already-stopped sessions", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1", { stopped: true });
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.shutdownEffect());

			// close/interrupt should NOT be called since session was already stopped
			expect(ctx.promptQueue.close).not.toHaveBeenCalled();
			expect(getClaudeRuntimeSessionCountForTest(instance)).toBe(0);
		});
	});

	describe("interruptTurnEffect()", () => {
		it("closes prompt queue, interrupts and closes query", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.interrupt).toHaveBeenCalled();
			// The process goes too, or armed Monitor tasks outlive the Stop.
			expect(ctx.query.close).toHaveBeenCalled();
			expect(ctx.stopped).toBe(true);
		});

		it("is idempotent for an already-interrupted active session", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));
			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(ctx.promptQueue.close).toHaveBeenCalledTimes(1);
			expect(ctx.query.interrupt).toHaveBeenCalledTimes(1);
			expect(ctx.stopped).toBe(true);
		});

		it("resolves pending approvals with reject", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: {},
				createdAt: new Date().toISOString(),
				resolve: (decision) =>
					Effect.sync(() => {
						resolvedWith.push(decision);
					}),
				reject: vi.fn(() => Effect.void),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(resolvedWith).toContain("reject");
			expect(ctx.pendingApprovals.size).toBe(0);
		});

		it("resolves all queued turn deferreds as interrupted", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-interrupt-reject");
			setClaudeRuntimeSessionForTest(instance, "sess-interrupt-reject", ctx);

			const d1 = await Effect.runPromise(Deferred.make<TurnResult, Error>());
			const d2 = await Effect.runPromise(Deferred.make<TurnResult, Error>());
			setClaudeRuntimeTurnWaitersForTest(instance, "sess-interrupt-reject", [
				d1,
				d2,
			]);

			await Effect.runPromise(
				instance.interruptTurnEffect("sess-interrupt-reject"),
			);
			const results = await Promise.all([
				Effect.runPromise(Deferred.await(d1)),
				Effect.runPromise(Deferred.await(d2)),
			]);

			for (const result of results) {
				expect(result).toEqual({
					status: "interrupted",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				});
			}
			expect(
				hasClaudeRuntimeTurnWaitersForTest(instance, "sess-interrupt-reject"),
			).toBe(false);
		});

		it("rejects pending questions", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const rejected: Error[] = [];
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: vi.fn(() => Effect.void),
				reject: (err) =>
					Effect.sync(() => {
						rejected.push(err);
					}),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(rejected).toHaveLength(1);
			expect(rejected[0]?.message).toContain("interrupted");
		});

		it("is a no-op when session does not exist", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			// Should not throw
			await Effect.runPromise(instance.interruptTurnEffect("nonexistent"));
		});

		it("clears in-flight tools", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			ctx.inFlightTools.set(0, {
				itemId: "tool-1",
				toolName: "Bash",
				title: "Command run",
				input: {},
				partialInputJson: "",
			});
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(ctx.inFlightTools.size).toBe(0);
		});

		it("cleanupSession with no eventSink skips tool.completed emission", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
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
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			// Should not throw even though eventSink is undefined
			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			// In-flight tools should still be cleared
			expect(ctx.inFlightTools.size).toBe(0);
			expect(ctx.stopped).toBe(true);
		});

		it("emits tool.completed events via EventSink for in-flight tools on interrupt", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
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
			ctx.inFlightTools.set(2, {
				itemId: "question-1",
				toolName: "AskUserQuestion",
				title: "Question",
				input: {},
				partialInputJson: "",
			});
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
				.calls as Array<[CanonicalEvent]>;
			const completedEvents = pushCalls.filter(
				(call) => call[0].type === "tool.completed",
			);
			expect(completedEvents).toHaveLength(3);
			expect(completedEvents[0]?.[0].data).toMatchObject({
				partId: "tool-1",
				result: null,
			});
			expect(completedEvents[1]?.[0].data).toMatchObject({
				partId: "tool-2",
				result: null,
			});
			expect(completedEvents[2]?.[0].data).toMatchObject({
				partId: "question-1",
				result: null,
			});
		});

		it("persists turn.interrupted + session.status idle for an in-flight turn", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const sink = createMockEventSink();
			const ctx = makeFakeSessionContext("sess-1", {
				eventSink: sink,
				lastAssistantUuid: "asst-uuid",
			});
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);
			const deferred = await Effect.runPromise(
				Deferred.make<TurnResult, Error>(),
			);
			setClaudeRuntimeTurnWaitersForTest(instance, "sess-1", [deferred]);
			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));
			expect(await Effect.runPromise(Deferred.await(deferred))).toMatchObject({
				status: "interrupted",
			});

			const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
				.calls as Array<[CanonicalEvent]>;
			const interrupted = pushCalls.find(
				(call) => call[0].type === "turn.interrupted",
			);
			expect(interrupted?.[0].data).toMatchObject({ messageId: "asst-uuid" });
			const idle = pushCalls.find((call) => call[0].type === "session.status");
			expect(idle?.[0].data).toMatchObject({
				sessionId: "sess-1",
				status: "idle",
			});
		});

		it("does not emit terminal turn events when no turn is in flight", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const sink = createMockEventSink();
			const ctx = makeFakeSessionContext("sess-1", { eventSink: sink });
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			const pushCalls = (sink.push as ReturnType<typeof vi.fn>).mock
				.calls as Array<[CanonicalEvent]>;
			expect(
				pushCalls.some((call) => call[0].type === "turn.interrupted"),
			).toBe(false);
		});

		it("treats cancelSessionInteractions as best-effort when it throws synchronously", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const sink = createMockEventSink();
			sink.cancelSessionInteractions = vi.fn(() => {
				throw new Error("interaction cancel failed");
			});
			const ctx = makeFakeSessionContext("sess-1", {
				eventSink: sink,
			});
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(instance.interruptTurnEffect("sess-1"));

			expect(sink.cancelSessionInteractions).toHaveBeenCalledWith(
				"Turn interrupted",
				{ recoverQuestions: false },
			);
			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.interrupt).toHaveBeenCalled();
			expect(ctx.stopped).toBe(true);
		});
	});

	describe("resolvePermission()", () => {
		it("resolves the pending approval's deferred", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const resolvedWith: string[] = [];
			const pending: PendingApproval = {
				requestId: "perm-1",
				toolName: "Bash",
				toolInput: {},
				createdAt: new Date().toISOString(),
				resolve: (decision) =>
					Effect.sync(() => {
						resolvedWith.push(decision);
					}),
				reject: vi.fn(() => Effect.void),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingApprovals.set("perm-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(
				instance.resolvePermissionEffect("sess-1", "perm-1", "once"),
			);

			expect(resolvedWith).toContain("once");
		});

		it("is a no-op for unknown session", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			// Should not throw
			await Effect.runPromise(
				instance.resolvePermissionEffect("nonexistent", "perm-1", "once"),
			);
		});

		it("is a no-op for unknown requestId", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-1");
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			// Should not throw
			await Effect.runPromise(
				instance.resolvePermissionEffect("sess-1", "nonexistent", "once"),
			);
		});
	});

	describe("endSessionEffect()", () => {
		it("signals session-ended on terminal disposal", async () => {
			const onBackgroundTask = vi.fn();
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
				onBackgroundTask,
			});
			const ctx = makeFakeSessionContext("sess-end");
			setClaudeRuntimeSessionForTest(instance, "sess-end", ctx);

			await Effect.runPromise(instance.endSessionEffect("sess-end"));
			expect(onBackgroundTask).toHaveBeenCalledOnce();
			expect(onBackgroundTask).toHaveBeenCalledWith({
				sessionId: "sess-end",
				kind: "session-ended",
			});
		});

		it("closes query and removes session from map", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-end");
			setClaudeRuntimeSessionForTest(instance, "sess-end", ctx);

			await Effect.runPromise(instance.endSessionEffect("sess-end"));

			expect(ctx.promptQueue.close).toHaveBeenCalled();
			expect(ctx.query.close).toHaveBeenCalled();
			expect(ctx.stopped).toBe(true);
			expect(getClaudeRuntimeSessionCountForTest(instance)).toBe(0);
		});

		it("is a no-op for unknown session", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			// Should not throw
			await Effect.runPromise(instance.endSessionEffect("nonexistent"));
		});

		it("rejects queued turn deferreds with reload reason", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			const ctx = makeFakeSessionContext("sess-reject");
			setClaudeRuntimeSessionForTest(instance, "sess-reject", ctx);

			const d1 = await Effect.runPromise(Deferred.make<TurnResult, Error>());
			const d2 = await Effect.runPromise(Deferred.make<TurnResult, Error>());
			setClaudeRuntimeTurnWaitersForTest(instance, "sess-reject", [d1, d2]);

			const rejected: Error[] = [];
			const caught = [
				collectTurnFailure(d1, rejected),
				collectTurnFailure(d2, rejected),
			];

			await Effect.runPromise(instance.endSessionEffect("sess-reject"));
			await Promise.all(caught);

			expect(rejected).toHaveLength(2);
			expect(rejected[0]?.message).toContain("reload");
			expect(rejected[1]?.message).toContain("reload");
			// The deferred queue should be cleared
			expect(hasClaudeRuntimeTurnWaitersForTest(instance, "sess-reject")).toBe(
				false,
			);
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

			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
				queryFactory: factory,
			});

			const sink = createMockEventSink();
			// Establish session
			await Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "sess-reload-flow",
						turnId: "turn-1",
						model: { providerId: "claude", modelId: "sonnet" },
						eventSink: sink,
					}),
				),
			);

			// End session (user-initiated reload)
			await Effect.runPromise(instance.endSessionEffect("sess-reload-flow"));
			expect(hasClaudeRuntimeSessionForTest(instance, "sess-reload-flow")).toBe(
				false,
			);

			// Next sendTurn should create a brand new query
			const r2 = await Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "sess-reload-flow",
						turnId: "turn-2",
						model: { providerId: "claude", modelId: "sonnet" },
						eventSink: sink,
					}),
				),
			);
			expect(r2.status).toBe("completed");
			expect(factory).toHaveBeenCalledTimes(2);
		});
	});

	describe("resolveQuestion()", () => {
		it("resolves the pending question's deferred", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			let resolvedAnswers: Record<string, unknown> | undefined;
			const pending: PendingQuestion = {
				requestId: "q-1",
				createdAt: new Date().toISOString(),
				resolve: (answers) =>
					Effect.sync(() => {
						resolvedAnswers = answers;
					}),
				reject: vi.fn(() => Effect.void),
			};
			const ctx = makeFakeSessionContext("sess-1");
			ctx.pendingQuestions.set("q-1", pending);
			setClaudeRuntimeSessionForTest(instance, "sess-1", ctx);

			await Effect.runPromise(
				instance.resolveQuestionEffect("sess-1", "q-1", { answer: "yes" }),
			);

			expect(resolvedAnswers).toEqual({ answer: "yes" });
			expect(ctx.pendingQuestions.has("q-1")).toBe(false);
		});

		it("is a no-op for unknown session", async () => {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: workspace,
			});
			await Effect.runPromise(
				instance.resolveQuestionEffect("nonexistent", "q-1", {}),
			);
		});
	});

	// sendTurn() tests are in claude-provider-instance-send-turn.test.ts
});
