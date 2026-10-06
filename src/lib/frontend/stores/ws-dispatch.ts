// Extracted from ws.svelte.ts — centralized message routing and event replay.
// Pure dispatch table: routes incoming RelayMessage to the appropriate store.
//
// Two-tier dispatcher routes per-session events by event.sessionId
// via routePerSession. Global events handled by handleMessage directly.

import { Effect } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { notificationContent } from "../../notification-content.js";
import {
	type PerSessionEvent,
	type PerSessionEventType,
	WS_PROTOCOL_VERSION,
} from "../../shared-types.js";
import { runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import type {
	GetFileContentResponse,
	GetFileListResponse,
} from "../transport/ws-rpc.js";
import type { RelayMessage, ToolMessage } from "../types.js";
import {
	claimBuildReload,
	refreshAppShell,
	releaseBuildReload,
} from "../utils/build-id.js";
import { createFrontendLogger } from "../utils/logger.js";
import {
	findMessage,
	getMessages,
	getOrCreateSessionSlot,
	handleCompaction,
	handleDone,
	handleError,
	handleInputSyncReceived,
	handleStatus,
	inputSyncState,
	persistInputDraft,
	type SessionActivity,
	type SessionMessages,
	sessionActivity,
	setMessages,
} from "./chat.svelte.js";
import { isOwnBrowserClientId } from "./client-identity.js";
import { handleGoalChanged } from "./goal.svelte.js";
import { clearScanInFlight } from "./instance.svelte.js";
import {
	attachedProjectState,
	getCurrentRoute,
	getCurrentSlug,
	replaceRoute,
} from "./router.svelte.js";
import {
	findSession,
	getFilteredSessions,
	handleSessionFamily,
	handleSessionForked,
	isRoutable,
	observeSessionActivity,
	pruneSessionLists,
	sessionState,
	switchToSession,
} from "./session.svelte.js";
import { refreshSessionList } from "./session-list.svelte.js";
import {
	refreshSessionSkills,
	sessionSkillsState,
} from "./session-skills.svelte.js";
import { handlePtyError } from "./terminal.svelte.js";
import { clearTodoState } from "./todo.svelte.js";
import {
	removeBanner,
	showBanner,
	showToast,
	updateContextPercent,
} from "./ui.svelte.js";

import {
	fileBrowserListeners,
	projectAttachedListeners,
} from "./ws-listeners.js";
import { triggerNotifications } from "./ws-notifications.js";

const log = createFrontendLogger("ws");

// Runtime Set of per-session event types for the isPerSessionEvent guard.
// Mirrors the PerSessionEventType TS union in shared-types.ts.

const PER_SESSION_EVENT_TYPES: ReadonlySet<string> =
	new Set<PerSessionEventType>([
		"delta",
		"thinking_start",
		"thinking_delta",
		"thinking_stop",
		"tool_start",
		"tool_executing",
		"tool_result",
		"tool_content",
		"result",
		"done",
		"error",
		"status",
		"compaction",
		"user_message",
		"part_removed",
		"message_removed",
		"session_forked",
		"provider_session_reloaded",
		"session_deleted",
		"session.goal_changed",
	]);

/** Runtime guard: does this message carry a per-session event type? */
export function isPerSessionEvent(msg: RelayMessage): msg is PerSessionEvent {
	return PER_SESSION_EVENT_TYPES.has(msg.type);
}

/** Per-session event types that still require global coordination in handleMessage.
 *  These are NOT routed through routePerSession. */
const GLOBALLY_COORDINATED_TYPES: ReadonlySet<string> = new Set([
	"session_forked",
	"session_deleted",
]);

function isDev(): boolean {
	return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Route a per-session event to the correct session slot by event.sessionId.
 * Validates sessionId presence, and that the session is one we know about or
 * the one being viewed.
 *
 * NOTE: notification_event is excluded from PerSessionEventType by
 * construction — it routes through handleMessage's global dispatch instead.
 */
function routePerSession(event: PerSessionEvent): void {
	if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
		if (isDev())
			throw new Error(`routePerSession: missing sessionId on ${event.type}`);
		// prod: silently drop — telemetry counter would go here
		return;
	}

	// Lives outside chat slots and accepts sessions not yet in membership.
	// Never allocate a slot here: a slot per unrelated session would evict
	// cached transcripts from the LRU.
	switch (event.type) {
		case "session.goal_changed":
			handleGoalChanged(event);
			return;
	}

	// The shell feed can announce a row after a background event. Dropping the
	// event is safe: opening that session loads fresh history after membership.
	if (!isRoutable(event.sessionId)) {
		log.debug(
			"routePerSession: unknown sessionId %s for event %s",
			event.sessionId,
			event.type,
		);
		// prod: silently drop — telemetry counter would go here
		return;
	}

	const { activity, messages } = getOrCreateSessionSlot(event.sessionId);

	switch (event.type) {
		case "tool_result":
			if (sessionSkillsState.loads.some((load) => load.running))
				refreshSessionSkills(event.sessionId);
			break;
		case "done": {
			handleDone(activity, messages, event);
			refreshSessionSkills(event.sessionId);
			// Only notify for root agent sessions — subagent completions are
			// intermediate steps; the parent emits its own done when finished.
			const doneSession = findSession(event.sessionId);
			if (!doneSession?.parentID) {
				triggerNotifications(event);
			}
			break;
		}
		case "status":
			handleStatus(activity, messages, event);
			break;
		case "compaction":
			handleCompaction(activity, messages, event);
			break;
		case "error":
			handleChatError(activity, messages, event);
			triggerNotifications(event);
			break;
		case "tool_content":
			handleToolContentResponse(messages, event);
			break;
		case "session_forked":
			// Handled in handleMessage — requires global toast.
			break;
		case "provider_session_reloaded":
			log.debug("Provider session reloaded:", event.sessionId);
			break;
		case "session_deleted":
			// Handled in handleMessage — requires global session state update.
			break;
	}
}

/**
 * Route an incoming WebSocket message to the appropriate store handler.
 * Replaces the vanilla handler registry pattern.
 */
export function handleMessage(msg: RelayMessage): void {
	observeSessionActivity(msg);
	// Per-session events are routed by event.sessionId to the correct
	// session slot. notification_event is excluded by construction
	// (PerSessionEventType union does not include it).
	if (isPerSessionEvent(msg)) {
		// Events requiring global coordination are handled in the switch
		// below rather than routePerSession. All other per-session events
		// route through routePerSession.
		if (!GLOBALLY_COORDINATED_TYPES.has(msg.type)) {
			routePerSession(msg);
			return;
		}
	}

	switch (msg.type) {
		case "session_family": {
			handleSessionFamily(msg);
			break;
		}
		case "session_forked": {
			handleSessionForked(msg);
			const parentTitle = msg.parentTitle ?? "session";
			showToast(`Forked from "${parentTitle}"`);
			break;
		}
		case "session_deleted": {
			const deletedId = msg.sessionId;
			// The shell feed owns row removal and chat cleanup.
			pruneSessionLists(deletedId);
			const route = getCurrentRoute();
			if (
				(sessionState.currentId === deletedId ||
					sessionState.currentId === null) &&
				route.page === "chat" &&
				route.sessionId === deletedId
			) {
				const survivor = getFilteredSessions().find(
					(row) => row.id !== deletedId,
				);
				if (survivor)
					switchToSession(survivor.id, survivor.projectSlug, undefined, {
						replace: true,
					});
				else {
					const activity = sessionActivity.get(deletedId);
					if (activity) activity.replayGeneration++;
					updateContextPercent(0);
					clearTodoState();
					replaceRoute("/");
					sessionState.currentId = null;
				}
			}
			break;
		}

		// Now routed through routePerSession (per-session events).

		case "protocol_version":
			handleProtocolVersion(msg.version);
			handleBuildId(msg.buildId);
			break;
		case "server_update":
			if (!msg.restartAvailable) serverRestartAccepted = false;
			handleServerUpdate(msg.restartAvailable);
			break;
		case "input_sync":
			if (isOwnBrowserClientId(msg.from)) break;
			handleInputSyncReceived(msg);
			break;

		case "daemon_sessions_changed":
			void refreshSessionList();
			break;

		// Now routed through routePerSession (per-session events).

		// Broadcast by the server when a notification-worthy event (done,
		// error) is dropped because the user is viewing a different session.
		// Trigger sound/browser notifications without updating chat state.
		case "notification_event": {
			const syntheticMsg = {
				type: msg.eventType,
				...(msg.alertId != null ? { alertId: msg.alertId } : {}),
				...(msg.message != null ? { message: msg.message } : {}),
				...(msg.sessionId != null ? { sessionId: msg.sessionId } : {}),
			} as RelayMessage;

			// Nothing here touches badge state any more: this message exists only to
			// fire the alert (ni8.23). What a session is waiting on, and whether it
			// has been looked at, arrive on the session row.

			// Suppress all frontend notifications for subagent done events.
			// Server-side notification-policy.ts is the primary defense; this is belt-and-suspenders.
			const isSubagentDone =
				msg.eventType === "done" &&
				msg.sessionId &&
				findSession(msg.sessionId)?.parentID;

			if (!isSubagentDone) {
				triggerNotifications(syntheticMsg);
			}

			// In-app toast for cross-session error events only. Done events
			// are suppressed: all "done" messages are synthetic (generated by
			// conduit from session.status:idle), and OpenCode can emit idle
			// between tool rounds (e.g. after a bash call completes), causing
			// spurious "Response complete" toasts mid-turn. Users still get sound,
			// browser/push notifications, and the sidebar green dot for
			// genuine completions.
			if (!isSubagentDone && msg.eventType === "error") {
				const content = notificationContent(syntheticMsg);
				if (content) {
					showToast(
						content.title + (content.body ? ` — ${content.body}` : ""),
						{
							variant: "warn",
						},
					);
				}
			}
			break;
		}

		default:
			// Unknown message type — debug-only (tree-shaken in production)
			log.debug("Unhandled message type:", msg.type, msg);
			break;
	}
}

// Auxiliary handlers (only called from handleMessage)

/** Tool content: replace truncated result with full content. */
function handleToolContentResponse(
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "tool_content" }>,
): void {
	const { toolId, content } = msg;
	const currentMsgs = [...getMessages(messages)];
	const found = findMessage(currentMsgs, "tool", (m) => m.id === toolId);
	if (found) {
		setMessages(
			messages,
			currentMsgs.map((m, i) => {
				if (i !== found.index) return m;
				const updated: ToolMessage = {
					...found.message,
					result: content,
					isTruncated: false,
				};
				delete updated.fullContentLength;
				return updated;
			}),
		);
	}
}

