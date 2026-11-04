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
	TaskKey,
} from "../../../provider/run-ledger/run-ledger-model.js";
import type {
	EventDelivery,
	Interests,
} from "../../../server/event-audiences.js";
import { deriveSessionActivity } from "../../../session/session-activity-view.js";
import { makeSessionCompactions } from "../../../session/session-compactions.js";
import { makeSessionGoals } from "../../../session/session-goals.js";
import { makeSessionRetries } from "../../../session/session-retries.js";
import type {
	BackgroundTask,
	BackgroundWork,
	SessionActivityView,
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
	/** 8.3: the active Run is a wake, named by its waking task's description when known. */
	readonly wakeRun?: { readonly task?: string };
	/**
	 * 8.4: a Stop past its deadline waits on the confirm gate. Its snapshot entry and tasks come
	 * from one hand-over; no tasks means the background state is unknown.
	 */
	readonly stopConfirm?: {
		readonly snapshotEntry: number;
		readonly tasks?: readonly BackgroundTask[];
	};
};

/**
 * The arm's hand-over beyond tasks: the active Run (8.3), the session's Servers (8.7) and the
 * pending confirm (8.4).
 */
export type LedgerActivity = Pick<
	LedgerView,
	"active" | "servers" | "pendingConfirm"
>;

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
			readonly ledger: LedgerActivity | undefined;
			/**
			 * Each task's description by id, kept past its last listing: Claude's empty snapshot lands
			 * before the notification that wakes it (8.3).
			 */
			readonly named: ReadonlyMap<string, string>;
		}
	>();
	const wakeOf = (ledger: LedgerActivity | undefined) =>
		ledger?.active?.origin !== "wake"
			? undefined
			: ledger.active.wakeTask
				? { task: ledger.active.wakeTask }
				: ({} as { readonly task?: TaskKey });
	const serversOf = (ledger: LedgerActivity | undefined) => [
		...(ledger?.servers?.values() ?? []),
	];
	const taskIds = (view: LedgerView["tasks"] | undefined) =>
		view?.tag === "live" ? view.tasks.map((task) => task.key.taskId) : [];
	// Sessions whose Stop is past its deadline and waiting on the confirm gate (U2, row 213).
	const held = new Set<string>();
	return {
		/** U2 holds a Stop past its deadline until the gate answers; the release lifts the ask. */
		holdStop(sessionId: string): () => void {
			held.add(sessionId);
			changed(sessionId);
			return () => {
				if (held.delete(sessionId)) changed(sessionId);
			};
		},
		/** The arm's committed view, and for a snapshot its tasks; true when what shows moved. */
		publish(
			sessionId: string,
			view: LedgerView["tasks"],
			snapshot?: {
				readonly tasks: EventPayloadMap["evidence.tasks_snapshot"]["tasks"];
				readonly at: number;
			},
			ledger?: LedgerActivity,
		): boolean {
			const previous = views.get(sessionId);
			const listed = [
				...(view.tag === "live" ? view.tasks : []),
				...(snapshot?.tasks ?? []),
			];
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
				ledger,
				named: new Map([
					...(previous?.named ?? []),
					...listed.flatMap(({ key, description }) =>
						description ? [[key.taskId, description] as const] : [],
					),
				]),
			};
			views.set(sessionId, next);
			// A session not yet handed over shows no tasks, so a restart's first hand-over of none moves
			// nothing and announces nothing.
			const shown = (entry: typeof previous) =>
				JSON.stringify([
					entry?.view ?? { tag: "none" },
					[...(entry?.display ?? [])],
					entry?.ledger?.active?.origin,
					wakeOf(entry?.ledger),
					serversOf(entry?.ledger),
					entry?.ledger?.pendingConfirm?.snapshotEntry,
				]);
			const moved = shown(previous) !== shown(next);
			if (moved) changed(sessionId);
			return moved;
		},
		backgroundOf(sessionId: string): SessionBackground | undefined {
			const entry = views.get(sessionId);
			if (entry === undefined) return undefined;
			const wake = wakeOf(entry.ledger);
			const taskName = wake?.task && entry.named.get(wake.task.taskId);
			const wakeRun = wake && {
				wakeRun: taskName ? { task: taskName } : {},
			};
			// 8.7 Views: an awaited server is the session's work, a serving one is calm.
			const background = deriveSessionActivity({
				tasks: entry.view,
				servers: serversOf(entry.ledger),
				prompts: { approvals: 0, questions: 0 },
			}).background;
			const work: BackgroundWork | undefined =
				background === "work"
					? "working"
					: background === "unknown" || background === "none"
						? undefined
						: "monitoring";
			// A serving server alone is no task; its calm shows through the activity view.
			if (entry.view.tag === "none")
				return work === "working" || wakeRun
					? { ...(work === "working" ? { work } : {}), tasks: [], ...wakeRun }
					: undefined;
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
			// 8.4: the ask shows only while U2 holds the Stop on a pending confirm.
			const asking = held.has(sessionId)
				? entry.ledger?.pendingConfirm?.snapshotEntry
				: undefined;
			// 8.3: unknown tasks are neither work nor monitoring; the last known list only shows greyed.
			if (entry.view.tag === "unknown") {
				const stale = shown(entry.view.stale ?? []);
				const stopConfirm =
					asking === undefined
						? {}
						: { stopConfirm: { snapshotEntry: asking } };
				return stale.length > 0
					? { tasks: [], checking: true, stale, ...wakeRun, ...stopConfirm }
					: { tasks: [], checking: true, ...wakeRun, ...stopConfirm };
			}
			const tasks = shown(entry.view.tasks);
			const stopConfirm =
				asking === undefined
					? {}
					: { stopConfirm: { snapshotEntry: asking, tasks } };
			return {
				work: work ?? "monitoring",
				tasks,
				...wakeRun,
				...stopConfirm,
			};
		},
		/**
		 * 8.1 (2734): what the session is doing, read only from the ledger's hand-over, the goal
		 * tracker's phase and the row's open prompts.
		 */
		activityOf(
			sessionId: string,
			prompts: { readonly approvals: number; readonly questions: number },
			goal?: SessionActivityView["goal"],
		): SessionActivityView {
			const entry = views.get(sessionId);
			const origin = entry?.ledger?.active?.origin;
			return deriveSessionActivity({
				...(origin ? { run: { origin } } : {}),
				tasks: entry?.view ?? { tag: "none" },
				servers: serversOf(entry?.ledger).map(({ role, taskKey }) => ({
					role,
					...(taskKey ? { taskId: taskKey.taskId } : {}),
				})),
				prompts,
				...(goal ? { goal } : {}),
			});
		},
		/** 8.7: the ledger's Servers, each with the Preview Gate's link while the gate serves it. */
		serversOf(
			sessionId: string,
			gateUrls: ReadonlyMap<number, string>,
		): readonly SessionServer[] {
			return serversOf(views.get(sessionId)?.ledger).map(
				({ key, command, cwd, taskKey, source, role }) => {
					const gateUrl = gateUrls.get(key.port);
					return {
						port: key.port,
						pid: key.pid,
						startedAt: key.startedAt,
						command,
						cwd,
						...(taskKey === undefined ? {} : { taskId: taskKey.taskId }),
						source,
						role,
						...(gateUrl === undefined ? {} : { gateUrl }),
					};
				},
			);
		},
		/** Every session's live server ports, for the Preview Gate. */
		ports(): ReadonlyMap<number, string> {
			return new Map(
				[...views].flatMap(([sessionId, { ledger }]) =>
					serversOf(ledger).map(({ key }) => [key.port, sessionId] as const),
				),
			);
		},
		/** 8.3, 8.7: tasks live or unknown, or a live server, may still act. */
		hasLiveWork(sessionId: string): boolean {
			const entry = views.get(sessionId);
			return (
				(entry?.view.tag ?? "none") !== "none" ||
				serversOf(entry?.ledger).length > 0
			);
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
	/** 8.1: each session's goal tracker, whose phase rides its row. */
	readonly goals: ReturnType<typeof makeSessionGoals>;
	/**
	 * Each server port the Preview Gate serves, to its https link; the gate is its one writer, and a
	 * write re-sends the rows of the session serving that port.
	 */
	readonly gateUrls: Map<number, string>;
	/** Called for each session whose rows a gate link moved; the daemon's announce adds itself. */
	readonly onServersMoved: Set<(sessionId: string) => void>;
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
		const goals = makeSessionGoals();
		const announce =
			<A extends unknown[]>(move: (sessionId: string, ...rest: A) => boolean) =>
			(sessionId: string, ...rest: A): boolean => {
				const moved = move(sessionId, ...rest);
				if (moved) changed(sessionId);
				return moved;
			};
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
		const onServersMoved = new Set<(sessionId: string) => void>();
		const gateMoved = (port: number) => {
			const sessionId = background.ports().get(port);
			if (sessionId === undefined) return;
			changed(sessionId);
			for (const moved of onServersMoved) moved(sessionId);
		};
		const gateUrls = new (class extends Map<number, string> {
			override set(port: number, url: string): this {
				const moved = this.get(port) !== url;
				super.set(port, url);
				if (moved) gateMoved(port);
				return this;
			}

			override delete(port: number): boolean {
				const moved = super.delete(port);
				if (moved) gateMoved(port);
				return moved;
			}
		})();
		return {
			background,
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
			goals: {
				phaseOf: goals.phaseOf,
				request: announce(goals.request),
				drop: announce(goals.drop),
				sends: announce(goals.sends),
				takeResends: goals.takeResends,
				observe: (events) => {
					const moved = goals.observe(events);
					for (const sessionId of moved) changed(sessionId);
					return moved;
				},
			},
			gateUrls,
			onServersMoved,
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
