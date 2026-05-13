// ─── Session Lifecycle Wiring (G4) ───────────────────────────────────────────
// Subscribes to DaemonEventBus lifecycle and relay broadcast events.

import { Data, Effect, FiberMap, Layer, Ref, Stream } from "effect";
import { DaemonEventBusTag } from "../effect/daemon-pubsub.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	PollerManagerTag,
	type StatusPollerShape,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { Message } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { RelayMessage } from "../types.js";
import {
	type createTranslator,
	rebuildTranslatorFromHistoryOrThrow,
} from "./event-translator.js";
import type { MonitoringState } from "./monitoring-types.js";
import type { createSessionSSETracker } from "./session-sse-tracker.js";

export class SessionLifecycleHistoryRebuildError extends Data.TaggedError(
	"SessionLifecycleHistoryRebuildError",
)<{
	sessionId: string;
	operation: "rebuildTranslatorFromHistory";
	cause: unknown;
}> {
	get message(): string {
		const inner =
			this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `${this.operation} failed for ${this.sessionId}: ${inner}`;
	}
}

type SessionLifecycleGenerations = Map<string, number>;

const nextSessionGeneration = (
	generations: SessionLifecycleGenerations,
	sessionId: string,
) => (generations.get(sessionId) ?? 0) + 1;

const markSessionCreated = (
	generationsRef: Ref.Ref<SessionLifecycleGenerations>,
	sessionId: string,
) =>
	Ref.modify(generationsRef, (generations) => {
		const generation = nextSessionGeneration(generations, sessionId);
		const next = new Map(generations);
		next.set(sessionId, generation);
		return [generation, next] as const;
	});

const markSessionDeleted = (
	generationsRef: Ref.Ref<SessionLifecycleGenerations>,
	sessionId: string,
) =>
	Ref.update(generationsRef, (generations) => {
		const next = new Map(generations);
		next.set(sessionId, nextSessionGeneration(generations, sessionId));
		return next;
	});

const isSessionGenerationCurrent = (
	generationsRef: Ref.Ref<SessionLifecycleGenerations>,
	sessionId: string,
	generation: number,
) =>
	Ref.get(generationsRef).pipe(
		Effect.map((generations) => generations.get(sessionId) === generation),
	);

// ─── Effect Layer ───────────────────────────────────────────────────────────
// Subscribes to DaemonEventBus PubSub for session lifecycle events.
//
// Two independent subscriber fibers:
// - Broadcast fiber:  RelayBroadcast → wsHandler.broadcast (fast, never blocks)
// - Lifecycle fiber:  SessionCreated/SessionDeleted → translator rebuild, poller mgmt.
//   Create rebuilds run in keyed scoped fibers so delete events can invalidate
//   in-flight creates before those creates start polling.

export interface SessionLifecycleWiringExternalDeps {
	translator: ReturnType<typeof createTranslator>;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	getMonitoringState: () => MonitoringState;
	setMonitoringState: (state: MonitoringState) => void;
}

export const makeSessionLifecycleWiringLive = (
	deps: SessionLifecycleWiringExternalDeps,
): Layer.Layer<
	never,
	never,
	| WebSocketHandlerTag
	| OpenCodeAPITag
	| PollerManagerTag
	| StatusPollerTag
	| LoggerTag
	| DaemonEventBusTag
