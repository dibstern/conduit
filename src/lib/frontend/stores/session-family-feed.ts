// The viewed session's family feed (ni8.28): one SubscribeSessionFamily
// subscription per tab, keyed by project and family, feeding the session
// store's family list through `applyFamilyChange`, its only writer.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import {
	applyFamilyChange,
	resetSessionFamily,
	sessionState,
} from "./session.svelte.js";

let viewed: { project: string; sessionId: string } | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/**
 * Follow the family of `sessionId` in `project`, an explicit argument rather
 * than the ambient selection. Moving between members of the family already
 * held keeps the subscription; another family or project resubscribes, and
 * the old feed's envelopes are dropped by generation, so a late one from the
 * previous project cannot land in this one. `null` stops following.
 */
export function viewFamily(project: string, sessionId: string | null): void {
	if (
		viewed !== null &&
		sessionId !== null &&
		viewed.project === project &&
		(viewed.sessionId === sessionId ||
			sessionState.familySessions.some((row) => row.id === sessionId))
	) {
		viewed = { project, sessionId };
		return;
	}
	const previousProject = viewed?.project;
	viewed = sessionId === null ? null : { project, sessionId };
	const currentGeneration = ++generation;
	if (sessionId === null || previousProject !== project) resetSessionFamily();
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || sessionId === null) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			// A new family's snapshot can carry the same read-model version the
			// last family's floor holds, so it starts from empty, not on top.
			let fresh = true;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.family({ sessionId })),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration !== generation) return;
									if (fresh) resetSessionFamily();
									fresh = false;
									applyFamilyChange(envelope);
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}
