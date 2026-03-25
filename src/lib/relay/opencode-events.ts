// ─── OpenCode Event Type Guards (Ticket 7) ──────────────────────────────────
// Typed interfaces and runtime type guard functions for OpenCode SSE events.
// Replaces unsafe `as` casts scattered across event-translator.ts / sse-wiring.ts.

import type { BaseOpenCodeEvent, PartType, ToolStatus } from "../types.js";

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

// ─── Part Delta ──────────────────────────────────────────────────────────────

export interface PartDeltaEvent extends BaseOpenCodeEvent {
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

// ─── Part Updated ────────────────────────────────────────────────────────────

export interface PartUpdatedEvent extends BaseOpenCodeEvent {
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

export interface PartRemovedEvent extends BaseOpenCodeEvent {
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

export interface SessionStatusEvent extends BaseOpenCodeEvent {
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

export interface SessionErrorEvent extends BaseOpenCodeEvent {
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

// ─── Permission Asked ────────────────────────────────────────────────────────

export interface PermissionAskedEvent extends BaseOpenCodeEvent {
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

// ─── Permission Replied ──────────────────────────────────────────────────────

export interface PermissionRepliedEvent extends BaseOpenCodeEvent {
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

// ─── Question Asked ──────────────────────────────────────────────────────────

export interface QuestionAskedEvent extends BaseOpenCodeEvent {
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

// ─── Message Created ─────────────────────────────────────────────────────────

export interface MessageCreatedEvent extends BaseOpenCodeEvent {
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

// ─── Message Updated ─────────────────────────────────────────────────────────

interface MessagePayload {
	role?: string;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number; completed?: number };
}

export interface MessageUpdatedEvent extends BaseOpenCodeEvent {
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

export interface MessageRemovedEvent extends BaseOpenCodeEvent {
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

export interface PtyCreatedEvent extends BaseOpenCodeEvent {
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

export interface PtyExitedEvent extends BaseOpenCodeEvent {
	type: "pty.exited";
	properties: {
		id?: string;
		exitCode?: number;
	};
}

export interface PtyDeletedEvent extends BaseOpenCodeEvent {
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

export interface FileEditedEvent extends BaseOpenCodeEvent {
	type: "file.edited";
	properties: {
		file: string;
	};
}

export interface FileWatcherUpdatedEvent extends BaseOpenCodeEvent {
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

export interface InstallationUpdateEvent extends BaseOpenCodeEvent {
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

export interface TodoUpdatedEvent extends BaseOpenCodeEvent {
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

// ─── Composed Event Union ────────────────────────────────────────────────────
// Every typed event in a single union so downstream can narrow on `.type`.

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

export type KnownOpenCodeEventType = KnownOpenCodeEvent["type"];
