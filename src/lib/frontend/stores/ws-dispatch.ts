// Extracted from ws.svelte.ts — centralized message routing and event replay.
// Pure dispatch table: routes incoming RelayMessage to the appropriate store.
//
// Two-tier dispatcher routes per-session events by event.sessionId
// via routePerSession. Global events handled by handleMessage directly.

import type {
	PerSessionEvent,
	PerSessionEventType,
} from "../../shared-types.js";
import type {
	GetFileContentResponse,
	GetFileListResponse,
} from "../transport/ws-rpc.js";
import type { RelayMessage, ToolMessage } from "../types.js";
import { createFrontendLogger } from "../utils/logger.js";
import {
	findMessage,
	getMessages,
	getOrCreateSessionSlot,
	handleDone,
	type SessionMessages,
	sessionActivity,
	setMessages,
} from "./chat.svelte.js";
import { handleGoalChanged } from "./goal.svelte.js";
import { attachedProjectState } from "./router.svelte.js";
import { restoreServerUpdateBanner } from "./server-status.js";
import {
	findSession,
	isRoutable,
	observeSessionActivity,
	sessionState,
} from "./session.svelte.js";
import {
	refreshSessionSkills,
	sessionSkillsState,
} from "./session-skills.svelte.js";

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
		"user_message",
		"part_removed",
		"message_removed",
		"provider_session_reloaded",
		"session.goal_changed",
	]);

/** Runtime guard: does this message carry a per-session event type? */
export function isPerSessionEvent(msg: RelayMessage): msg is PerSessionEvent {
	return PER_SESSION_EVENT_TYPES.has(msg.type);
}

function isDev(): boolean {
	return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Route a per-session event to the correct session slot by event.sessionId.
 * Validates sessionId presence, and that the session is one we know about or
 * the one being viewed.
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
		case "user_message":
			refreshSessionSkills(event.sessionId);
			break;
		case "tool_result":
			if (sessionSkillsState.loads.some((load) => load.running))
				refreshSessionSkills(event.sessionId);
			break;
		case "done": {
			handleDone(activity, messages, event);
			refreshSessionSkills(event.sessionId);
			// Only notify for root agent sessions — subagent completions are
			// intermediate steps; the parent emits its own done when finished.
			// A failure is always worth telling.
			const doneSession = findSession(event.sessionId);
			if (!doneSession?.parentID || event.error !== undefined) {
				triggerNotifications(event);
			}
			break;
		}
		case "tool_content":
			handleToolContentResponse(messages, event);
			break;
		case "provider_session_reloaded":
			log.debug("Provider session reloaded:", event.sessionId);
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
	// session slot.
	if (isPerSessionEvent(msg)) {
		routePerSession(msg);
		return;
	}

	// Unknown message type — debug-only (tree-shaken in production)
	log.debug("Unhandled message type:", msg.type, msg);
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

/** Attach this tab to a project: the reply to AttachProject, or a ViewSession
 *  that crossed projects. Listeners reset per-project state, which clears
 *  banners, so the server-update banner is restored afterwards. */
export function setAttachedProject(slug: string): void {
	if (attachedProjectState.slug !== slug)
		for (const activity of sessionActivity.values())
			activity.replayGeneration++;
	attachedProjectState.slug = slug;
	for (const listener of projectAttachedListeners) listener(slug);
	restoreServerUpdateBanner();
}
