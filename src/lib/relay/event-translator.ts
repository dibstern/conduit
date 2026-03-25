// ─── Event Translator (Ticket 1.3) ──────────────────────────────────────────
// Translates OpenCode SSE events → relay WebSocket messages.
// Stateful: tracks seen parts for lifecycle detection.

import type { PermissionId } from "../shared-types.js";
import type {
	AskUserQuestion,
	OpenCodeEvent,
	PartType,
	RelayMessage,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
} from "../types.js";
import type { KnownOpenCodeEventType } from "./opencode-events.js";
import {
	isFileEvent,
	isInstallationUpdateEvent,
	isMessageCreatedEvent,
	isMessageRemovedEvent,
	isMessageUpdatedEvent,
	isPartDeltaEvent,
	isPartRemovedEvent,
	isPartUpdatedEvent,
	isPermissionAskedEvent,
	isPtyCreatedEvent,
	isPtyDeletedEvent,
	isPtyEvent,
	isPtyExitedEvent,
	isQuestionAskedEvent,
	isSessionErrorEvent,
	isSessionStatusEvent,
	isTodoUpdatedEvent,
} from "./opencode-events.js";

// ─── Compile-time exhaustiveness assertion ──────────────────────────────────
// If a new event type is added to KnownOpenCodeEvent but not handled here,
// _MissingTypes will be non-never and this file will fail to compile.

type _HandledByTranslator =
	| "message.part.delta"
	| "message.part.updated"
	| "message.part.removed"
	| "message.created"
	| "message.updated"
	| "message.removed"
	| "session.status"
	| "session.error"
	| "permission.asked"
	| "question.asked"
	| "pty.created"
	| "pty.exited"
	| "pty.deleted"
	| "file.edited"
	| "file.watcher.updated"
	| "installation.update-available"
	| "todo.updated";

type _HandledByBridge = "permission.replied";

type _MissingTypes = Exclude<
	KnownOpenCodeEventType,
	_HandledByTranslator | _HandledByBridge
>;
type _AssertAllHandled = _MissingTypes extends never
	? true
	: { error: "Unhandled event type(s)"; types: _MissingTypes };
const _exhaustiveCheck: _AssertAllHandled = true;

// ─── Tool name mapping ──────────────────────────────────────────────────────

/** Maximum number of tracked parts before FIFO eviction kicks in. */
const SEEN_PARTS_MAX = 10_000;
/** Number of oldest entries to evict when the cap is reached. */
const SEEN_PARTS_EVICT_COUNT = 2_000;

const TOOL_NAME_MAP: Record<string, ToolName> = {
	read: "Read",
	edit: "Edit",
	write: "Write",
	bash: "Bash",
	glob: "Glob",
	grep: "Grep",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	todowrite: "TodoWrite",
	todoread: "TodoRead",
	question: "AskUserQuestion",
	task: "Task",
	lsp: "LSP",
	skill: "Skill",
};

/** Map lowercase OpenCode tool name → PascalCase frontend name */
export function mapToolName(name: string): string {
	return TOOL_NAME_MAP[name] ?? name;
}

// ─── Individual translators ─────────────────────────────────────────────────

/** Translate message.part.delta → delta or thinking_delta */
export function translatePartDelta(
	event: OpenCodeEvent,
	seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
): RelayMessage | null {
	if (!isPartDeltaEvent(event)) return null;
	const { properties: props } = event;

	const messageId = props.messageID;
	const partInfo = seenParts.get(props.partID);
	if (!partInfo) {
		// Part not yet tracked — treat as text delta
		if (props.field === "text") {
			return {
				type: "delta",
				text: props.delta,
				...(messageId != null && { messageId }),
			};
		}
		return null;
	}

	if (partInfo.type === "reasoning") {
		return {
			type: "thinking_delta",
			text: props.delta,
			...(messageId != null && { messageId }),
		};
	}

	return {
		type: "delta",
		text: props.delta,
		...(messageId != null && { messageId }),
	};
}

