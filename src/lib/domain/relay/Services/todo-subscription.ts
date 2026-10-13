// Todo Subscription (conduit-test-ni8.10)
// The concrete SubscriptionSource for one session's todo list.
//
// Todos have no table: they are the TodoWrite tool parts the message projector
// already keeps, so the list is "what the newest completed TodoWrite said" and
// it moves at the owning message's version. One row per session, so a resume
// is a rebase — re-reading one row is cheaper than any catch-up bookkeeping.
//
// The session is an argument, never ambient: a subscriber names the session it
// shows, and advances for any other session are not routed here.
//
// Coalescing lives here. A message that holds a TodoWrite keeps advancing as
// its other parts stream, and a started-but-unfinished TodoWrite moves too;
// neither changes the list, so an upsert that would repeat what this
// subscriber already holds is dropped.

import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Ref, Stream } from "effect";
import type { SessionTodos } from "../../../contracts/ws-rpc.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { SessionEventBusTag } from "./session-event-bus.js";

export type { SessionTodos };

export const subscribeSessionTodos = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionTodos>,
	ReadQueryEffectError | SqlError,
	ReadQueryEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const held = yield* Ref.make<string | undefined>(undefined);
			return stream<SessionTodos, ReadQueryEffectError | SqlError>({
				bus,
				source: {
					name: `todos/${options.sessionId}`,
					collections: ["messages", "sessions"],
					shareReads: true,
					read: (range) => readQuery.readSessionTodos(options.sessionId, range),
					route: (advance) => ({
						moved: advance.sessionIds.includes(options.sessionId),
						removed: [],
					}),
					resume: "rebase",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			}).pipe(
				Stream.filterEffect((envelope) => {
					if (envelope._tag === "snapshot")
						return Ref.set(
							held,
							JSON.stringify(envelope.rows[0]?.items ?? []),
						).pipe(Effect.as(true));
					if (envelope._tag !== "upsert") return Effect.succeed(true);
					const next = JSON.stringify(envelope.item.items);
					return Ref.getAndSet(held, next).pipe(
						Effect.map((previous) => previous !== next),
					);
				}),
			);
		}),
	);
