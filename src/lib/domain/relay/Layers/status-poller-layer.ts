import {
	Array as Arr,
	type Cause,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	PubSub,
	Ref,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SessionScope } from "../../../contracts/session-scope.js";
import * as Failure from "../../../effect/failure-classification.js";
import type { SessionStatus } from "../../../instance/sdk-types.js";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
	makeUnboundCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import {
	canonicalEvent,
	type SessionStatusValue,
} from "../../../persistence/events.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import { RelayStatusSnapshotTag } from "../Services/relay-status-snapshot.js";
import { ConfigTag, LoggerTag, StatusPollerTag } from "../Services/services.js";
import { SessionManagerStateTag } from "../Services/session-manager-state.js";
import {
	DEFAULT_RECONCILIATION_INTERVAL_MS,
	getCurrentStatuses,
	isBusyIn,
	isProcessing,
	PollerPubSubTag,
	PollerStateTag,
	poll,
	type ReconciliationDeps,
	runReconciliation,
	type SessionStatusPollerService,
	StatusPollerCoreTag,
	strandedChildren,
} from "../Services/session-status-poller.js";

type StatusPollerChangedCallback = Parameters<
	SessionStatusPollerService["on"]
>[1];

/**
 * One status poller per daemon (82tn.16), over the sessions of the projects `projects` names: a
 * project no tab has opened since a restart is settled too, and a removed one is left alone
 * (82tn.14). It polls once before it serves, then every `interval`.
 */
export const makeStatusPollerCore = (options: {
	readonly projects: Effect.Effect<readonly string[]>;
	readonly interval: Duration.Duration;
	readonly commit: CommitAndSignal;
}) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const readQuery = yield* ReadQueryEffectTag;
		const activity = yield* SessionActivityTag;
		const polled = yield* PubSub.sliding<void>(1);
		const lock = yield* Semaphore.make(1);
		const reconciliation = (
			projectIds: SessionScope["projectIds"],
		): ReconciliationDeps => ({
			getProjectedSessions: () =>
				readQuery.getSessionsForReconciliation({ projectIds }, []),
			getStrandedChildren: () =>
				strandedChildren({ projectIds }).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				),
			liveListOf: activity.background.liveListOf,
			// The store's open prompts; an async question does not hold its session.
			getSessionsAwaitingUser: () =>
				sql<{
					session_id: string;
				}>`SELECT DISTINCT pa.session_id FROM pending_approvals pa
					JOIN sessions s ON s.id = pa.session_id
					WHERE pa.status = 'pending' AND s.project_id IN ${sql.in(projectIds)}
						AND COALESCE(json_extract(pa.details, '$.delivery'), '') <> 'async'`.pipe(
					Effect.map((rows) => new Set(rows.map((row) => row.session_id))),
				),
			injectCorrectiveEvent: (sessionId: string, status: string) =>
				options.commit([
					canonicalEvent(
						"session.status",
						sessionId,
						{
							sessionId,
							status: status as SessionStatusValue,
						},
						{
							// Conduit's own inference, not a provider report. The projector
							// keys its open-run guard on the source below, not this label.
							provider: "conduit",
							metadata: {
								synthetic: true,
								source: "reconciliation-loop",
							},
						},
					),
				]),
		});
		const poll = Effect.gen(function* () {
			const projectIds = yield* options.projects;
			if (Arr.isReadonlyArrayNonEmpty(projectIds))
				yield* runReconciliation(reconciliation(projectIds));
			yield* PubSub.publish(polled, undefined);
		}).pipe(
			lock.withPermits(1),
			Effect.catchCause((cause) =>
				Failure.isInterruptedOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(
							`Status poller poll failed: ${Failure.renderCause(cause)}`,
						),
			),
		);
		const isProcessing = (projectId: string) =>
			sql<{
				id: string;
			}>`SELECT id FROM sessions WHERE project_id = ${projectId}`.pipe(
				Effect.map((rows) =>
					rows.some(({ id }) => {
						const { foreground, background } = activity.background.activityOf(
							id,
							{ approvals: 0, questions: 0 },
						);
						return foreground === "working" || background === "work";
					}),
				),
				Effect.catch((cause) =>
					Effect.as(
						Effect.logWarning(
							`Status poller processing read failed: ${String(cause)}`,
						),
						false,
					),
				),
			);
		yield* poll;
		yield* Effect.forkScoped(
			Effect.forever(Effect.sleep(options.interval).pipe(Effect.andThen(poll))),
		);
		return { poll, polled, isProcessing };
	});

