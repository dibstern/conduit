import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	setPermissionMode,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	type EffectSSEWiringDeps,
	handleSSEEventEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

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
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag, {
			getSessionParentMap: () => Effect.succeed(new Map()),
		} as never),
	);

const makeEffectDeps = (
	replyPermission?: (
		sessionId: string,
		permissionId: string,
		response: "once",
	) => Promise<void>,
) => {
	const deps = createMockSSEWiringDeps();
	const {
		processingTimeouts: _processingTimeouts,
		pendingInteractions: _pendingInteractions,
		sessionService: _sessionService,
		getSessionParentMap: _getSessionParentMap,
		getSessionStatuses: _getSessionStatuses,
		statusPoller: _statusPoller,
		...baseEffectDeps
	} = deps;
	const effectDeps = {
		...baseEffectDeps,
		...(replyPermission ? { replyPermission } : {}),
	};
	effectDeps satisfies EffectSSEWiringDeps;
	return { deps, effectDeps };
};

describe("handleSSEEventEffect", () => {
	it("clears processing timeout through Effect state for done messages", async () => {
		const deps = createMockSSEWiringDeps();
		const {
			processingTimeouts: _processingTimeouts,
			pendingInteractions: _pendingInteractions,
			sessionService: _sessionService,
			getSessionParentMap: _getSessionParentMap,
			getSessionStatuses: _getSessionStatuses,
			statusPoller: _statusPoller,
			...effectDeps
		} = deps;
		effectDeps satisfies EffectSSEWiringDeps;
		const translated: RelayMessage = {
			type: "done",
			sessionId: "session-1",
			code: 0,
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
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag, {
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
				),
			),
		);

		expect(
			deps.processingTimeouts.clearProcessingTimeout,
		).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"session-1",
			translated,
		);
	});

	it("records message activity through SessionManagerServiceTag", async () => {
		const deps = createMockSSEWiringDeps();
		const {
			processingTimeouts: _processingTimeouts,
			pendingInteractions: _pendingInteractions,
			sessionService: _sessionService,
			getSessionParentMap: _getSessionParentMap,
			getSessionStatuses: _getSessionStatuses,
			statusPoller: _statusPoller,
			...effectDeps
		} = deps;
		effectDeps satisfies EffectSSEWiringDeps;
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
						PendingInteractionServiceLive,
						makeOverridesStateLive(),
						Layer.succeed(SessionManagerServiceTag, {
							recordMessageActivity,
							getSessionParentMap: () => Effect.succeed(new Map()),
						} as never),
					),
				),
			),
		);

		expect(recordMessageActivity).toHaveBeenCalledWith(
			"session-1",
			expect.any(Number),
		);
		expect(deps.sessionService.recordMessageActivity).not.toHaveBeenCalled();
	});

	it("auto mode replies once without broadcasting or recording a pending permission", async () => {
		const replyPermission = vi.fn(async () => {});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "auto");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toEqual([]);
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(replyPermission).toHaveBeenCalledWith("session-1", "perm-1", "once");
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_request" }),
		);
	});

	it("acceptEdits mode auto-replies to edit permissions", async () => {
		const replyPermission = vi.fn(async () => {});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "acceptEdits");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent("edit"));
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(replyPermission).toHaveBeenCalledWith("session-1", "perm-1", "once");
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_request" }),
		);
	});

	it("acceptEdits mode falls back to a card for bash permissions", async () => {
		const replyPermission = vi.fn(async () => {});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "acceptEdits");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent("bash"));
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(replyPermission).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				toolName: "bash",
			}),
		);
	});

	it("defaults to ask mode and preserves the card path", async () => {
		const replyPermission = vi.fn(async () => {});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(replyPermission).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_request" }),
		);
	});

	it("falls back to a card when the auto-reply rejects", async () => {
		const replyPermission = vi.fn(async () => {
			throw new Error("reply failed");
		});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "auto");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_request" }),
		);
	});

	it("falls back to a card when replyPermission is absent", async () => {
		const { deps, effectDeps } = makeEffectDeps();

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setPermissionMode("session-1", "auto");
				yield* handleSSEEventEffect(effectDeps, permissionAskedEvent());
				const pendingInteractions = yield* PendingInteractionServiceTag;
				expect(
					yield* pendingInteractions.listPendingPermissions("session-1"),
				).toHaveLength(1);
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "permission_request" }),
		);
	});

	it("falls back to a card when the permission has no resolvable session", async () => {
		const replyPermission = vi.fn(async () => {});
		const { deps, effectDeps } = makeEffectDeps(replyPermission);

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
			}).pipe(Effect.provide(makeEffectLayer())),
		);

		expect(replyPermission).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				sessionId: "",
			}),
		);
	});
});
