// Session Input Draft Subscription (conduit-test-ni8.15)
// The composer draft one tab is typing, for the other tabs open on that
// session. The latest draft per session also lives in the prompt handler's
// map, which the ViewSession response reads at session switch.
//
// Live-only: no opening draft, so resubscribing after a reconnect never
// clobbers text typed while offline.

import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { InputDraftEnvelope } from "../../../contracts/ws-rpc.js";

interface InputDraftChange {
	readonly sessionId: string;
	readonly text: string;
	readonly from?: string;
}

export class InputDraftsTag extends Context.Tag("InputDrafts")<
	InputDraftsTag,
	PubSub.PubSub<InputDraftChange>
>() {}

export const InputDraftsLive: Layer.Layer<InputDraftsTag> = Layer.effect(
	InputDraftsTag,
	PubSub.unbounded<InputDraftChange>(),
);

export const publishInputDraft = (change: InputDraftChange) =>
	Effect.flatMap(InputDraftsTag, (drafts) => PubSub.publish(drafts, change));

export const subscribeInputDraft = (
	sessionId: string,
): Stream.Stream<InputDraftEnvelope, never, InputDraftsTag> =>
	Stream.unwrapScoped(
		Effect.map(Effect.flatMap(InputDraftsTag, PubSub.subscribe), (dequeue) =>
			Stream.concat(
				Stream.make<InputDraftEnvelope[]>({ _tag: "synchronized" }),
				Stream.fromQueue(dequeue).pipe(
					Stream.filter((change) => change.sessionId === sessionId),
					Stream.map(({ text, from }) => ({
						_tag: "draft" as const,
						text,
						...(from !== undefined ? { from } : {}),
					})),
				),
			),
		),
	);
