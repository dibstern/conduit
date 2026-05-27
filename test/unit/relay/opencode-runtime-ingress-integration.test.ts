// ─── OpenCode Runtime Ingress Integration Test ──────────────────────────────
// Verifies that SSE events flow through both the Effect relay pipeline and the
// Effect OpenCode runtime ingress wiring.

import { Cause, Chunk, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	type EffectSSEWiringDeps,
	handleSSEEventEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import {
	createMockSSEWiringDeps,
	makeMockSessionManagerService,
} from "../../helpers/mock-factories.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

type RuntimeIngress = NonNullable<
	EffectSSEWiringDeps["opencodeRuntimeIngress"]
>;

const ingressSuccess = {
	ok: true,
	eventsWritten: 1,
	sessionSeeded: false,
} as const;

function createRuntimeIngress(
	onSSEEventEffect: RuntimeIngress["onSSEEventEffect"] = vi.fn(() =>
		Effect.succeed(ingressSuccess),
	),
): RuntimeIngress {
	return {
		onSSEEventEffect,
		onReconnect: vi.fn(),
	};
}

function createEffectDeps(
	overrides: Partial<EffectSSEWiringDeps> = {},
): EffectSSEWiringDeps {
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
	return {
		...effectDeps,
		...overrides,
	};
}

function createServicesLayer() {
	return Layer.mergeAll(
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
	);
}

async function runSSEEvent(
	deps: EffectSSEWiringDeps,
	event: Parameters<typeof handleSSEEventEffect>[1],
) {
	await Effect.runPromise(
		handleSSEEventEffect(deps, event).pipe(
			Effect.provide(createServicesLayer()),
		),
	);
}

describe("OpenCode Runtime Ingress Integration (Effect SSE wiring)", () => {
	it("calls runtime ingress before relay translation and still routes translated messages", async () => {
		const order: string[] = [];
		const runtimeIngress = createRuntimeIngress(
			vi.fn(() =>
				Effect.sync(() => {
					order.push("ingress-effect");
					return ingressSuccess;
				}),
			),
		);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "Hello",
		};
		const deps = createEffectDeps({
			opencodeRuntimeIngress: runtimeIngress,
		});
		vi.mocked(deps.translator.translate).mockImplementation(() => {
			order.push("translator");
			return {
				ok: true,
				messages: [translated],
			};
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		await runSSEEvent(deps, event);

		expect(runtimeIngress.onSSEEventEffect).toHaveBeenCalledWith(event, "s1");
		expect(order).toEqual(["ingress-effect", "translator"]);
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"s1",
			translated,
		);
	});

	it("calls runtime ingress even when relay translation skips the event", async () => {
		const runtimeIngress = createRuntimeIngress();
		const deps = createEffectDeps({
			opencodeRuntimeIngress: runtimeIngress,
		});
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "test skip",
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		await runSSEEvent(deps, event);

		expect(runtimeIngress.onSSEEventEffect).toHaveBeenCalledWith(event, "s1");
		expect(deps.wsHandler.broadcastPerSessionEvent).not.toHaveBeenCalled();
	});

	it("calls runtime ingress on permission.asked before the relay early return", async () => {
		const runtimeIngress = createRuntimeIngress();
		const deps = createEffectDeps({
			opencodeRuntimeIngress: runtimeIngress,
		});

		const event = makeSSEEvent("permission.asked", {
			sessionID: "s1",
			id: "perm_1",
			permission: "Bash(ls)",
		});

		await runSSEEvent(deps, event);

		expect(runtimeIngress.onSSEEventEffect).toHaveBeenCalledWith(event, "s1");
		expect(deps.translator.translate).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				sessionId: "s1",
				requestId: "perm_1",
				toolName: "Bash(ls)",
			}),
		);
	});

	it("continues relay handling when runtime ingress reports an internal persistence error", async () => {
		const runtimeIngress = createRuntimeIngress(
			vi.fn(() =>
				Effect.succeed({
					ok: false,
					reason: "error",
					error: "ingress failed",
				} as const),
			),
		);
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "Hello",
		};
		const deps = createEffectDeps({
			opencodeRuntimeIngress: runtimeIngress,
		});
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		await runSSEEvent(deps, event);

		expect(runtimeIngress.onSSEEventEffect).toHaveBeenCalledWith(event, "s1");
		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"s1",
			translated,
		);
	});

	it("surfaces unexpected runtime ingress effect failures to the caller", async () => {
		const runtimeIngress = createRuntimeIngress(
			vi.fn(() => Effect.die(new Error("ingress defect"))),
		);
		const deps = createEffectDeps({
			opencodeRuntimeIngress: runtimeIngress,
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		const exit = await Effect.runPromiseExit(
			handleSSEEventEffect(deps, event).pipe(
				Effect.provide(createServicesLayer()),
			),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			const defects = Chunk.toArray(Cause.defects(exit.cause));
			expect(defects).toHaveLength(1);
			expect(defects[0]).toEqual(expect.any(Error));
			expect((defects[0] as Error).message).toBe("ingress defect");
		}
		expect(runtimeIngress.onSSEEventEffect).toHaveBeenCalledWith(event, "s1");
		expect(deps.translator.translate).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcastPerSessionEvent).not.toHaveBeenCalled();
	});

	it("continues relay handling when runtime ingress is absent", async () => {
		const translated: RelayMessage = {
			type: "delta",
			sessionId: "s1",
			text: "Hello",
		};
		const deps = createEffectDeps();
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		await runSSEEvent(deps, event);

		expect(deps.wsHandler.broadcastPerSessionEvent).toHaveBeenCalledWith(
			"s1",
			translated,
		);
	});
});
