import { SqlClient } from "@effect/sql";
import { Cause, Duration, Effect, HashMap, Layer, PubSub, Ref } from "effect";
import type { SessionStatus } from "../../../instance/sdk-types.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type SessionStatusValue,
} from "../../../persistence/events.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { RelayStatusSnapshotTag } from "../Services/relay-status-snapshot.js";
import { ConfigTag, LoggerTag, StatusPollerTag } from "../Services/services.js";
import { SessionManagerStateTag } from "../Services/session-manager-state.js";
import {
	clearMessageActivity,
	DEFAULT_RECONCILIATION_INTERVAL_MS,
	getCurrentStatuses,
	isProcessing,
	markMessageActivity,
	notifySSEIdle,
	PollerPubSubTag,
	PollerStateTag,
	poll,
	type ReconciliationDeps,
	reconcileNow,
	type SessionStatusPollerService,
} from "../Services/session-status-poller.js";

type StatusPollerChangedCallback = Parameters<
	SessionStatusPollerService["on"]
>[1];

const toStatusRecord = (
	raw: Readonly<Record<string, string>>,
): Record<string, SessionStatus> => {
	const result: Record<string, SessionStatus> = {};
	for (const [id, status] of Object.entries(raw)) {
		result[id] = { type: status } as SessionStatus;
	}
	return result;
};

export const StatusPollerLive: Layer.Layer<
	StatusPollerTag,
	never,
	| ConfigTag
	| LoggerTag
	| OpenCodeAPITag
	| PollerPubSubTag
	| PollerStateTag
	| RelayStatusSnapshotTag
	| SessionManagerStateTag
> = Layer.scoped(
	StatusPollerTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const stateRef = yield* PollerStateTag;
		const pubsub = yield* PollerPubSubTag;
		const statusSnapshot = yield* RelayStatusSnapshotTag;
		const sessionManagerStateRef = yield* SessionManagerStateTag;
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const persistenceReady =
			config.persistenceDbPath != null && readQueryOption._tag === "Some";
		const reconciliationDeps: ReconciliationDeps | undefined =
			persistenceReady &&
			eventStoreOption._tag === "Some" &&
			projectionRunnerOption._tag === "Some" &&
			sqlOption._tag === "Some"
				? {
						getRestStatuses: () =>
							Effect.tryPromise(() => api.session.statuses()),
						getProjectedSessions: () => readQueryOption.value.listSessions(),
						injectCorrectiveEvent: (sessionId: string, status: string) =>
							Effect.gen(function* () {
								const event = canonicalEvent(
									"session.status",
									sessionId,
									{
										sessionId,
										status: status as SessionStatusValue,
									},
									{
										metadata: {
											synthetic: true,
											source: "reconciliation-loop",
										},
									},
								);
								const stored = yield* eventStoreOption.value
									.append(event)
									.pipe(
										Effect.provideService(SqlClient.SqlClient, sqlOption.value),
									);
								yield* projectionRunnerOption.value
									.projectEvent(stored)
									.pipe(
										Effect.provideService(SqlClient.SqlClient, sqlOption.value),
									);
							}),
					}
				: undefined;
		const readProjectedStatuses = () =>
			persistenceReady
				? readQueryOption.value
						.getAllSessionStatuses()
						.pipe(Effect.map(toStatusRecord))
				: Effect.tryPromise(() => api.session.statuses());
		const pollerState = <A, E>(effect: Effect.Effect<A, E, PollerStateTag>) =>
			effect.pipe(Effect.provideService(PollerStateTag, stateRef));
		const pollerPubSub = <A, E>(effect: Effect.Effect<A, E, PollerPubSubTag>) =>
			effect.pipe(Effect.provideService(PollerPubSubTag, pubsub));
		const pollDeps = {
			getRawStatuses: readProjectedStatuses,
			getSessionParentMap: () =>
				Effect.gen(function* () {
					const state = yield* Ref.get(sessionManagerStateRef);
					return new Map(HashMap.toEntries(state.cachedParentMap));
				}),
			resolveParent: (sessionId: string) =>
				Effect.tryPromise(async () => {
					const session = await api.session.get(sessionId);
					return session.parentID;
				}).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
			...(reconciliationDeps ? { reconciliation: reconciliationDeps } : {}),
		};
		const interval = Duration.millis(
			config.statusPollerInterval ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
		);
		const subscribers = yield* Ref.make<
			ReadonlyArray<StatusPollerChangedCallback>
		>([]);
		const started = yield* Ref.make(false);
		const statusLog = log.child("status-poller");
		const reportFailure = (prefix: string, cause: Cause.Cause<unknown>) =>
			Cause.isInterruptedOnly(cause)
				? Effect.interrupt
				: Effect.sync(() =>
						statusLog.warn(`${prefix}: ${Cause.pretty(cause)}`),
					);
		const updateStatusSnapshot = Effect.gen(function* () {
			const statuses = yield* pollerState(getCurrentStatuses);
			yield* statusSnapshot.setIsProcessing(
				Object.values(statuses).some(
					(status) => status.type === "busy" || status.type === "retry",
				),
			);
		});
		const runPoll = poll(pollDeps).pipe(
			pollerState,
			pollerPubSub,
			Effect.zipRight(updateStatusSnapshot),
			Effect.catchAllCause((cause) =>
				reportFailure("Status poller poll failed", cause),
			),
		);
		const forkPoll = runPoll.pipe(Effect.fork, Effect.asVoid);
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
				Effect.catchAll((cause) =>
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
					yield* Effect.forever(
						Effect.gen(function* () {
							const event = yield* subscription.take;
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
		);
		yield* Effect.forkScoped(
			Effect.forever(
				Effect.sleep(interval).pipe(
					Effect.zipRight(
						Effect.gen(function* () {
							if (yield* Ref.get(started)) {
								yield* runPoll;
							}
						}),
					),
				),
			),
		);
		const service: SessionStatusPollerService = {
			on: (_event, callback) =>
				Ref.update(subscribers, (callbacks) => [...callbacks, callback]),
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
			isProcessing: (sessionId) => pollerState(isProcessing(sessionId)),
			markMessageActivity: (sessionId) =>
				pollerState(markMessageActivity(sessionId)).pipe(
					Effect.zipRight(forkPoll),
				),
			clearMessageActivity: (sessionId) =>
				pollerState(clearMessageActivity(sessionId)),
			notifySSEIdle: (sessionId) =>
				pollerState(notifySSEIdle(sessionId)).pipe(Effect.zipRight(forkPoll)),
			reconcileNow: () =>
				reconciliationDeps != null
					? reconcileNow(reconciliationDeps)
					: Effect.void,
		};
		yield* Effect.addFinalizer(() => service.drain());
		return service;
	}),
);