export function applyToolContentResponse(msg: {
	readonly projectSlug?: string;
	readonly toolId: string;
	readonly content: string;
	readonly sessionId?: string;
}): void {
	const sessionId = msg.sessionId ?? sessionState.currentId;
	if (sessionId == null) return;
	handleToolContentResponse(getOrCreateSessionSlot(sessionId).messages, {
		type: "tool_content",
		sessionId,
		toolId: msg.toolId,
		content: msg.content,
	});
}

export function applyGetFileListResponse(response: GetFileListResponse): void {
	for (const fn of fileBrowserListeners) fn({ kind: "list", response });
}

export function applyGetFileContentResponse(
	response: GetFileContentResponse,
): void {
	for (const fn of fileBrowserListeners) fn({ kind: "content", response });
}

/** Error routing: PTY errors vs chat errors. */
function handleChatError(
	activity: SessionActivity,
	messages: SessionMessages,
	msg: Extract<RelayMessage, { type: "error" }>,
): void {
	const code = msg.code;

	// PTY-related errors
	if (code === "PTY_CONNECT_FAILED") {
		handlePtyError(msg);
		return;
	}

	// Handler errors (e.g., question reply failed): show toast so the user
	// knows something went wrong, rather than silently swallowing.
	if (code === "HANDLER_ERROR") {
		const text = msg.message ?? "An operation failed on the server";
		showToast(text, { variant: "warn" });
		return;
	}

	// Instance errors — show as toast and clear scan state if pending
	if (code === "INSTANCE_ERROR") {
		clearScanInFlight();
		showToast(msg.message ?? "Instance operation failed", {
			variant: "warn",
		});
		return;
	}

	// Chat errors
	handleError(activity, messages, msg);
}

