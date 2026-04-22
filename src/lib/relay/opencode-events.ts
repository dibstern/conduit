// ─── OpenCode SSE Event Types & Guards (Task 11) ────────────────────────────
// Typed interfaces and runtime type guard functions for OpenCode SSE events.
//
// Architecture:
// - SDK `Event` is a discriminated union of 30+ typed event variants from
//   @opencode-ai/sdk. All share the `{ type: string; properties: ... }` shape.
// - The live SSE stream emits a few event types NOT in the SDK union (gap events):
//   message.part.delta, message.created, permission.asked, question.asked,
//   server.heartbeat.
// - `SSEEvent = Event | <gap events>` is the superset used by SSE consumers.
// - `SSEGapEvent` is the union of just the gap events.
// - Type guards remain for all event types because the SSE parser emits raw
//   `{ type, properties }` objects (Tasks 13-14 will replace the SSE parser).

import type { PartType, ToolStatus } from "../shared-types.js";

// ─── Structural base ─────────────────────────────────────────────────────────
// Matches the shape of every SSE event (same as SDK Event members).
// Used only as a structural constraint for gap event interfaces.

interface SSEEventBase {
	type: string;
	properties: Record<string, unknown>;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function hasProps(
	event: unknown,
): event is { type: string; properties: Record<string, unknown> } {
	return (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		typeof (event as Record<string, unknown>)["type"] === "string" &&
		"properties" in event &&
		typeof (event as Record<string, unknown>)["properties"] === "object" &&
		(event as Record<string, unknown>)["properties"] !== null
	);
}

// ═════════════════════════════════════════════════════════════════════════════
// GAP EVENTS — SSE delivers these but the SDK Event union does not include them.
// Each has a dedicated interface and type guard.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Part Delta (gap) ────────────────────────────────────────────────────────

export interface PartDeltaEvent extends SSEEventBase {
	type: "message.part.delta";
	properties: {
		sessionID?: string;
		messageID?: string;
		partID: string;
		field: string;
		delta: string;
	};
}

export function isPartDeltaEvent(event: unknown): event is PartDeltaEvent {
	if (!hasProps(event) || event.type !== "message.part.delta") return false;
	const p = event.properties;
	return (
		typeof p["partID"] === "string" &&
		typeof p["field"] === "string" &&
		typeof p["delta"] === "string"
	);
}

// ─── Message Created (gap) ───────────────────────────────────────────────────

export interface MessageCreatedEvent extends SSEEventBase {
	type: "message.created";
	properties: {
		sessionID?: string;
		messageID?: string;
		info?: {
			role?: string;
			parts?: Array<{ type?: string; text?: string }>;
		};
		message?: {
			role?: string;
			parts?: Array<{ type?: string; text?: string }>;
		};
	};
}

// All properties are optional in the interface — downstream uses optional chaining.
// No runtime validation needed beyond type string.
export function isMessageCreatedEvent(
	event: unknown,
): event is MessageCreatedEvent {
	if (!hasProps(event) || event.type !== "message.created") return false;
	return true;
}

// ─── Permission Asked (gap) ──────────────────────────────────────────────────
// SDK has `permission.updated` which is a different event type.

export interface PermissionAskedEvent extends SSEEventBase {
	type: "permission.asked";
	properties: {
		id: string;
		permission: string;
		patterns?: string[];
		metadata?: Record<string, unknown>;
		tool?: { callID?: string };
		always?: string[];
	};
}

export function isPermissionAskedEvent(
	event: unknown,
): event is PermissionAskedEvent {
	if (!hasProps(event) || event.type !== "permission.asked") return false;
	const p = event.properties;
	return typeof p["id"] === "string" && typeof p["permission"] === "string";
}

// ─── Question Asked (gap) ────────────────────────────────────────────────────

export interface QuestionAskedEvent extends SSEEventBase {
	type: "question.asked";
	properties: {
		id: string;
		questions: Array<{
			question?: string;
			header?: string;
			options?: Array<{ label?: string; description?: string }>;
			multiple?: boolean;
			custom?: boolean;
		}>;
		/** Tool context: links this question to the tool_use that triggered it.
		 *  callID is the toolu_ ID from the LLM provider; matches the id field
		 *  in tool_start / tool_executing relay messages. */
		tool?: { callID?: string; messageID?: string };
	};
}

export function isQuestionAskedEvent(
	event: unknown,
): event is QuestionAskedEvent {
	if (!hasProps(event) || event.type !== "question.asked") return false;
	const p = event.properties;
	return typeof p["id"] === "string" && Array.isArray(p["questions"]);
}

// ─── Server Heartbeat (gap) ──────────────────────────────────────────────────

export interface ServerHeartbeatEvent extends SSEEventBase {
	type: "server.heartbeat";
	properties: Record<string, unknown>;
}

export function isServerHeartbeatEvent(
	event: unknown,
): event is ServerHeartbeatEvent {
	return hasProps(event) && event.type === "server.heartbeat";
}

// ═════════════════════════════════════════════════════════════════════════════
// SDK-COVERED EVENTS — These are in the SDK Event union but we keep local
// interfaces with relaxed (optional) properties for backward compatibility
// with the current SSE parser which emits raw { type, properties } objects.
// Type guards are retained until Tasks 13-14 replace the SSE parser.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Part Updated ────────────────────────────────────────────────────────────

export interface PartUpdatedEvent extends SSEEventBase {
	type: "message.part.updated";
	properties: {
		partID?: string;
		messageID?: string;
		part?: {
			id?: string;
			type?: PartType;
			callID?: string;
			tool?: string;
			state?: {
				status?: ToolStatus;
				input?: unknown;
				output?: string;
				error?: string;
			};
			time?: { start?: number; end?: number };
		};
	};
}

export function isPartUpdatedEvent(event: unknown): event is PartUpdatedEvent {
	if (!hasProps(event) || event.type !== "message.part.updated") return false;
	const p = event.properties;
	// A valid part.updated must have a part object with at least a type
	if (!p["part"] || typeof p["part"] !== "object") return false;
	const part = p["part"] as Record<string, unknown>;
	return typeof part["type"] === "string";
}

// ─── Part Removed ────────────────────────────────────────────────────────────

export interface PartRemovedEvent extends SSEEventBase {
	type: "message.part.removed";
	properties: {
		partID: string;
		messageID: string;
	};
}

export function isPartRemovedEvent(event: unknown): event is PartRemovedEvent {
	if (!hasProps(event) || event.type !== "message.part.removed") return false;
	const p = event.properties;
	return typeof p["partID"] === "string" && typeof p["messageID"] === "string";
}

// ─── Session Status ──────────────────────────────────────────────────────────

export interface SessionStatusEvent extends SSEEventBase {
	type: "session.status";
	properties: {
		sessionID?: string;
		status?: {
			type?: string;
			attempt?: number;
			message?: string;
			next?: number;
		};
	};
}

// All properties are optional in the interface — downstream uses optional chaining.
// No runtime validation needed beyond type string.
export function isSessionStatusEvent(
	event: unknown,
): event is SessionStatusEvent {
	if (!hasProps(event) || event.type !== "session.status") return false;
	return true;
}

// ─── Session Error ───────────────────────────────────────────────────────────

export interface SessionErrorEvent extends SSEEventBase {
	type: "session.error";
	properties: {
		sessionID?: string;
		error?: {
			name?: string;
			data?: { message?: string };
		};
	};
}

// All properties are optional in the interface — downstream uses optional chaining.
// No runtime validation needed beyond type string.
export function isSessionErrorEvent(
	event: unknown,
): event is SessionErrorEvent {
	if (!hasProps(event) || event.type !== "session.error") return false;
	return true;
}

// ─── Permission Replied ──────────────────────────────────────────────────────

export interface PermissionRepliedEvent extends SSEEventBase {
	type: "permission.replied";
	properties: {
		id: string;
	};
}

export function isPermissionRepliedEvent(
	event: unknown,
): event is PermissionRepliedEvent {
	if (!hasProps(event) || event.type !== "permission.replied") return false;
	const p = event.properties;
	return typeof p["id"] === "string";
}

// ─── Message Updated ─────────────────────────────────────────────────────────

interface MessagePayload {
	id?: string;
	role?: string;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number; completed?: number };
}