/** Translate message.part.updated for tool parts */
export function translateToolPartUpdated(
	partID: string,
	part: {
		type: PartType;
		callID?: string;
		tool?: string;
		state?: {
			status?: ToolStatus;
			input?: unknown;
			output?: string;
			error?: string;
			metadata?: Record<string, unknown>;
		};
		time?: { start?: number; end?: number };
	},
	isNew: boolean,
	messageId?: string,
): RelayMessage | RelayMessage[] | null {
	if (part.type !== "tool") return null;

	const status = part.state?.status;
	const toolName = mapToolName(part.tool ?? "");
	const callID = part.callID ?? partID;
	const metadata = part.state?.metadata;

	if (isNew && status === "pending") {
		return {
			type: "tool_start",
			id: callID,
			name: toolName,
			...(messageId != null && { messageId }),
		};
	}

	// Part first seen as "running" (skipped "pending") — emit both tool_start
	// and tool_executing so the frontend creates and activates the tool card.
	// Matches message-poller behaviour which handles the same case.
	if (isNew && status === "running") {
		return [
			{
				type: "tool_start",
				id: callID,
				name: toolName,
				...(messageId != null && { messageId }),
			},
			{
				type: "tool_executing",
				id: callID,
				name: toolName,
				input: part.state?.input as Record<string, unknown> | undefined,
				...(metadata != null && { metadata }),
				...(messageId != null && { messageId }),
			},
		];
	}

	if (status === "running") {
		return {
			type: "tool_executing",
			id: callID,
			name: toolName,
			input: part.state?.input as Record<string, unknown> | undefined,
			...(metadata != null && { metadata }),
			...(messageId != null && { messageId }),
		};
	}

	if (status === "completed") {
		return {
			type: "tool_result",
			id: callID,
			content: part.state?.output ?? "",
			is_error: false,
			...(messageId != null && { messageId }),
		};
	}

	if (status === "error") {
		return {
			type: "tool_result",
			id: callID,
			content: part.state?.error ?? "Unknown error",
			is_error: true,
			...(messageId != null && { messageId }),
		};
	}

	return null;
}

/** Translate message.part.updated for reasoning parts */
export function translateReasoningPartUpdated(
	part: { type: PartType; time?: { start?: number; end?: number } },
	isNew: boolean,
	messageId?: string,
): RelayMessage | null {
	if (part.type !== "reasoning") return null;

	if (isNew) {
		return { type: "thinking_start", ...(messageId != null && { messageId }) };
	}

	if (part.time?.end !== undefined && part.time.end !== null) {
		return { type: "thinking_stop", ...(messageId != null && { messageId }) };
	}

	return null;
}

/** Translate permission.asked event */
export function translatePermission(
	event: OpenCodeEvent,
	sessionId?: string,
): RelayMessage | null {
	if (!isPermissionAskedEvent(event)) return null;
	if (!sessionId) return null;
	const { properties: props } = event;

	return {
		type: "permission_request",
		sessionId,
		requestId: props.id as PermissionId,
		toolName: props.permission,
		toolInput: {
			patterns: props.patterns ?? [],
			metadata: props.metadata ?? {},
		},
		always: props.always ?? [],
		...(props.tool?.callID ? { toolUseId: props.tool.callID } : {}),
	};
}

/** Translate question.asked event */
export function translateQuestion(event: OpenCodeEvent): RelayMessage | null {
	if (!isQuestionAskedEvent(event)) return null;
	const { properties: props } = event;

	const questions: AskUserQuestion[] = props.questions.map((q) => ({
		question: q.question ?? "",
		header: q.header ?? "",
		options: (q.options ?? []).map((o) => ({
			label: o.label ?? "",
			description: o.description ?? "",
		})),
		multiSelect: q.multiple ?? false,
		custom: q.custom ?? true,
	}));

	return {
		type: "ask_user",
		toolId: props.id,
		questions,
		...(props.tool?.callID ? { toolUseId: props.tool.callID } : {}),
	};
}