/** The daemon sends protocol_version on connect. An older daemon needs a
 *  restart; an older page needs a reload. No message within the grace window
 *  still marks a daemon predating the handshake. */
const STALE_DAEMON_BANNER_ID = "stale-daemon";
const STALE_PAGE_BANNER_ID = "stale-page";
const PROTOCOL_VERSION_GRACE_MS = 10_000;
let protocolVersionTimer: ReturnType<typeof setTimeout> | null = null;

const BUILD_MISMATCH_BANNER_ID = "build-mismatch";
const SERVER_UPDATE_BANNER_ID = "server-update";
let buildReloadPending = false;
let buildMismatchWarning = false;
let serverUpdateAvailable = false;
let serverRestartInFlight = false;
let serverRestartAccepted = false;

function showBuildMismatchBanner(): void {
	buildMismatchWarning = true;
	if (serverUpdateAvailable) return;
	showBanner({
		id: BUILD_MISMATCH_BANNER_ID,
		variant: "warning",
		icon: "refresh-cw",
		text: "This page and the server have different builds. Restart the server, then reload this tab. Your draft is still here.",
		summary: "Restart the server",
		dismissible: false,
	});
}

function showServerUpdateBanner(): void {
	showBanner({
		id: SERVER_UPDATE_BANNER_ID,
		variant: "update",
		icon: "refresh-cw",
		text: "A new conduit build is ready. Restart the server to load it. Sessions and terminals keep running.",
		summary: "New build ready",
		dismissible: true,
		action: {
			label: "Restart",
			run: async () => {
				if (
					!serverUpdateAvailable ||
					serverRestartInFlight ||
					serverRestartAccepted
				)
					return;
				serverRestartInFlight = true;
				try {
					await runTransportEffect(
						Effect.gen(function* () {
							const clients = yield* WsRpcClients;
							const { control } = yield* clients.forProject(
								getCurrentSlug() ?? "",
							);
							return yield* control.RestartWithConfig({});
						}),
					);
					serverRestartAccepted = true;
					removeBanner(SERVER_UPDATE_BANNER_ID);
					showToast("Restarting conduit…");
				} catch (error: unknown) {
					const reason =
						error instanceof Error ? error.message : "the daemon rejected it.";
					showToast(`Failed to restart conduit: ${reason}`, {
						variant: "error",
					});
					if (serverUpdateAvailable) showServerUpdateBanner();
				} finally {
					serverRestartInFlight = false;
				}
			},
		},
	});
}