export interface MessageUpdatedEvent extends SSEEventBase {
	type: "message.updated";
	properties: {
		sessionID?: string;
		info?: MessagePayload;
		message?: MessagePayload;
	};
}

// All properties are optional in the interface — downstream uses optional chaining.
// No runtime validation needed beyond type string.
export function isMessageUpdatedEvent(
	event: unknown,
): event is MessageUpdatedEvent {
	if (!hasProps(event) || event.type !== "message.updated") return false;
	return true;
}

// ─── Message Removed ─────────────────────────────────────────────────────────

export interface MessageRemovedEvent extends SSEEventBase {
	type: "message.removed";
	properties: {
		messageID: string;
	};
}

export function isMessageRemovedEvent(
	event: unknown,
): event is MessageRemovedEvent {
	if (!hasProps(event) || event.type !== "message.removed") return false;
	const p = event.properties;
	return typeof p["messageID"] === "string";
}

// ─── PTY Events ──────────────────────────────────────────────────────────────

export interface PtyCreatedEvent extends SSEEventBase {
	type: "pty.created";
	properties: {
		info?: {
			id?: string;
			title?: string;
			command?: string;
			cwd?: string;
			status?: string;
			pid?: number;
		};
		// Fallback: fields may be at top level
		id?: string;
		title?: string;
		command?: string;
		cwd?: string;
		status?: string;
		pid?: number;
	};
}

