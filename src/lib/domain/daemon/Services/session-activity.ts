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
import type {
	EventDelivery,
	Interests,
} from "../../../server/event-audiences.js";
import {
	classify,
	makeSessionBackgroundLiveness,
} from "../../../session/background-liveness.js";
import { makeSessionCompactions } from "../../../session/session-compactions.js";
import { makeSessionRetries } from "../../../session/session-retries.js";
import type { SessionServer } from "../../../shared-types.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";

export interface SessionActivity {
	readonly background: ReturnType<typeof makeSessionBackgroundLiveness>;
	readonly compactions: ReturnType<typeof makeSessionCompactions>;
	readonly retries: ReturnType<typeof makeSessionRetries>;
	/**
	 * Each session's live servers as the PortWatcher last read them from the Run Ledger, the
	 * ledger's Servers (8.7); a reader's copy, never the PortWatcher's comparison basis.
	 */
	readonly servers: Map<string, readonly SessionServer[]>;
	readonly hintDismissals: Map<string, number>;
	readonly viewers: Map<string, number>;
	readonly connectionInterests: Map<EventDelivery, Interests>;
	readonly watchInterests: (delivery: EventDelivery) => () => void;
	readonly changed: (sessionId: string) => void;
	readonly subscribe: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
}

export class SessionActivityTag extends Context.Service<
	SessionActivityTag,
	SessionActivity
>()("SessionActivity") {}

/** Daemon-owned transient state; project relays only borrow its readers and writers. */
export const makeSessionActivity: Effect.Effect<SessionActivity> = Effect.gen(
	function* () {
		const changes = yield* PubSub.unbounded<string>();
		const changed = (sessionId: string): void => {
			PubSub.publishUnsafe(changes, sessionId);
		};
		const compactions = makeSessionCompactions();
		const retries = makeSessionRetries();
		const connectionInterests = new Map<EventDelivery, Interests>();
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
		const background = makeSessionBackgroundLiveness(changed);
		const servers = new Map<string, readonly SessionServer[]>();
		return {
			// A live server is live work: it pauses auto-settle and holds archive, delete and the
			// worktree sweep back (8.7 "A live server pauses auto-settle").
			background: {
				...background,
				hasLiveWork: (sessionId) =>
					background.hasLiveWork(sessionId) || servers.has(sessionId),
				backgroundOf: (sessionId) => {
					// 8.2: a task with a live linked server and no declared awaited covering it is serving.
					const found = background.backgroundOf(sessionId);
					const linked = (servers.get(sessionId) ?? []).flatMap(
						({ taskId, role }) =>
							taskId === undefined ? [] : [{ taskId, role }],
					);
					const awaited = new Set(
						linked.flatMap(({ taskId, role }) =>
							role === "awaited" ? [taskId] : [],
						),
					);
					const serving = new Set(
						linked.flatMap(({ taskId }) =>
							awaited.has(taskId) ? [] : [taskId],
						),
					);
					// 8.7 Views: an awaited server is the session's work; a serving one only makes its
					// task calm, so an idle session stays idle while it serves.
					const awaits = (servers.get(sessionId) ?? []).some(
						({ role }) => role === "awaited",
					);
					if (!found)
						return awaits ? { work: "working", tasks: [] } : undefined;
					return {
						...found,
						work: awaits ? "working" : classify(found.tasks, serving),
					};
				},
			},
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
			servers,
			hintDismissals,
			viewers: new Map(),
			connectionInterests,
			watchInterests: (delivery) => {
				const update = () => {
					const interests = delivery.interests;
					if (interests.sessions.size === 0 && interests.projects.size === 0)
						connectionInterests.delete(delivery);
					else connectionInterests.set(delivery, interests);
				};
				update();
				const release = delivery.onChange(update);
				return () => {
					release();
					connectionInterests.delete(delivery);
				};
			},
			changed,
			subscribe: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
		} satisfies SessionActivity;
	},
);

/** Wake on changes, coalescing a burst into one leading and one trailing refresh. */
export const SessionActivityDaemonLive = Layer.effect(
	SessionActivityTag,
	Effect.gen(function* () {
		const activity = yield* makeSessionActivity;
		const bus = yield* DaemonEventBusTag;
		const advances = yield* (yield* SessionEventBusTag).subscribeAdvances();
		const changes = yield* activity.subscribe;
		const pending = yield* Effect.acquireRelease(
			Queue.sliding<void>(1),
			Queue.shutdown,
		);
		yield* changes.pipe(
			Stream.runForEach(() => Queue.offer(pending, undefined)),
			Effect.forkScoped,
		);
		// Durable sidebar changes and transient activity share one daemon refresh
		// cadence. A dropped advance may have contained a sidebar change.
		yield* advances.pipe(
			Stream.filter(
				(advance) =>
					advance.dropped === true || advance.collections.includes("sidebar"),
			),
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
				yield* Queue.clear(pending);
				yield* PubSub.publish(bus, DaemonEvent.DaemonSessionsChanged());
				lastPublished = yield* Clock.currentTimeMillis;
			}
		}).pipe(Effect.forkScoped);
		return activity;
	}),
);