/** Attach this tab to a project: the reply to AttachProject, or a ViewSession
 *  that crossed projects. Listeners reset per-project state, which clears
 *  banners, so the server-update banner is restored afterwards. */
export function setAttachedProject(slug: string): void {
	if (attachedProjectState.slug !== slug)
		for (const activity of sessionActivity.values())
			activity.replayGeneration++;
	attachedProjectState.slug = slug;
	for (const listener of projectAttachedListeners) listener(slug);
	handleServerUpdate(serverUpdateAvailable);
}

function handleServerUpdate(restartAvailable: boolean): void {
	serverUpdateAvailable = restartAvailable;
	if (restartAvailable) {
		removeBanner(BUILD_MISMATCH_BANNER_ID);
		if (!serverRestartInFlight && !serverRestartAccepted)
			showServerUpdateBanner();
	} else {
		removeBanner(SERVER_UPDATE_BANNER_ID);
		if (buildMismatchWarning) showBuildMismatchBanner();
	}
}

function handleBuildId(serverBuildId: string | undefined): void {
	if (buildReloadPending) return;
	const action = claimBuildReload(BUILD_ID, serverBuildId);
	if (action === "current") {
		buildMismatchWarning = false;
		removeBanner(BUILD_MISMATCH_BANNER_ID);
		return;
	}
	if (action === "warn") {
		showBuildMismatchBanner();
		return;
	}
	buildReloadPending = true;
	inputSyncState.reloadPending = true;
	showToast("Conduit was updated. Saving your draft and reloading…", {
		duration: 1_000,
	});
	void (async () => {
		try {
			await refreshAppShell();
			// Leave the notice visible briefly; save after any last keystrokes.
			await new Promise((resolve) => setTimeout(resolve, 750));
			if (await persistInputDraft()) {
				location.reload();
				return;
			}
		} catch {
			// Failed worker updates and draft saves also keep this tab open.
		}
		releaseBuildReload(serverBuildId);
		buildReloadPending = false;
		inputSyncState.reloadPending = false;
		showBuildMismatchBanner();
	})();
}

function showStaleDaemonBanner(): void {
	showBanner({
		id: STALE_DAEMON_BANNER_ID,
		variant: "warning",
		icon: "alert-triangle",
		text: "The conduit daemon is running an older version than this page — restart the daemon to avoid inconsistent behavior.",
		summary: "Restart the daemon",
		dismissible: true,
	});
}

/** Called on socket open: expect a protocol_version within the grace window. */
export function armProtocolVersionCheck(): void {
	disarmProtocolVersionCheck();
	protocolVersionTimer = setTimeout(() => {
		protocolVersionTimer = null;
		showStaleDaemonBanner();
	}, PROTOCOL_VERSION_GRACE_MS);
}

/** Called on socket close so a dead connection can't trigger the banner. */
export function disarmProtocolVersionCheck(): void {
	if (protocolVersionTimer) {
		clearTimeout(protocolVersionTimer);
		protocolVersionTimer = null;
	}
}

function handleProtocolVersion(version: number): void {
	disarmProtocolVersionCheck();
	if (version === WS_PROTOCOL_VERSION) {
		removeBanner(STALE_DAEMON_BANNER_ID);
		removeBanner(STALE_PAGE_BANNER_ID);
	} else if (version < WS_PROTOCOL_VERSION) {
		removeBanner(STALE_PAGE_BANNER_ID);
		showStaleDaemonBanner();
	} else {
		removeBanner(STALE_DAEMON_BANNER_ID);
		showBanner({
			id: STALE_PAGE_BANNER_ID,
			variant: "update",
			icon: "refresh-cw",
			text: "Conduit was updated. Reload this tab to keep things working.",
			summary: "Reload this tab",
			dismissible: true,
			action: { label: "Reload", run: () => location.reload() },
		});
	}
}