export const makeStatusPollerCoreLive = (
	projects: Effect.Effect<readonly string[]>,
	intervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS,
) =>
	Layer.effect(
		StatusPollerCoreTag,
		Effect.flatMap(makeUnboundCommitAndSignal, (commit) =>
			makeStatusPollerCore({
				projects,
				interval: Duration.millis(intervalMs),
				commit,
			}),
		),
	);

export const StatusPollerLive: Layer.Layer<
	StatusPollerTag,
	never,
	| ConfigTag
	| LoggerTag
	| PollerPubSubTag
	| PollerStateTag
	| RelayStatusSnapshotTag
	| SessionActivityTag
	| SessionManagerStateTag
	| ReadQueryEffectTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| SqlClient.SqlClient
> = Layer.effect(
	StatusPollerTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const stateRef = yield* PollerStateTag;
		const pubsub = yield* PollerPubSubTag;
		const statusSnapshot = yield* RelayStatusSnapshotTag;
		const sessionState = yield* SessionManagerStateTag;
		const readQuery = yield* ReadQueryEffectTag;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const activity = yield* SessionActivityTag;
		const interval = Duration.millis(
			config.statusPollerInterval ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
		);
		// The daemon's one poller settles stale sessions; a relay with no daemon runs its own.
		const shared = yield* Effect.serviceOption(StatusPollerCoreTag);
		const core = Option.isSome(shared)
			? shared.value
			: yield* makeStatusPollerCore({
					projects: Effect.succeed([eventStore.projectId]),
					interval,
					commit: yield* makeCommitAndSignal.pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
					),
				});
		const sessionProviders = yield* Ref.make<ReadonlyMap<string, string>>(
			new Map(),
		);
		// 8.1 (2734): a session is busy while the ledger holds its active Run; the row's status is not
		// read. An error row keeps its error, which no reader counts as busy.
		const readProjectedStatuses = (
			working: (sessionId: string) => boolean = (sessionId) =>
				activity.background.activityOf(sessionId, {
					approvals: 0,
					questions: 0,
				}).foreground === "working",
		): Effect.Effect<Record<string, SessionStatus>, unknown> =>
			Effect.gen(function* () {
				const rows = yield* readQuery.getAllSessionStatusesWithProviders({
					projectIds: [eventStore.projectId],
				});
				yield* Ref.set(
					sessionProviders,
					new Map(rows.map((row) => [row.id, row.provider])),
				);
				return Object.fromEntries(
					rows.map((row): [string, SessionStatus] => [
						row.id,
						{
							type: working(row.id)
								? "busy"
								: row.status === "error"
									? "error"
									: "idle",
						} as SessionStatus,
					]),
				);
			});
		// The view fills as the arm folds after a restart, so before the first poll the store's ledger
		// answers (3.12: only an Open session can hold a Run).
		const readStoredStatuses = Effect.gen(function* () {
			const active = new Set<string>();
			for (const { session_id } of yield* sql<{
				session_id: string;
			}>`SELECT session_id FROM run_ledger_sessions WHERE state = 'Open'`)
				if ((yield* loadLedgerView(session_id))?.active !== undefined)
					active.add(session_id);
			return yield* readProjectedStatuses((sessionId) => active.has(sessionId));
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
		const pollerState = <A, E, R>(
			effect: Effect.Effect<A, E, R | PollerStateTag>,
		) => effect.pipe(Effect.provideService(PollerStateTag, stateRef));
		const pollerPubSub = <A, E, R>(
			effect: Effect.Effect<A, E, R | PollerPubSubTag>,
		) => effect.pipe(Effect.provideService(PollerPubSubTag, pubsub));
		const pollDeps = { getRawStatuses: readProjectedStatuses };
		const subscribers = yield* Ref.make<
			ReadonlyArray<StatusPollerChangedCallback>
		>([]);
		const started = yield* Ref.make(false);
		const statusLog = log.child("status-poller");
		const reportFailure = (prefix: string, cause: Cause.Cause<unknown>) =>
			Failure.isInterruptedOnly(cause)
				? Effect.interrupt
				: Effect.sync(() =>
						statusLog.warn(`${prefix}: ${Failure.renderCause(cause)}`),
					);
		const updateStatusSnapshot = core
			.isProcessing(eventStore.projectId)
			.pipe(Effect.flatMap(statusSnapshot.setIsProcessing));
		const runPoll = poll(pollDeps).pipe(
			pollerState,
			pollerPubSub,
			Effect.andThen(updateStatusSnapshot),
			Effect.catchCause((cause) =>
				reportFailure("Status poller poll failed", cause),
			),
		);
		const forkPoll = core.poll.pipe(
			Effect.forkChild({ uninterruptible: "inherit" }),
			Effect.asVoid,
		);
		const invokeChangedCallback = (
			callback: StatusPollerChangedCallback,
			event: {
				readonly statuses: Record<string, SessionStatus>;
				readonly statusesChanged: boolean;
			},
		) =>
			Effect.try(() => callback(event.statuses, event.statusesChanged)).pipe(
				Effect.flatMap((result) =>
					result instanceof Promise
						? Effect.tryPromise({
								try: () => result,
								catch: (cause) => cause,
							})
						: Effect.void,
				),
				Effect.catch((cause) =>
					Effect.sync(() =>
						statusLog.warn(
							`Status poller changed callback failed: ${cause instanceof Error ? cause.message : String(cause)}`,
						),
					),
				),
			);
		yield* Effect.forkScoped(
			Effect.scoped(
				Effect.gen(function* () {
					const subscription = yield* PubSub.subscribe(pubsub);
					yield* Stream.runForEach(
						Stream.fromSubscription(subscription),
						(event) =>
							Effect.gen(function* () {
								const callbacks = yield* Ref.get(subscribers);
								yield* Effect.forEach(
									callbacks,
									(callback) => invokeChangedCallback(callback, event),
									{ discard: true },
								);
							}),
					);
				}),
			),
			{ uninterruptible: "inherit" },
		);
		// This project's view re-reads after each of the poller's polls.
		yield* Effect.forkScoped(
			Effect.scoped(
				Effect.gen(function* () {
					const polls = yield* PubSub.subscribe(core.polled);
					yield* Stream.runForEach(Stream.fromSubscription(polls), () =>
						Effect.gen(function* () {
							if (yield* Ref.get(started)) yield* runPoll;
						}),
					);
				}),
			),
			{ uninterruptible: "inherit" },
		);
		const service: SessionStatusPollerService = {
			// Held for the caller's scope, so a closed relay leaves no listener behind.
			on: (_event, callback) =>
				Effect.acquireRelease(
					Ref.update(subscribers, (callbacks) => [...callbacks, callback]),
					() =>
						Ref.update(subscribers, (callbacks) =>
							callbacks.filter((kept) => kept !== callback),
						),
				),
			start: () =>
				Effect.gen(function* () {
					const wasStarted = yield* Ref.get(started);
					yield* Ref.set(started, true);
					if (!wasStarted) {
						yield* runPoll;
					}
				}),
			stop: () => Ref.set(started, false),
			drain: () => Ref.set(started, false),
			getCurrentStatuses: () => pollerState(getCurrentStatuses),
			getSessionProviders: () => Ref.get(sessionProviders),
			isProcessing: (sessionId) =>
				Effect.gen(function* () {
					const sessionSnapshot = yield* Ref.get(sessionState);
					const parents = new Map(
						HashMap.toEntries(sessionSnapshot.cachedParentMap),
					);
					if ((yield* Ref.get(stateRef)).initialized) {
						return yield* pollerState(
							isProcessing(
								sessionId,
								parents,
								sessionSnapshot.cachedSideThreadIds,
							),
						);
					}
					// The poller only runs alongside OpenCode and is empty until its
					// first poll. A Claude turn that outlived a restart would read as
					// idle to every reconnecting browser, so a cold cache defers to
					// the event store.
					const statuses = yield* readStoredStatuses.pipe(
						Effect.orElseSucceed(() => ({})),
					);
					return isBusyIn(
						statuses,
						sessionId,
						parents,
						sessionSnapshot.cachedSideThreadIds,
					);
				}),
			// Pre-status rendering activity belongs to the client session view.
			markMessageActivity: () => Effect.void,
			clearMessageActivity: () => Effect.void,
			notifySSEIdle: () => forkPoll,
		};
		yield* Effect.addFinalizer(() => service.drain());
		return service;
	}),
);
