import {
	Clock,
	Context,
	Effect,
	Layer,
	PubSub,
	Queue,
	type Scope,
	Stream,
} from "effect";
import { makeSessionBackgroundLiveness } from "../../../session/background-liveness.js";
import { makeSessionCompactions } from "../../../session/session-compactions.js";
import { makeSessionRetries } from "../../../session/session-retries.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";

export interface SessionActivity {
	readonly background: ReturnType<typeof makeSessionBackgroundLiveness>;
	readonly compactions: ReturnType<typeof makeSessionCompactions>;
	readonly retries: ReturnType<typeof makeSessionRetries>;
	readonly hintDismissals: Map<string, number>;
	readonly changed: (sessionId: string) => void;
	readonly subscribe: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
}

export class SessionActivityTag extends Context.Tag("SessionActivity")<
	SessionActivityTag,
	SessionActivity
>() {}

/** Daemon-owned transient state; project relays only borrow its readers and writers. */
export const makeSessionActivity: Effect.Effect<SessionActivity> = Effect.sync(
	() => {
		const subscribers = new Set<Queue.Queue<string>>();
		const changed = (sessionId: string): void => {
			for (const subscriber of subscribers)
				Queue.unsafeOffer(subscriber, sessionId);
		};
		const compactions = makeSessionCompactions();
		const retries = makeSessionRetries();
		// Existing hint consumers mutate a Map. Keep that interface while ensuring
		// dismissals and resets notify readers just like the other activity state.
		const hintDismissals = new (class extends Map<string, number> {
			override set(sessionId: string, generation: number): this {
				const moved = this.get(sessionId) !== generation;
				super.set(sessionId, generation);
				if (moved) changed(sessionId);
				return this;
			}

			override delete(sessionId: string): boolean {
				const moved = super.delete(sessionId);
				if (moved) changed(sessionId);
				return moved;
			}

			override clear(): void {
				const sessions = [...this.keys()];
				super.clear();
				for (const sessionId of sessions) changed(sessionId);
			}
		})();
		return {
			background: makeSessionBackgroundLiveness(changed),
			compactions: {
				...compactions,
				observe: (events) => {
					const moved = compactions.observe(events);
					for (const sessionId of moved) changed(sessionId);
					return moved;
				},
			},
			retries: {
				...retries,
				observe: (events) => {
					const moved = retries.observe(events);
					for (const sessionId of moved) changed(sessionId);
					return moved;
				},
			},
			hintDismissals,
			changed,
			subscribe: Effect.acquireRelease(
				Effect.gen(function* () {
					const subscriber = yield* Queue.unbounded<string>();
					subscribers.add(subscriber);
					return subscriber;
				}),
				(subscriber) =>
					Effect.sync(() => subscribers.delete(subscriber)).pipe(
						Effect.zipRight(Queue.shutdown(subscriber)),
					),
			).pipe(Effect.map(Stream.fromQueue)),
		} satisfies SessionActivity;
	},
);

export const SessionActivityLive = Layer.effect(
	SessionActivityTag,
	makeSessionActivity,
);

/** Wake on changes, coalescing a burst into one leading and one trailing refresh. */
export const SessionActivityDaemonLive = Layer.scoped(
	SessionActivityTag,
	Effect.gen(function* () {
		const activity = yield* makeSessionActivity;
		const bus = yield* DaemonEventBusTag;
		const changes = yield* activity.subscribe;
		const pending = yield* Effect.acquireRelease(
			Queue.sliding<void>(1),
			Queue.shutdown,
		);
		yield* changes.pipe(
			Stream.runForEach(() => Queue.offer(pending, undefined)),
			Effect.forkScoped,
		);
		yield* Effect.gen(function* () {
			let lastPublished = Number.NEGATIVE_INFINITY;
			while (true) {
				yield* Queue.take(pending);
				const now = yield* Clock.currentTimeMillis;
				const delay = lastPublished + 1000 - now;
				if (delay > 0) yield* Effect.sleep(delay);
				// Everything received during the wait is represented by this read.
				yield* Queue.takeAll(pending);
				yield* PubSub.publish(bus, DaemonEvent.DaemonSessionsChanged());
				lastPublished = yield* Clock.currentTimeMillis;
			}
		}).pipe(Effect.forkScoped);
		return activity;
	}),
);
