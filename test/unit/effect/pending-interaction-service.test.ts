import { describe, it } from "@effect/vitest";
import { Effect, Option, TestClock } from "effect";
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
});
