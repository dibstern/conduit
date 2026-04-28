// ─── Session Lifecycle Wiring (G4) ───────────────────────────────────────────
// Wires sessionMgr "broadcast" and "session_lifecycle" event handlers.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { SessionStatusPollerService } from "../effect/session-status-poller.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Message } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage } from "../types.js";
import {
	type createTranslator,
	rebuildTranslatorFromHistory,
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

// ─── Wiring function ─────────────────────────────────────────────────────────

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
