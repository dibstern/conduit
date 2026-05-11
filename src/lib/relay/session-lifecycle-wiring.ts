// ─── Session Lifecycle Wiring (G4) ───────────────────────────────────────────
// Wires sessionMgr "broadcast" and "session_lifecycle" event handlers.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import { Data, Effect, Layer, Stream } from "effect";
import { DaemonEventBusTag } from "../effect/daemon-pubsub.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	PollerManagerTag,
	type StatusPollerShape,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { SessionStatusPollerService } from "../effect/session-status-poller.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Message } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage } from "../types.js";
import {
	type createTranslator,
	rebuildTranslatorFromHistory,
	rebuildTranslatorFromHistoryOrThrow,
} from "./event-translator.js";
import type { MonitoringState } from "./monitoring-types.js";
import type { createSessionSSETracker } from "./session-sse-tracker.js";

/** Structural interface for the message poller manager's capabilities needed by session lifecycle wiring. */
interface PollerManagerLike {
	startPolling(sessionId: string, seedMessages?: Message[]): void;
	stopPolling(sessionId: string): void;
}

/** Narrowed SessionManager capabilities needed by session lifecycle wiring. */
interface SessionManagerLike {
	on(event: "broadcast", handler: (msg: RelayMessage) => void): this;
	on(
		event: "session_lifecycle",
		handler: (
			ev:
				| { type: "created"; sessionId: string }
				| { type: "deleted"; sessionId: string },
		) => void,
	): this;
}

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface SessionLifecycleWiringDeps {
	sessionMgr: SessionManagerLike;
	wsHandler: WebSocketHandlerShape;
	client: OpenCodeAPI;
	translator: ReturnType<typeof createTranslator>;
	pollerManager: PollerManagerLike;
	statusPoller: SessionStatusPollerService;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	getMonitoringState: () => MonitoringState;
	setMonitoringState: (state: MonitoringState) => void;
	sessionLog: Logger;
}

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

// ─── Wiring function ─────────────────────────────────────────────────────────

/**
 * @deprecated Use makeSessionLifecycleWiringLive instead. Delete when all consumers migrate.
 */
export function wireSessionLifecycle(deps: SessionLifecycleWiringDeps): void {
	const {
		sessionMgr,
		wsHandler,
		client,
		translator,
		pollerManager,
		statusPoller,
		sseTracker,
		getMonitoringState,
		setMonitoringState,
		sessionLog,
	} = deps;

	// ── Wire session manager → WebSocket ────────────────────────────────────

	sessionMgr.on("broadcast", (msg) => {
		wsHandler.broadcast(msg);
	});

	// Track sessions deleted while a "created" handler is awaiting rebuild.
	// Prevents startPolling() for sessions that were deleted during the async gap.
	const deletedSessions = new Set<string>();

	sessionMgr.on("session_lifecycle", async (ev) => {
		const sid = ev.sessionId;
		translator.reset(sid);

		if (ev.type === "created") {
			deletedSessions.delete(sid); // clear stale flag from recycled IDs
			const existingMessages = await rebuildTranslatorFromHistory(
				translator,
				(id) => client.session.messages(id),
				sid,
				sessionLog,
			);

			if (deletedSessions.has(sid)) {
				sessionLog.debug(
					`Skipping poller start for ${sid.slice(0, 12)} — deleted during init`,
				);
				deletedSessions.delete(sid); // clean up — only needed for the await window
				return;
			}

			if (existingMessages) {
				pollerManager.startPolling(sid, existingMessages);
			} else {
				sessionLog.debug(
					`Skipping poller start for ${sid.slice(0, 12)} — no seed messages`,
				);
			}
		} else {
			// deleted — mark for guard, then clean up poller, activity, SSE tracker, and monitoring state
			deletedSessions.add(sid);
			pollerManager.stopPolling(sid);
			statusPoller.clearMessageActivity(sid);
			sseTracker.remove(sid);

			// Remove from monitoring state to prevent the reducer from
			// generating spurious notify-idle effects for already-deleted sessions
			const sessions = new Map(getMonitoringState().sessions);
			sessions.delete(sid);
			setMonitoringState({ sessions });
		}
	});
}

// ─── Effect Layer (replaces wireSessionLifecycle) ───────────────────────────
// Subscribes to DaemonEventBus PubSub for session lifecycle events.
//
// Two independent subscriber fibers:
// - Broadcast fiber:  RelayBroadcast → wsHandler.broadcast (fast, never blocks)
// - Lifecycle fiber:  SessionCreated/SessionDeleted → translator rebuild, poller mgmt
//
// Sequential processing within each fiber ensures correct event ordering,
// eliminating the deletedSessions race guard needed by the imperative version.

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
							return handleSessionCreated(event.sessionId, {
								translator,
								client,
								pollerManager,
								sessionLog,
							});
						}
						if (event._tag === "SessionDeleted") {
							return handleSessionDeleted(event.sessionId, {
								translator,
								pollerManager,
								statusPoller,
								sseTracker,
								getMonitoringState,
								setMonitoringState,
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