> =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const wsHandler = yield* WebSocketHandlerTag;
			const client = yield* OpenCodeAPITag;
			const pollerManager = yield* PollerManagerTag;
			const statusPoller = yield* StatusPollerTag;
			const log = yield* LoggerTag;
			const bus = yield* DaemonEventBusTag;
			const sessionLog = log.child("session");
			const createGenerationsRef = yield* Ref.make<SessionLifecycleGenerations>(
				new Map(),
			);
			const createFibers = yield* FiberMap.make<string, void, never>();

			const { translator, sseTracker, getMonitoringState, setMonitoringState } =
				deps;

			// ── Broadcast fiber (fast path) ────────────────────────────────────
			yield* Effect.forkScoped(
				Stream.fromPubSub(bus).pipe(
					Stream.runForEach((event) =>
						event._tag === "RelayBroadcast"
							? Effect.sync(() =>
									wsHandler.broadcast(event.message as RelayMessage),
								)
							: Effect.void,
					),
				),
			);

			// ── Lifecycle fiber (sequential processing) ────────────────────────
			yield* Effect.forkScoped(
				Stream.fromPubSub(bus).pipe(
					Stream.runForEach((event) => {
						if (event._tag === "SessionCreated") {
							return Effect.gen(function* () {
								const generation = yield* markSessionCreated(
									createGenerationsRef,
									event.sessionId,
								);
								yield* FiberMap.run(
									createFibers,
									event.sessionId,
									handleSessionCreated(event.sessionId, {
										translator,
										client,
										pollerManager,
										sessionLog,
										isSessionCurrent: isSessionGenerationCurrent(
											createGenerationsRef,
											event.sessionId,
											generation,
										),
									}).pipe(
										Effect.catchTag(
											"SessionLifecycleHistoryRebuildError",
											(error) =>
												Effect.logError(
													"Session history rebuild failed; continuing lifecycle subscriber",
													error,
												).pipe(
													Effect.annotateLogs({
														sessionId: error.sessionId,
														operation: error.operation,
													}),
												),
										),
									),
								);
							});
						}
						if (event._tag === "SessionDeleted") {
							return Effect.gen(function* () {
								yield* markSessionDeleted(
									createGenerationsRef,
									event.sessionId,
								);
								yield* handleSessionDeleted(event.sessionId, {
									translator,
									pollerManager,
									statusPoller,
									sseTracker,
									getMonitoringState,
									setMonitoringState,
								});
								yield* FiberMap.remove(createFibers, event.sessionId);
							});
						}
						return Effect.void;
					}),
				),
			);
		}),
	);

// ─── Event Handlers ─────────────────────────────────────────────────────────

export const handleSessionCreated = (
	sessionId: string,
	deps: {
		translator: ReturnType<typeof createTranslator>;
		client: { session: { messages: (id: string) => Promise<Message[]> } };
		pollerManager: { startPolling: (id: string, msgs?: Message[]) => void };
		sessionLog: Logger;
		isSessionCurrent?: Effect.Effect<boolean>;
	},
) =>
	Effect.gen(function* () {
		deps.translator.reset(sessionId);

		const existingMessages = yield* Effect.tryPromise({
			try: () =>
				rebuildTranslatorFromHistoryOrThrow(
					deps.translator,
					(id) => deps.client.session.messages(id),
					sessionId,
				),
			catch: (cause) =>
				new SessionLifecycleHistoryRebuildError({
					sessionId,
					operation: "rebuildTranslatorFromHistory",
					cause,
				}),
		});

		if (existingMessages) {
			const isSessionCurrentEffect =
				deps.isSessionCurrent ?? Effect.succeed(true);
			const isSessionCurrent = yield* isSessionCurrentEffect;
			if (!isSessionCurrent) {
				deps.sessionLog.debug(
					`Skipping poller start for ${sessionId.slice(0, 12)} — deleted during init`,
				);
				return;
			}
			deps.pollerManager.startPolling(sessionId, existingMessages);
		} else {
			deps.sessionLog.debug(
				`Skipping poller start for ${sessionId.slice(0, 12)} — no seed messages`,
			);
		}
	});

const handleSessionDeleted = (
	sessionId: string,
	deps: {
		translator: ReturnType<typeof createTranslator>;
		pollerManager: { stopPolling: (id: string) => void };
		statusPoller: StatusPollerShape;
		sseTracker: ReturnType<typeof createSessionSSETracker>;
		getMonitoringState: () => MonitoringState;
		setMonitoringState: (state: MonitoringState) => void;
	},
) =>
	Effect.sync(() => {
		deps.translator.reset(sessionId);
		deps.pollerManager.stopPolling(sessionId);
		deps.statusPoller.clearMessageActivity(sessionId);
		deps.sseTracker.remove(sessionId);

		const sessions = new Map(deps.getMonitoringState().sessions);
		sessions.delete(sessionId);
		deps.setMonitoringState({ sessions });
	});