export interface PtyExitedEvent extends SSEEventBase {
	type: "pty.exited";
	properties: {
		id?: string;
		exitCode?: number;
	};
}

export interface PtyDeletedEvent extends SSEEventBase {
	type: "pty.deleted";
	properties: {
		id?: string;
	};
}

export type PtyEvent = PtyCreatedEvent | PtyExitedEvent | PtyDeletedEvent;

export function isPtyEvent(event: unknown): event is PtyEvent {
	if (!hasProps(event)) return false;
	return (
		event.type === "pty.created" ||
		event.type === "pty.exited" ||
		event.type === "pty.deleted"
	);
}

export function isPtyCreatedEvent(event: unknown): event is PtyCreatedEvent {
	return hasProps(event) && event.type === "pty.created";
}

export function isPtyExitedEvent(event: unknown): event is PtyExitedEvent {
	return hasProps(event) && event.type === "pty.exited";
}

export function isPtyDeletedEvent(event: unknown): event is PtyDeletedEvent {
	return hasProps(event) && event.type === "pty.deleted";
}

// ─── File Events ─────────────────────────────────────────────────────────────

export interface FileEditedEvent extends SSEEventBase {
	type: "file.edited";
	properties: {
		file: string;
	};
}

export interface FileWatcherUpdatedEvent extends SSEEventBase {
	type: "file.watcher.updated";
	properties: {
		file: string;
	};
}

export type FileEvent = FileEditedEvent | FileWatcherUpdatedEvent;

export function isFileEvent(event: unknown): event is FileEvent {
	if (!hasProps(event)) return false;
	if (event.type !== "file.edited" && event.type !== "file.watcher.updated") {
		return false;
	}
	return typeof event.properties["file"] === "string";
}

// ─── Installation Update Available ───────────────────────────────────────────

export interface InstallationUpdateEvent extends SSEEventBase {
	type: "installation.update-available";
	properties: {
		version?: string;
	};
}

export function isInstallationUpdateEvent(
	event: unknown,
): event is InstallationUpdateEvent {
	return hasProps(event) && event.type === "installation.update-available";
}

// ─── Todo Updated ────────────────────────────────────────────────────────────

