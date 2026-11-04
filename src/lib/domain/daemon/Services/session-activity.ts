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
import type { EventPayloadMap } from "../../../contracts/stored-event.js";
import type {
	LedgerView,
	Task,
} from "../../../provider/run-ledger/run-ledger-model.js";
import type {
	EventDelivery,
	Interests,
} from "../../../server/event-audiences.js";
import { makeSessionCompactions } from "../../../session/session-compactions.js";
import { makeSessionRetries } from "../../../session/session-retries.js";
import type {
	BackgroundTask,
	BackgroundWork,
	SessionServer,
} from "../../../shared-types.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";

export type SessionBackground = {
	/** Absent while checking: unknown tasks are neither work nor monitoring. */
	readonly work?: BackgroundWork;
	readonly tasks: readonly BackgroundTask[];
	/** 8.3: a reattached runner's tasks, unknown until its catch-up snapshot. */
	readonly checking?: true;
	/** While checking, the last known list, shown greyed: never live, never work. */
	readonly stale?: readonly BackgroundTask[];
};

type TaskDisplay = Pick<
	BackgroundTask,
	"detail" | "childSessionId" | "parentTaskId" | "ancestorTaskIds"
> & { readonly firstSeenAt?: number | undefined };

/**
 * 8.1: each session's background tasks as the Run Ledger's arm last committed its tasks view, with
 * the display its latest snapshot carried. A reader's copy: the ledger decides, this only shows.
 */
function makeLedgerTasks(changed: (sessionId: string) => void) {
	const views = new Map<
		string,
		{
			readonly view: LedgerView["tasks"];
			readonly display: ReadonlyMap<string, TaskDisplay>;
			readonly since: number;
		}
	>();
	const taskIds = (view: LedgerView["tasks"] | undefined) =>
		view?.tag === "live" ? view.tasks.map((task) => task.key.taskId) : [];
	return {
		/** The arm's committed view, and for a snapshot its tasks; true when what shows moved. */
		publish(
			sessionId: string,
			view: LedgerView["tasks"],
			snapshot?: {
				readonly tasks: EventPayloadMap["evidence.tasks_snapshot"]["tasks"];
				readonly at: number;
			},
		): boolean {
			const previous = views.get(sessionId);
			const display = snapshot
				? new Map(
						snapshot.tasks.map(
							({
								key,
								taskType,
								subagentType,
								description,
								ambient,
								...display
							}) => [
								key.taskId,
								{ ...display, firstSeenAt: display.firstSeenAt ?? snapshot.at },
							],
						),
					)
				: (previous?.display ?? new Map<string, TaskDisplay>());
			const next = {
				view,
				display,
				since:
					previous &&
					taskIds(previous.view).join("\u0000") === taskIds(view).join("\u0000")
						? previous.since
						: (snapshot?.at ?? Date.now()),
			};
			views.set(sessionId, next);
			const moved =
				JSON.stringify([previous?.view, [...(previous?.display ?? [])]]) !==
				JSON.stringify([view, [...display]]);
			if (moved) changed(sessionId);
			return moved;
		},
		/** `serving`: task ids whose linked server makes them calm (8.2). */
		backgroundOf(
			sessionId: string,
			serving: ReadonlySet<string> = new Set(),
		): SessionBackground | undefined {
			const entry = views.get(sessionId);
			if (entry === undefined || entry.view.tag === "none") return undefined;
			const shown = (tasks: readonly Task[]): BackgroundTask[] =>
				tasks
					.map((task) => {
						const display = entry.display.get(task.key.taskId);
						return {
							...display,
							id: task.key.taskId,
							type: task.taskType,
							kind: task.kind,
							description: task.description,
							firstSeenAt: display?.firstSeenAt ?? entry.since,
						};
					})
					.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
			// 8.3: unknown tasks are neither work nor monitoring; the last known list only shows greyed.
			if (entry.view.tag === "unknown") {
				const stale = shown(entry.view.stale ?? []);
				return stale.length > 0
					? { tasks: [], checking: true, stale }
					: { tasks: [], checking: true };
			}
			const tasks = shown(entry.view.tasks);
			// 8.2 (CONTRACT.md 2778-2781): the ledger's class decides; only work tasks
			// not serving a server make the session work.
			const working = entry.view.tasks.some(
				(task) => task.class === "work" && !serving.has(task.key.taskId),
			);
			return { work: working ? "working" : "monitoring", tasks };
		},
		/** 8.3: tasks live or unknown may still act. */
		hasLiveWork(sessionId: string): boolean {
			return (views.get(sessionId)?.view.tag ?? "none") !== "none";
		},
		/** The live task ids and since when that set has held; undefined while unknown or unread. */
		liveListOf(
			sessionId: string,
		):
			| { readonly taskIds: ReadonlySet<string>; readonly since: number }
			| undefined {
			const entry = views.get(sessionId);
			if (entry === undefined || entry.view.tag === "unknown") return undefined;
			return { taskIds: new Set(taskIds(entry.view)), since: entry.since };
		},
	};
}

export interface SessionActivity {
	readonly background: ReturnType<typeof makeLedgerTasks>;
	readonly compactions: ReturnType<typeof makeSessionCompactions>;
	readonly retries: ReturnType<typeof makeSessionRetries>;
	/**
	 * Each session's live servers as the PortWatcher last read them from the Run Ledger, the
	 * ledger's Servers (8.7); a reader's copy, never the PortWatcher's comparison basis.
	 */
	readonly servers: Map<string, readonly SessionServer[]>;
	/**
	 * Each server port the Preview Gate serves, to its https link; the gate is its one writer, and
	 * the PortWatcher's publish copies it onto `servers`.
	 */
	readonly gateUrls: Map<number, string>;
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
		const background = makeLedgerTasks(changed);
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
					const found = background.backgroundOf(sessionId, serving);
					if (!found)
						return awaits ? { work: "working", tasks: [] } : undefined;
					if (awaits) return { ...found, work: "working" };
					return found;
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
			gateUrls: new Map(),
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
