// The viewed session's family feed (ni8.28): one SubscribeSessionFamily
// subscription per tab, keyed by project and viewed session, feeding the session
// store's family list through `applyFamilyChange`, its only writer.

import { Effect, Fiber, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import { applyFamilyChange, resetSessionFamily } from "./session.svelte.js";
import { sessionDetailRequested } from "./transcript.svelte.js";
import { accountSnapshotChangedListeners } from "./ws-listeners.js";

let viewed: { project: string; sessionId: string } | null = null;
let generation = 0;
let fiber: Fiber.Fiber<void, never> | null = null;
accountSnapshotChangedListeners.add(() => {
	if (viewed !== null) viewFamily(viewed.project, viewed.sessionId, true);
});

/**
 * Follow the family of `sessionId` in `project`, an explicit argument rather
 * than the ambient selection. Each viewed member needs its own bounded base,
 * so changing the session or project resubscribes. The old feed's envelopes
 * are dropped by generation. `null` stops following.
 */
export function viewFamily(
	project: string,
	sessionId: string | null,
	refresh = false,
): void {
	if (
		!refresh &&
		viewed !== null &&
		sessionId !== null &&
		viewed.project === project &&
		viewed.sessionId === sessionId
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
			const detailRequested = sessionDetailRequested(project, sessionId);
			if (detailRequested) await detailRequested;
			if (currentGeneration !== generation) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			// A new view's snapshot can carry the same read-model version as the
			// previous view's floor, so it starts from empty.
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