/** Format a human-readable retry message with proper delay display */
function formatRetryMessage(
	reason: string,
	attempt: number,
	delayMs: number | undefined,
): string {
	if (!delayMs || delayMs <= 0) {
		return `${reason} (attempt ${attempt})`;
	}

	const delaySec = Math.round(delayMs / 1000);

	// Short delay (< 2 minutes): show relative seconds
	if (delaySec < 120) {
		return `${reason} (attempt ${attempt}, retrying in ${delaySec}s…)`;
	}

	// Medium delay (< 1 hour): show minutes
	if (delaySec < 3600) {
		const mins = Math.ceil(delaySec / 60);
		return `${reason} — resets in ~${mins}m`;
	}

	// Long delay (quota reset): show absolute date/time
	return `${reason} — quota resets ${formatResetTime(delayMs)}`;
}

/** Format a reset time as a human-readable string with date and timezone */
function formatResetTime(delayMs: number): string {
	const resetDate = new Date(Date.now() + delayMs);
	const now = new Date();

	const time = resetDate.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	// Include timezone abbreviation (e.g. "EST", "PST")
	const tz =
		resetDate
			.toLocaleTimeString([], { timeZoneName: "short" })
			.split(" ")
			.pop() ?? "";

	// Same calendar day → just time
	if (
		resetDate.getFullYear() === now.getFullYear() &&
		resetDate.getMonth() === now.getMonth() &&
		resetDate.getDate() === now.getDate()
	) {
		return `at ${time} ${tz}`;
	}

	// Tomorrow
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (
		resetDate.getFullYear() === tomorrow.getFullYear() &&
		resetDate.getMonth() === tomorrow.getMonth() &&
		resetDate.getDate() === tomorrow.getDate()
	) {
		return `tomorrow at ${time} ${tz}`;
	}

	// Further out → include weekday + date
	const dateStr = resetDate.toLocaleDateString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
	return `${dateStr} at ${time} ${tz}`;
}

/** Translate session.status event */
export function translateSessionStatus(
	event: OpenCodeEvent,
): RelayMessage | RelayMessage[] | null {
	if (!isSessionStatusEvent(event)) return null;
	const { properties: props } = event;
	const statusType = props.status?.type;

	// busy and idle are handled by the status poller (via notifySSEIdle).
	// Retry messages are still translated here for immediate user feedback.
	if (statusType === "retry") {
		const attempt = props.status?.attempt ?? 0;
		const reason = props.status?.message ?? "Retrying";
		// `next` is an absolute timestamp (ms since epoch) — compute relative delay
		const nextMs = props.status?.next;
		const delayMs =
			nextMs && nextMs > Date.now() ? nextMs - Date.now() : undefined;
		const retryMsg = formatRetryMessage(reason, attempt, delayMs);
		return { type: "error", code: "RETRY", message: retryMsg };
	}

	return null;
}

/** Translate message.created event → user_message (for TUI-originated messages) */
export function translateMessageCreated(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isMessageCreatedEvent(event)) return null;
	const { properties: props } = event;

	// OpenCode wraps message data under "info" or "message"
	const msg = props.info ?? props.message;
	if (!msg || msg.role !== "user") return null;

	// Extract text from the message parts
	const text = (msg.parts ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");

	if (!text) return null;

	return { type: "user_message", text };
}

/** Translate message.updated event (usage/cost data) */
export function translateMessageUpdated(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isMessageUpdatedEvent(event)) return null;
	// OpenCode sends message data under "info" (observed in live SSE events),
	// but we also support "message" for backward compatibility.
	const { properties: props } = event;

	const msg = props.info ?? props.message;
	if (!msg || msg.role !== "assistant") return null;

	return {
		type: "result",
		usage: {
			input: msg.tokens?.input ?? 0,
			output: msg.tokens?.output ?? 0,
			cache_read: msg.tokens?.cache?.read ?? 0,
			cache_creation: msg.tokens?.cache?.write ?? 0,
		},
		cost: msg.cost ?? 0,
		duration:
			msg.time?.completed && msg.time?.created
				? msg.time.completed - msg.time.created
				: 0,
		sessionId: props.sessionID ?? "",
	};
}

