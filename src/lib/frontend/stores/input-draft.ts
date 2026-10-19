// The viewed session's stored composer draft, followed by live changes.

import { Effect, FiberHandle, Scope, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { InputDraftEnvelope } from "../transport/ws-rpc.js";
import { handleInputSyncReceived } from "./chat.svelte.js";
import { isOwnBrowserClientId } from "./client-identity.js";
import { handleInputDraftStarted } from "./composer-draft/runner.svelte.js";

export const applyInputDraft = (
	envelope: InputDraftEnvelope,
	sessionId: string,
): void => {
	// The writing tab already shows its own text.
	if (envelope._tag === "synchronized" || !isOwnBrowserClientId(envelope.from))
		handleInputSyncReceived({
			sessionId,
			...envelope,
			...(envelope._tag === "synchronized" ? { initial: true } : {}),
		});
};

let viewed: { project: string; sessionId: string | null } | null = null;

async function makeFollower() {
	const runtime = await getRuntime();
	const handle = await runTransportEffect(
		FiberHandle.make<void, never>().pipe(Scope.provide(runtime.scope)),
	);
	return { runtime, handle };
}

let follower: ReturnType<typeof makeFollower> | undefined;

/** Follow one session's draft; a `null` session stops. */
export function viewInputDraft(
	project: string,
	sessionId: string | null,
): void {
	if (viewed?.project === project && viewed.sessionId === sessionId) return;
	const selection = { project, sessionId };
	viewed = selection;
	if (!sessionId && !follower) return;
	follower ??= makeFollower();
	void follower.then(({ runtime, handle }) => {
		if (viewed !== selection) return;
		runtime.runFork(
			Effect.suspend(() => {
				if (viewed !== selection) return Effect.void;
				if (!sessionId) return FiberHandle.clear(handle);
				return Effect.asVoid(
					FiberHandle.run(
						handle,
						Effect.flatMap(WsRpcClients, (clients) =>
							Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
								Stream.runForEach(
									supervise(
										Stream.suspend(() => {
											handleInputDraftStarted(sessionId);
											return subscriptions.inputDraft({ sessionId });
										}),
										() => undefined,
									),
									(envelope) =>
										Effect.sync(() => {
											if (viewed === selection)
												applyInputDraft(envelope, sessionId);
										}),
								),
							),
						),
					),
				);
			}),
		);
	});
}
