import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	setPermissionMode,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	handleSSEEventEffect,
	type SSEWiringDeps,
} from "../../../src/lib/relay/sse-wiring.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const permissionAskedEvent = (
	permission = "edit",
	sessionID = "session-1",
): OpenCodeEvent => ({
	type: "permission.asked",
	properties: {
		id: "perm-1",
		sessionID,
		permission,
		patterns: [],
		metadata: {},
	},
});

const makeEffectLayer = () =>
	Layer.mergeAll(
		AlertsLive,
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag)({
			getSessionParentMap: () => Effect.succeed(new Map()),
		} as never),
	);

const makeEffectDeps = (
	replyPermission?: (
		sessionId: string,
		permissionId: string,
		response: "once",
	) => Effect.Effect<void, unknown>,
) => {
	const deps = createMockSSEWiringDeps();
	const effectDeps = {
		...deps,
		...(replyPermission ? { replyPermission } : {}),
	};
	effectDeps satisfies SSEWiringDeps;
	return { deps, effectDeps };
};

describe("handleSSEEventEffect", () => {
	it("queues automatic approval with a stable command and the asking process", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);
		const dispatchEffect = vi.fn(() => Effect.void);
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "full");
				for (let attempt = 0; attempt < 2; attempt++) {
					yield* handleSSEEventEffect(effectDeps, permissionAskedEvent(), {
						providerProcessId: "opencode:original",
					});
				}
			}).pipe(
				Effect.provideService(
					OrchestrationEngineTag,
					withDispatchEffect({ dispatchEffect }),
				),
				Effect.provide(makeEffectLayer(), { local: true }),
			),
		);
		expect(dispatchEffect).toHaveBeenCalledTimes(2);
		expect(dispatchEffect).toHaveBeenNthCalledWith(1, {
			type: "resolve_permission",
			commandId: "auto-approve:opencode:original:session-1:perm-1",
			sessionId: "session-1",
			requestId: "perm-1",
			nativeRequestId: "perm-1",
			providerProcessId: "opencode:original",
			decision: "once",
		});
		expect(dispatchEffect.mock.calls[1]).toEqual(dispatchEffect.mock.calls[0]);
		expect(replyPermission).not.toHaveBeenCalled();
	});
	it("clears processing timeout through Effect state for done messages", async () => {
		const deps = createMockSSEWiringDeps();
		const effectDeps = deps;
		effectDeps satisfies SSEWiringDeps;
		const translated: RelayMessage = {
			type: "done",
			sessionId: "session-1",
			code: 0,
			alertId: "done-1",
		};
		vi.mocked(effectDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "session-1" },
		};

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"1 minute",
					() => Effect.void,
				);
				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);

				yield* handleSSEEventEffect(effectDeps, event);

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						AlertsLive,
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag)({
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
					{ local: true },
				),
			),
		);
	});

	it("records message activity through SessionManagerServiceTag", async () => {
		const deps = createMockSSEWiringDeps();
		const effectDeps = deps;
		effectDeps satisfies SSEWiringDeps;
		const recordMessageActivity = vi.fn(() => Effect.void);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "session-1",
			text: "hello",
		};
		vi.mocked(effectDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "session-1" },
		};

		await Effect.runPromise(
			handleSSEEventEffect(effectDeps, event).pipe(
				Effect.provide(
					Layer.mergeAll(
						AlertsLive,
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag)({
							recordMessageActivity,
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
					{ local: true },
				),
			),
		);

		expect(recordMessageActivity).toHaveBeenCalledWith(
			"session-1",
			expect.any(Number),
		);
	});

	it("full mode replies once without recording a pending permission", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "full");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toEqual([]);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).toHaveBeenCalledWith("session-1", "perm-1", "once");
	});

	it("acceptEdits mode auto-replies to edit permissions", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "acceptEdits");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent("edit"));
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).toHaveBeenCalledWith("session-1", "perm-1", "once");
	});

	it("acceptEdits mode falls back to a card for bash permissions", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "acceptEdits");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent("bash"));
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).not.toHaveBeenCalled();
	});

	it("auto mode falls back to a card for OpenCode permissions", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "auto");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).not.toHaveBeenCalled();
	});

	it("defaults to ask mode and preserves the card path", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).not.toHaveBeenCalled();
	});

	it("falls back to a card when the auto-reply rejects", async () => {
		const replyPermission = vi.fn(() => Effect.fail(new Error("reply failed")));
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "full");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);
	});

	it("falls back to a card when replyPermission is absent", async () => {
		const { effectDeps } = makeEffectDeps();

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "full");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);
	});

	it("falls back to a card when the permission has no resolvable session", async () => {
		const replyPermission = vi.fn(() => Effect.void);
		const { effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* handleSSEEventEffect(
					effectDeps,
					permissionAskedEvent("edit", ""),
				);
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions(""),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer(), { local: true })),
		);

		expect(replyPermission).not.toHaveBeenCalled();
	});
});
