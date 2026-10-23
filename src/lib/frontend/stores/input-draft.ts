// The viewed session's stored composer draft, followed by live changes.

import { Effect, FiberHandle, Option, Scope, Stream } from "effect";
import type { InputDraftKey } from "../../contracts/ws-rpc.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { InputDraftEnvelope } from "../transport/ws-rpc.js";
import { handleInputSyncReceived } from "./chat.svelte.js";
import { isOwnBrowserClientId } from "./client-identity.js";
import {
	handleDraftPromoted,
	handleDraftRetired,
	handleInputDraftStarted,
} from "./composer-draft/runner.svelte.js";
import { draftKeyId } from "./composer-draft/state.js";

export const applyInputDraft = (
	envelope: InputDraftEnvelope,
	key: InputDraftKey,
): void => {
	if (envelope._tag === "promoted") {
		handleDraftPromoted(key, envelope.sessionId, envelope.text);
		return;
	}
	if (envelope._tag === "synchronized" && envelope.promotedSessionId) {
		handleDraftRetired(key, envelope.promotedSessionId);
		return;
	}
	// Own text already appears locally; attachment echoes still acknowledge saves.
	handleInputSyncReceived({
		key,
		...envelope,
		...(envelope._tag !== "synchronized" && isOwnBrowserClientId(envelope.from)
			? { text: undefined }
			: {}),
		...(envelope._tag === "synchronized" ? { initial: true } : {}),
	});
};

let viewed: { project: string; key: InputDraftKey | null } | null = null;

async function makeFollower() {
	const runtime = await getRuntime();
	const handle = await runTransportEffect(
		FiberHandle.make<void, never>().pipe(Scope.provide(runtime.scope)),
	);
	return { runtime, handle };
}

let follower: ReturnType<typeof makeFollower> | undefined;

/** Reconcile a refused selection without replacing the user's composer text. */
export async function refreshInputDraftAttachments(
	project: string,
	key: InputDraftKey,
): Promise<void> {
	const envelope = await runTransportEffect(
		Effect.gen(function* () {
			const clients = yield* WsRpcClients;
			const { subscriptions } = yield* clients.forProject(project);
			return yield* subscriptions
				.inputDraft({ key })
				.pipe(Stream.runHead, Effect.timeout("10 seconds"));
		}),
	);
	if (Option.isSome(envelope) && envelope.value._tag !== "promoted")
		handleInputSyncReceived({ key, attachments: envelope.value.attachments });
}

/** Follow one session's draft; a `null` session stops. */
export function viewInputDraft(
	project: string,
	key: InputDraftKey | null,
): void {
	if (
		viewed !== null &&
		(viewed.key ? draftKeyId(viewed.key) : null) ===
			(key ? draftKeyId(key) : null)
	)
		return;
	const selection = { project, key };
	viewed = selection;
	if (!key && !follower) return;
	follower ??= makeFollower();
	void follower.then(({ runtime, handle }) => {
		if (viewed !== selection) return;
		runtime.runFork(
			Effect.suspend(() => {
				if (viewed !== selection) return Effect.void;
				if (!key) return FiberHandle.clear(handle);
				return Effect.asVoid(
					FiberHandle.run(
						handle,
						Effect.flatMap(WsRpcClients, (clients) =>
							Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
								Stream.runForEach(
									supervise(
										Stream.suspend(() => {
											handleInputDraftStarted(key);
											return subscriptions.inputDraft({ key });
										}),
										() => undefined,
									),
									(envelope) =>
										Effect.sync(() => {
											if (viewed === selection || envelope._tag === "promoted")
												applyInputDraft(envelope, key);
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
