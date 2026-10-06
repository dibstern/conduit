// The viewed session's composer draft as other tabs type it, fed by its
// SubscribeInputDraft stream. The draft at session switch rides the
// ViewSession response; this carries only what changes after.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { InputDraftEnvelope } from "../transport/ws-rpc.js";
import { handleInputSyncReceived } from "./chat.svelte.js";
import { isOwnBrowserClientId } from "./client-identity.js";

export const applyInputDraft = (envelope: InputDraftEnvelope): void => {
	// The writing tab already shows its own text.
	if (envelope._tag === "draft" && !isOwnBrowserClientId(envelope.from))
		handleInputSyncReceived(envelope);
};

let viewed: { project: string; sessionId: string | null } | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/** Follow one session's draft; a `null` session stops. */
export function viewInputDraft(
	project: string,
	sessionId: string | null,
): void {
	if (viewed?.project === project && viewed.sessionId === sessionId) return;
	viewed = { project, sessionId };
	const currentGeneration = ++generation;
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || !sessionId) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.inputDraft({ sessionId })),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration === generation)
										applyInputDraft(envelope);
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}