/** Translate message.part.removed event */
export function translatePartRemoved(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isPartRemovedEvent(event)) return null;
	const { properties: props } = event;

	return {
		type: "part_removed",
		partId: props.partID,
		messageId: props.messageID,
	};
}

/** Translate message.removed event */
export function translateMessageRemoved(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isMessageRemovedEvent(event)) return null;
	const { properties: props } = event;
	return { type: "message_removed", messageId: props.messageID };
}

/** Translate pty.* events */
export function translatePtyEvent(event: OpenCodeEvent): RelayMessage | null {
	if (!isPtyEvent(event)) return null;

	if (isPtyCreatedEvent(event)) {
		const props = event.properties;
		// OpenCode wraps pty info under an `info` key in the event properties
		const info = props.info ?? props;
		return {
			type: "pty_created",
			pty: {
				id: String(info.id ?? ""),
				title: String(info.title ?? ""),
				command: String(info.command ?? ""),
				cwd: String(info.cwd ?? ""),
				status: info.status === "exited" ? "exited" : "running",
				pid: Number(info.pid ?? 0),
			},
		};
	}

	if (isPtyExitedEvent(event)) {
		const props = event.properties;
		return {
			type: "pty_exited",
			ptyId: String(props.id ?? ""),
			exitCode: Number(props.exitCode ?? 0),
		};
	}

	if (isPtyDeletedEvent(event)) {
		const props = event.properties;
		return {
			type: "pty_deleted",
			ptyId: String(props.id ?? ""),
		};
	}

	return null;
}

/** Translate file.* events */
export function translateFileEvent(event: OpenCodeEvent): RelayMessage | null {
	// OpenCode uses `file` (not `path`) as the property name for file events
	if (!isFileEvent(event)) return null;
	const { properties: props } = event;

	if (event.type === "file.edited") {
		return { type: "file_changed", path: props.file, changeType: "edited" };
	}

	if (event.type === "file.watcher.updated") {
		return { type: "file_changed", path: props.file, changeType: "external" };
	}

	return null;
}

// ─── TranslateResult discriminated union ────────────────────────────────────

export type TranslateResult =
	| { ok: true; messages: RelayMessage[] }
	| { ok: false; reason: string };

/** Optional context passed to the translator (e.g. session scope). */
export interface TranslateContext {
	sessionId?: string | undefined;
}

/** Wrap a sub-translator return value into a TranslateResult */
function wrapResult(
	result: RelayMessage | RelayMessage[] | null,
	fallbackReason: string,
): TranslateResult {
	if (!result) return { ok: false, reason: fallbackReason };
	return { ok: true, messages: Array.isArray(result) ? result : [result] };
}

// ─── Stateful translator ────────────────────────────────────────────────────

export interface Translator {
	translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult;
	/** Clear tracked parts. If sessionId provided, only that session. If omitted, all sessions. */
	reset(sessionId?: string): void;
	/** Get tracked parts for a session (or the default/fallback session if no sessionId). */
	getSeenParts(
		sessionId?: string,
	): ReadonlyMap<string, { type: PartType; status?: ToolStatus }> | undefined;
	/** Rebuild part tracking from REST history for a specific session. */
	rebuildStateFromHistory(
		sessionId: string,
		messages: Array<{
			parts?: Array<{
				id: string;
				type: PartType;
				state?: { status?: ToolStatus };
			}>;
		}>,
	): void;
}

