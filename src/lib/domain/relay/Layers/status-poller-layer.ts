import { Effect, HashMap, Layer, Ref, Runtime } from "effect";
import type { SessionStatus } from "../../../instance/sdk-types.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type SessionStatusValue,
} from "../../../persistence/events.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { ConfigTag, LoggerTag, StatusPollerTag } from "../Services/services.js";
import { SessionManagerStateTag } from "../Services/session-manager-state.js";
import {
	createStatusPollerService,
	type PollerPubSubTag,
	type PollerStateTag,
	type SessionStatusPollerService,
	type StatusPollerRuntime,
} from "../Services/session-status-poller.js";

type StatusPollerRuntimeContext =
	| PollerPubSubTag
	| PollerStateTag
	| SessionManagerStateTag;

const toStatusRecord = (
	raw: Readonly<Record<string, string>>,
): Record<string, SessionStatus> => {
	const result: Record<string, SessionStatus> = {};
	for (const [id, status] of Object.entries(raw)) {
		result[id] = { type: status } as SessionStatus;
	}
	return result;
};

const getSessionParentMapFromState = Effect.gen(function* () {
	const ref = yield* SessionManagerStateTag;
	const state = yield* Ref.get(ref);
	return new Map(HashMap.toEntries(state.cachedParentMap));
});

export const StatusPollerLive: Layer.Layer<
	StatusPollerTag,
	never,
	| ConfigTag
	| LoggerTag
	| OpenCodeAPITag
	| PollerPubSubTag
	| PollerStateTag
	| SessionManagerStateTag
> = Layer.scoped(
	StatusPollerTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const runtime = yield* Effect.runtime<StatusPollerRuntimeContext>();
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const runtimeBridge: StatusPollerRuntime = {
			runSync: (effect) => Runtime.runSync(runtime)(effect),
			runPromise: (effect) => Runtime.runPromise(runtime)(effect),
		};
		const persistenceReady =
			config.persistenceDbPath != null && readQueryOption._tag === "Some";
		const reconciliationDeps =
			persistenceReady &&
			eventStoreOption._tag === "Some" &&
			projectionRunnerOption._tag === "Some"
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
								const stored = yield* eventStoreOption.value.append(event);
								yield* projectionRunnerOption.value.projectEvent(stored);
							}),
					}
				: undefined;
		const readProjectedStatuses = () =>
			persistenceReady
				? readQueryOption.value
						.getAllSessionStatuses()
						.pipe(Effect.map(toStatusRecord))
				: Effect.tryPromise(() => api.session.statuses());
		const service: SessionStatusPollerService = createStatusPollerService({
			get pollDeps() {
				return {
					getRawStatuses: readProjectedStatuses,
					getSessionParentMap: () =>
						Runtime.runSync(runtime)(getSessionParentMapFromState),
					resolveParent: (sessionId: string) =>
						Effect.tryPromise(async () => {
							const session = await api.session.get(sessionId);
							return session.parentID;
						}).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
					...(reconciliationDeps ? { reconciliation: reconciliationDeps } : {}),
				};
			},
			...(reconciliationDeps ? { reconciliationDeps } : {}),
			...(config.statusPollerInterval != null && {
				interval: config.statusPollerInterval,
			}),
			runtime: runtimeBridge,
			onSubscriptionFailure: (error) =>
				log
					.child("status-poller")
					.warn(
						`Status poller subscription failed: ${error instanceof Error ? error.message : String(error)}`,
					),
		});
		yield* Effect.addFinalizer(() =>
			Effect.tryPromise({
				try: () => service.drain(),
				catch: (cause) => cause,
			}).pipe(Effect.orDie),
		);
		return service;
	}),
);