export interface TodoUpdatedEvent extends SSEEventBase {
	type: "todo.updated";
	properties: {
		todos?: Array<{
			content: string;
			status: string;
			priority?: string;
		}>;
	};
}

export function isTodoUpdatedEvent(event: unknown): event is TodoUpdatedEvent {
	return hasProps(event) && event.type === "todo.updated";
}

// ─── Session ID extraction helpers ───────────────────────────────────────────
// Used by sse-wiring.ts extractSessionId to safely access nested properties.

/** Check if event properties has a top-level sessionID string */
export function hasSessionID(
	props: Record<string, unknown>,
): props is { sessionID: string } & Record<string, unknown> {
	return typeof props["sessionID"] === "string" && props["sessionID"] !== "";
}

/** Check if props.part is an object with a sessionID string */
export function hasPartWithSessionID(
	props: Record<string, unknown>,
): props is { part: { sessionID: string } } & Record<string, unknown> {
	if (!props["part"] || typeof props["part"] !== "object") return false;
	const part = props["part"] as Record<string, unknown>;
	return typeof part["sessionID"] === "string" && part["sessionID"] !== "";
}

/** Check if props.info is an object with a sessionID or id string */
export function hasInfoWithSessionID(props: Record<string, unknown>): props is {
	info: { sessionID?: string; id?: string };
} & Record<string, unknown> {
	if (!props["info"] || typeof props["info"] !== "object") return false;
	const info = props["info"] as Record<string, unknown>;
	return (
		(typeof info["sessionID"] === "string" && info["sessionID"] !== "") ||
		(typeof info["id"] === "string" && info["id"] !== "")
	);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPOSED TYPES
// ═════════════════════════════════════════════════════════════════════════════

// ─── SSE Gap Events ──────────────────────────────────────────────────────────
// Events the SSE stream delivers but the SDK Event union does not include.

export type SSEGapEvent =
	| PartDeltaEvent
	| MessageCreatedEvent
	| PermissionAskedEvent
	| QuestionAskedEvent
	| ServerHeartbeatEvent;

// ─── SSE Event (superset) ────────────────────────────────────────────────────
// The full set of events that can arrive over the SSE stream.
// Combines:
//   - Local relaxed interfaces for SDK-covered events (the SSE parser emits
//     raw objects with optional fields that don't match the SDK's strict types)
//   - Gap event interfaces for events not in the SDK
//   - A structural fallback for unknown/future events
//
// When Tasks 13-14 replace the SSE parser with SDK streaming, SSEEvent will
// converge to `Event | SSEGapEvent` (using the SDK's strict types).

export type SSEEvent =
	| SSEGapEvent
	| PartUpdatedEvent
	| PartRemovedEvent
	| SessionStatusEvent
	| SessionErrorEvent
	| PermissionRepliedEvent
	| MessageUpdatedEvent
	| MessageRemovedEvent
	| PtyCreatedEvent
	| PtyExitedEvent
	| PtyDeletedEvent
	| FileEditedEvent
	| FileWatcherUpdatedEvent
	| InstallationUpdateEvent
	| TodoUpdatedEvent
	| SSEEventBase; // structural fallback for unknown/future events

// ─── Legacy aliases (kept for backward compatibility during migration) ───────

/** @deprecated Use SSEEvent instead */
export type KnownOpenCodeEvent =
	| PartDeltaEvent
	| PartUpdatedEvent
	| PartRemovedEvent
	| SessionStatusEvent
	| SessionErrorEvent
	| PermissionAskedEvent
	| PermissionRepliedEvent
	| QuestionAskedEvent
	| MessageCreatedEvent
	| MessageUpdatedEvent
	| MessageRemovedEvent
	| PtyCreatedEvent
	| PtyExitedEvent
	| PtyDeletedEvent
	| FileEditedEvent
	| FileWatcherUpdatedEvent
	| InstallationUpdateEvent
	| TodoUpdatedEvent;

/** @deprecated Use SSEEvent["type"] instead */
export type KnownOpenCodeEventType = KnownOpenCodeEvent["type"];
