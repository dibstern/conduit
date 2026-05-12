import { describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, TestClock } from "effect";
import { expect } from "vitest";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/effect/pending-interaction-service.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";

describe("PendingInteractionService", () => {
	it.effect("records and lists pending permissions by session", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			const pending = yield* service.recordPermissionRequest({
				requestId: "perm-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: ["git *"], metadata: { command: "git status" } },
				always: ["git *"],
			});

			expect(pending).toMatchObject({
				requestId: "perm-1",
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: ["git *"], metadata: { command: "git status" } },
				always: ["git *"],
			});

			const forSession = yield* service.listPendingPermissions("session-1");
			const all = yield* service.listPendingPermissions();
			const otherSession = yield* service.listPendingPermissions("session-2");

			expect(forSession).toHaveLength(1);
			expect(all).toHaveLength(1);
			expect(otherSession).toHaveLength(0);
		}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect(
		"maps browser permission decisions and removes resolved entries",
		() =>
			Effect.gen(function* () {
				const service = yield* PendingInteractionServiceTag;

				yield* service.recordPermissionRequest({
					requestId: "perm-1" as PermissionId,
					sessionId: "session-1",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
				});

				const resolved = yield* service.resolvePermissionFromBrowser(
					"perm-1",
					"allow_always",
				);
				expect(Option.getOrUndefined(resolved)).toEqual({
					toolName: "Bash",
					sessionId: "session-1",
					mapped: "always",
				});

				const duplicate = yield* service.resolvePermissionFromBrowser(
					"perm-1",
					"allow",
				);
				expect(Option.isNone(duplicate)).toBe(true);
				expect(yield* service.listPendingPermissions()).toHaveLength(0);
			}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect(
		"resolves active permission waiters exactly once through the service owner",
		() =>
			Effect.gen(function* () {
				const service = yield* PendingInteractionServiceTag;

				const pending = yield* service.beginPermissionRequest({
					requestId: "perm-1" as PermissionId,
					sessionId: "session-1",
					toolName: "Bash",
					toolInput: { patterns: [], metadata: {} },
					always: [],
				});
				const waiter = yield* Effect.fork(pending.awaitResponse);

				const resolved = yield* service.resolvePermissionFromBrowser(
					"perm-1",
					"allow",
				);
				expect(Option.getOrUndefined(resolved)).toEqual({
					toolName: "Bash",
					sessionId: "session-1",
					mapped: "once",
				});
				expect(yield* Fiber.join(waiter)).toEqual({ decision: "once" });
				expect(yield* service.listPendingPermissions("session-1")).toHaveLength(
					0,
				);

				const duplicate = yield* service.resolvePermissionFromBrowser(
					"perm-1",
					"deny",
				);
				expect(Option.isNone(duplicate)).toBe(true);
			}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect("takes timed-out permissions and removes them from state", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			yield* service.recordPermissionRequest({
				requestId: "perm-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
			});

			expect(yield* service.takeTimedOutPermissions()).toEqual([]);

			yield* TestClock.adjust("1 seconds");

			expect(yield* service.takeTimedOutPermissions()).toEqual([
				{ id: "perm-1", sessionId: "session-1" },
			]);
			expect(yield* service.listPendingPermissions()).toHaveLength(0);
		}).pipe(
			Effect.provide(
				makePendingInteractionServiceLive({ permissionTimeoutMs: 1_000 }),
			),
		),
	);

	it.effect("fails active permission waiters when permissions time out", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			const pending = yield* service.beginPermissionRequest({
				requestId: "perm-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
			});
			const waiter = yield* Effect.fork(pending.awaitResponse);

			yield* TestClock.adjust("1 seconds");

			expect(yield* service.takeTimedOutPermissions()).toEqual([
				{ id: "perm-1", sessionId: "session-1" },
			]);
			yield* Effect.yieldNow();
			const waiterExit = yield* Fiber.poll(waiter);
			expect(Option.isSome(waiterExit)).toBe(true);
			if (Option.isSome(waiterExit)) {
				expect(Exit.isFailure(waiterExit.value)).toBe(true);
			}
		}).pipe(
			Effect.provide(
				makePendingInteractionServiceLive({ permissionTimeoutMs: 1_000 }),
			),
		),
	);

	it.effect("records and resolves pending questions by session", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			yield* service.recordQuestionRequest({
				requestId: "question-1",
				sessionId: "session-1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
					},
				],
				toolCallId: "toolu-1",
			});

			const forSession = yield* service.listPendingQuestions("session-1");
			const otherSession = yield* service.listPendingQuestions("session-2");

			expect(forSession).toEqual([
				expect.objectContaining({
					requestId: "question-1",
					sessionId: "session-1",
					toolCallId: "toolu-1",
					questions: [
						{
							question: "Continue?",
							header: "Confirm",
							options: [{ label: "Yes", description: "Continue" }],
							multiSelect: false,
						},
					],
				}),
			]);
			expect(otherSession).toHaveLength(0);

			expect(yield* service.markQuestionResolved("question-1")).toBe(true);
			expect(yield* service.markQuestionResolved("question-1")).toBe(false);
			expect(yield* service.listPendingQuestions("session-1")).toHaveLength(0);
		}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect("resolves active question waiters through the service owner", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			const pending = yield* service.beginQuestionRequest({
				requestId: "question-1",
				sessionId: "session-1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
					},
				],
			});
			const waiter = yield* Effect.fork(pending.awaitAnswers);

			const resolved = yield* service.resolveQuestionFromBrowser("question-1", {
				"0": "Yes",
			});
			expect(Option.getOrUndefined(resolved)).toEqual({
				sessionId: "session-1",
			});
			expect(yield* Fiber.join(waiter)).toEqual({ "0": "Yes" });
			expect(yield* service.listPendingQuestions("session-1")).toHaveLength(0);
			const duplicate = yield* service.resolveQuestionFromBrowser(
				"question-1",
				{
					"0": "No",
				},
			);
			expect(Option.isNone(duplicate)).toBe(true);
		}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect("returns the owner session when resolving question waiters", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			yield* service.recordQuestionRequest({
				requestId: "question-1",
				sessionId: "question-session",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
					},
				],
			});

			const resolved = yield* service.resolveQuestionFromBrowser("question-1", {
				"0": "Yes",
			});
			expect(Option.getOrUndefined(resolved)).toEqual({
				sessionId: "question-session",
			});
			const duplicate = yield* service.resolveQuestionFromBrowser(
				"question-1",
				{
					"0": "No",
				},
			);
			expect(Option.isNone(duplicate)).toBe(true);
		}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);

	it.effect("cancels active session interactions and clears replay state", () =>
		Effect.gen(function* () {
			const service = yield* PendingInteractionServiceTag;

			const permission = yield* service.beginPermissionRequest({
				requestId: "perm-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { patterns: [], metadata: {} },
				always: [],
			});
			const question = yield* service.beginQuestionRequest({
				requestId: "question-1",
				sessionId: "session-1",
				questions: [{ question: "Continue?" }],
			});
			const permissionWaiter = yield* Effect.fork(permission.awaitResponse);
			const questionWaiter = yield* Effect.fork(question.awaitAnswers);

			yield* service.cancelSessionInteractions("session-1", "Turn interrupted");

			const permissionExit = yield* Effect.exit(Fiber.join(permissionWaiter));
			const questionExit = yield* Effect.exit(Fiber.join(questionWaiter));

			expect(Exit.isFailure(permissionExit)).toBe(true);
			expect(Exit.isFailure(questionExit)).toBe(true);
			expect(yield* service.listPendingPermissions("session-1")).toHaveLength(
				0,
			);
			expect(yield* service.listPendingQuestions("session-1")).toHaveLength(0);
		}).pipe(Effect.provide(PendingInteractionServiceLive)),
	);
});