export function createTranslator(): Translator {
	const DEFAULT_SESSION = "__default__";
	const sessionParts = new Map<
		string,
		Map<string, { type: PartType; status?: ToolStatus }>
	>();

	function getOrCreateSessionParts(
		sessionId: string | undefined,
	): Map<string, { type: PartType; status?: ToolStatus }> {
		const key = sessionId ?? DEFAULT_SESSION;
		let parts = sessionParts.get(key);
		if (!parts) {
			parts = new Map();
			sessionParts.set(key, parts);
		}
		return parts;
	}

	return {
		translate(
			event: OpenCodeEvent,
			context?: TranslateContext,
		): TranslateResult {
			const eventType = event.type;
			const seenParts = getOrCreateSessionParts(context?.sessionId);

			// Part delta
			if (eventType === "message.part.delta") {
				return wrapResult(
					translatePartDelta(event, seenParts),
					"part delta: unknown field or untracked part",
				);
			}

			// Part updated (lifecycle tracking)
			if (eventType === "message.part.updated") {
				return wrapResult(
					handlePartUpdated(event, seenParts),
					"part updated: no translatable change",
				);
			}

			// Part removed
			if (eventType === "message.part.removed") {
				if (isPartRemovedEvent(event)) {
					seenParts.delete(event.properties.partID);
				}
				return wrapResult(
					translatePartRemoved(event),
					"part removed: not a valid part event",
				);
			}

			// Message created (user messages from TUI)
			if (eventType === "message.created") {
				return wrapResult(
					translateMessageCreated(event),
					"message created: not a user message or no text",
				);
			}

			// Message updated (cost/tokens)
			if (eventType === "message.updated") {
				return wrapResult(
					translateMessageUpdated(event),
					"message updated: not an assistant message",
				);
			}

			// Message removed
			if (eventType === "message.removed") {
				if (isMessageRemovedEvent(event)) {
					// Clear all parts for this message
					// We'd need message→part mapping, but for now just let the map grow
					// Real impl would track messageID→partIDs
				}
				return wrapResult(
					translateMessageRemoved(event),
					"message removed: invalid event",
				);
			}

			// Session status
			if (eventType === "session.status") {
				return wrapResult(
					translateSessionStatus(event),
					"session status: unhandled status type",
				);
			}

			// Permission
			if (eventType === "permission.asked") {
				return wrapResult(
					translatePermission(event, context?.sessionId),
					context?.sessionId
						? "permission asked: invalid event"
						: "permission asked: no sessionId in context",
				);
			}

			// Question
			if (eventType === "question.asked") {
				return wrapResult(
					translateQuestion(event),
					"question asked: invalid event",
				);
			}

			// PTY events
			if (eventType.startsWith("pty.")) {
				return wrapResult(
					translatePtyEvent(event),
					"pty event: unhandled pty event type",
				);
			}

			// File events
			if (eventType.startsWith("file.")) {
				return wrapResult(
					translateFileEvent(event),
					"file event: unhandled file event type",
				);
			}

			// Session error (quota exhausted, model failure, etc.)
			if (eventType === "session.error") {
				if (!isSessionErrorEvent(event)) {
					return { ok: false, reason: "session error: invalid event" };
				}
				const errName = event.properties.error?.name ?? "Unknown";
				const errMsg =
					event.properties.error?.data?.message ?? "An error occurred";
				return {
					ok: true,
					messages: [{ type: "error", code: errName, message: errMsg }],
				};
			}

			// Installation update available
			if (eventType === "installation.update-available") {
				if (!isInstallationUpdateEvent(event)) {
					return {
						ok: false,
						reason: "installation update: invalid event",
					};
				}
				const version = event.properties.version;
				return {
					ok: true,
					messages: [
						{
							type: "update_available",
							...(version != null && { version }),
						},
					],
				};
			}

			// Todo updated
			if (eventType === "todo.updated") {
				if (!isTodoUpdatedEvent(event)) {
					return { ok: false, reason: "todo updated: invalid event" };
				}
				const items: TodoItem[] = (event.properties.todos ?? []).map(
					(t, i) => ({
						id: `todo-${i}`,
						subject: t.content,
						status: (t.status as TodoStatus) ?? "pending",
					}),
				);
				return { ok: true, messages: [{ type: "todo_state", items }] };
			}

			// Known event types handled by bridge/SSE wiring, not translator
			if (
				eventType === "permission.replied" ||
				eventType === "session.updated"
			) {
				return {
					ok: false,
					reason: `${eventType} handled by bridge`,
				};
			}

			// Unknown event type
			return {
				ok: false,
				reason: `unhandled event type: ${eventType}`,
			};
		},

		reset(sessionId?: string) {
			if (sessionId != null) {
				sessionParts.delete(sessionId);
			} else {
				sessionParts.clear();
			}
		},

		getSeenParts(sessionId?: string) {
			return sessionParts.get(sessionId ?? DEFAULT_SESSION);
		},

		rebuildStateFromHistory(
			sessionId: string,
			messages: Array<{
				parts?: Array<{
					id: string;
					type: PartType;
					state?: { status?: ToolStatus };
				}>;
			}>,
		) {
			const parts = getOrCreateSessionParts(sessionId);
			parts.clear();
			for (const msg of messages) {
				for (const part of msg.parts ?? []) {
					parts.set(part.id, {
						type: part.type,
						...(part.state?.status != null && { status: part.state.status }),
					});
				}
			}
		},
	};
}

/**
 * Rebuild translator state from REST API messages.
 * Fetches messages for the given session and populates the translator's
 * seenParts map so it knows which parts already exist (prevents duplicate
 * tool_start/thinking_start on session switch or SSE reconnection).
 */
export async function rebuildTranslatorFromHistory<
	M extends {
		parts?: Array<{ id: string; type: string; [key: string]: unknown }>;
	},
>(
	translator: Translator,
	getMessages: (sessionId: string) => Promise<M[]>,
	sessionId: string,
	log: { warn(...args: unknown[]): void },
): Promise<M[] | undefined> {
	try {
		const messages = await getMessages(sessionId);
		const parts = messages.map((m) => {
			const rawParts = (m as { parts?: unknown[] }).parts as
				| Array<{ id: string; type: PartType; state?: { status?: ToolStatus } }>
				| undefined;
			return rawParts != null ? { parts: rawParts } : {};
		});
		translator.rebuildStateFromHistory(sessionId, parts);
		return messages;
	} catch (err) {
		log.warn(
			`rebuildStateFromHistory failed for ${sessionId}: ${err instanceof Error ? err.message : err}`,
		);
		return undefined;
	}
}

/**
 * FIFO eviction: if seenParts exceeds the max cap, delete the oldest entries.
 * Map preserves insertion order, so iterating keys() yields oldest first.
 */
function evictOldestIfNeeded(
	seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
): void {
	if (seenParts.size <= SEEN_PARTS_MAX) return;
	let evicted = 0;
	for (const key of seenParts.keys()) {
		if (evicted >= SEEN_PARTS_EVICT_COUNT) break;
		seenParts.delete(key);
		evicted++;
	}
}

function handlePartUpdated(
	event: OpenCodeEvent,
	seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
): RelayMessage | RelayMessage[] | null {
	if (!isPartUpdatedEvent(event)) return null;
	const { properties: props } = event;

	const rawPart = props.part;
	if (!rawPart?.type) return null;

	// After the guard we know type is defined; bind it for downstream functions
	const partType = rawPart.type;
	const part = { ...rawPart, type: partType };

	// OpenCode puts part ID in properties.part.id, not properties.partID
	const partID = props.partID ?? part.id ?? "";

	const messageId = props.messageID;
	const isNew = !seenParts.has(partID);

	// Track the part
	seenParts.set(partID, {
		type: part.type,
		...(part.state?.status != null && { status: part.state.status }),
	});
	evictOldestIfNeeded(seenParts);

	// Reasoning lifecycle
	if (part.type === "reasoning") {
		return translateReasoningPartUpdated(part, isNew, messageId);
	}

	// Tool lifecycle
	if (part.type === "tool") {
		return translateToolPartUpdated(partID, part, isNew, messageId);
	}

	// Text parts — first update of a text part could emit delta info
	// but typically text is streamed via deltas not part.updated
	return null;
}
