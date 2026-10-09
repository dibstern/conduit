// Translates OpenCode SSE events → relay WebSocket messages.
// Stateful: tracks seen parts for lifecycle detection.

import type { UntaggedRelayMessage } from "../shared-types.js";
import type { PartType, RelayMessage, ToolName, ToolStatus } from "../types.js";
import type { KnownOpenCodeEventType, SSEEvent } from "./opencode-events.js";
import {
	isMessageCreatedEvent,
	isMessageRemovedEvent,
	isMessageUpdatedEvent,
	isPartDeltaEvent,
	isPartRemovedEvent,
	isPartUpdatedEvent,
	isSessionErrorEvent,
	isSessionStatusEvent,
	sessionErrorText,
} from "./opencode-events.js";

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
	| "pty.created"
	| "pty.exited"
	| "pty.deleted"
	| "todo.updated";

// Approvals reach the browser through the approvals subscription (ni8.9).
type _HandledByBridge =
	| "permission.asked"
	| "permission.replied"
	| "question.asked";

// Known upstream events conduit deliberately drops: nothing in the UI consumes
// file-change or OpenCode-installation-update notices.
type _DeliberatelyIgnored =
	| "file.edited"
	| "file.watcher.updated"
	| "installation.update-available";

type _MissingTypes = Exclude<
	KnownOpenCodeEventType,
	_HandledByTranslator | _HandledByBridge | _DeliberatelyIgnored
>;
type _AssertAllHandled = _MissingTypes extends never
	? true
	: { error: "Unhandled event type(s)"; types: _MissingTypes };
const _exhaustiveCheck: _AssertAllHandled = true;

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

/** Translate message.part.delta → delta or thinking_delta */
export function translatePartDelta(
	event: SSEEvent,
	seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
): UntaggedRelayMessage | null {
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
				partId: props.partID,
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
		partId: props.partID,
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
): UntaggedRelayMessage | UntaggedRelayMessage[] | null {
	if (part.type !== "tool") return null;

	const status = part.state?.status;
	const toolName = mapToolName(part.tool ?? "");
	const callID = part.callID ?? partID;

	if (isNew && status === "pending") {
		return {
			type: "tool_start",
			id: callID,
			name: toolName,
			...(messageId != null && { messageId }),
		};
	}

	if (isNew && status === "running") {
		return {
			type: "tool_start",
			id: callID,
			name: toolName,
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
): UntaggedRelayMessage | null {
	if (part.type !== "reasoning") return null;

	if (isNew) {
		return { type: "thinking_start", ...(messageId != null && { messageId }) };
	}

	return null;
}

/** Format a human-readable retry message with proper delay display */
export function formatRetryMessage(
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
	event: SSEEvent,
): UntaggedRelayMessage | UntaggedRelayMessage[] | null {
	if (!isSessionStatusEvent(event)) return null;
	const { properties: props } = event;
	const statusType = props.status?.type;

	// Produce an internal completion signal for timeout and notification handling.
	// The monitoring chain also synthesizes done via notifySSEIdle → poller →
	// reducer, but that path is unreliable: it misses transitions when the
	// session completes faster than the poll interval, or when multiple turns
	// complete within a single busy period.  Direct translation ensures the
	// notifications are processed promptly for every idle transition.
	if (statusType === "idle") {
		return { type: "done", code: 0 };
	}

	// A retry is transient status on the session's shell row (C1).
	return null;
}

/** Translate message.created event → user_message (for TUI-originated messages) */
export function translateMessageCreated(
	event: SSEEvent,
): UntaggedRelayMessage | null {
	if (!isMessageCreatedEvent(event)) return null;
	const { properties: props } = event;

	// Like the other optional gap-event IDs, absence is tolerated but cannot create a bubble.
	if (!props.messageID) {
		console.debug("Skipping message.created without messageID");
		return null;
	}

	// OpenCode wraps message data under "info" or "message"
	const msg = props.info ?? props.message;
	if (!msg || msg.role !== "user") return null;

	// Extract text from the message parts
	const text = (msg.parts ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");

	if (!text) return null;

	return {
		type: "user_message",
		text,
		...(props.messageID != null ? { messageId: props.messageID } : {}),
	};
}

/** The part of an OpenCode assistant message a turn's bill is made from. */
interface OpenCodeStep {
	cost?: number;
	time?: { created?: number; completed?: number };
}

/**
 * OpenCode runs one turn as a chain of assistant messages, one per model step,
 * all answering the same user message (`parentID`). A step that finishes with
 * "tool-calls" or "unknown" hands straight to the next step; any other finish,
 * or an error, ends the turn. This mirrors OpenCode's own prompt-loop exit.
 */
export function endsOpenCodeTurn(step: {
	finish?: unknown;
	error?: unknown;
}): boolean {
	return (
		step.error != null ||
		(step.finish !== "tool-calls" && step.finish !== "unknown")
	);
}

/**
 * A whole turn's bill: every step's cost, and the time from its first step
 * starting to `last` completing. OpenCode prices each step on its own.
 */
export function openCodeTurnTotals(
	last: OpenCodeStep,
	steps: Iterable<OpenCodeStep>,
): { cost: number; duration: number } {
	let cost = 0;
	let start = last.time?.created;
	for (const step of steps) {
		cost += step.cost ?? 0;
		const created = step.time?.created;
		if (created != null && (start == null || created < start)) start = created;
	}
	const end = last.time?.completed;
	return { cost, duration: end != null && start != null ? end - start : 0 };
}

/**
 * Translate message.updated into the turn's result. Only a completed step has
 * final numbers, and only the step that ends the turn closes it; an earlier
 * step still reports its usage, marked `midTurn`, for the context meter.
 *
 * @param turnSteps  Every step of this turn seen so far, including this one.
 */
export function translateMessageUpdated(
	event: SSEEvent,
	turnSteps?: Iterable<OpenCodeStep>,
): Extract<RelayMessage, { type: "result" }> | null {
	if (!isMessageUpdatedEvent(event)) return null;
	// OpenCode sends message data under "info" (observed in live SSE events),
	// but we also support "message" for backward compatibility.
	const { properties: props } = event;

	const msg = props.info ?? props.message;
	if (!msg || msg.role !== "assistant" || msg.time?.completed == null) {
		return null;
	}

	const messageId = msg.id;
	return {
		type: "result",
		usage: {
			input: msg.tokens?.input ?? 0,
			output: msg.tokens?.output ?? 0,
			cache_read: msg.tokens?.cache?.read ?? 0,
			cache_creation: msg.tokens?.cache?.write ?? 0,
			...(msg.tokens?.contextWindow
				? { context_window: msg.tokens.contextWindow }
				: {}),
		},
		...openCodeTurnTotals(msg, turnSteps ?? [msg]),
		sessionId: props.sessionID ?? "",
		...(messageId != null && { messageId }),
		...(!endsOpenCodeTurn(msg) && { midTurn: true as const }),
	};
}

/** Translate message.part.removed event */
export function translatePartRemoved(
	event: SSEEvent,
): UntaggedRelayMessage | null {
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
	event: SSEEvent,
): UntaggedRelayMessage | null {
	if (!isMessageRemovedEvent(event)) return null;
	const { properties: props } = event;
	return { type: "message_removed", messageId: props.messageID };
}

export type TranslateResult =
	| { ok: true; messages: UntaggedRelayMessage[] }
	| { ok: false; reason: string };

/** Optional context passed to the translator (e.g. session scope). */
export interface TranslateContext {
	sessionId?: string | undefined;
}

/** Wrap a sub-translator return value into a TranslateResult */
function wrapResult(
	result: UntaggedRelayMessage | UntaggedRelayMessage[] | null,
	fallbackReason: string,
): TranslateResult {
	if (!result) return { ok: false, reason: fallbackReason };
	return { ok: true, messages: Array.isArray(result) ? result : [result] };
}

export interface Translator {
	translate(event: SSEEvent, context?: TranslateContext): TranslateResult;
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

	// Each session's turn in flight: the user message it answers, and its steps.
	const sessionTurns = new Map<
		string,
		{ parentID: string; steps: Map<string, OpenCodeStep> }
	>();

	/** Record an assistant step against its turn; returns the turn's steps. */
	function recordTurnStep(event: SSEEvent): Iterable<OpenCodeStep> | undefined {
		if (!isMessageUpdatedEvent(event)) return undefined;
		const msg = event.properties.info ?? event.properties.message;
		if (msg?.role !== "assistant" || msg.id == null || msg.parentID == null) {
			return undefined;
		}
		// OpenCode puts the session on the message itself, not on the event.
		const key = msg.sessionID ?? event.properties.sessionID ?? DEFAULT_SESSION;
		let turn = sessionTurns.get(key);
		if (turn?.parentID !== msg.parentID) {
			turn = { parentID: msg.parentID, steps: new Map() };
			sessionTurns.set(key, turn);
		}
		turn.steps.set(msg.id, msg);
		return turn.steps.values();
	}

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
		translate(event: SSEEvent, context?: TranslateContext): TranslateResult {
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
					"message created: missing id, not a user message, or no text",
				);
			}

			// Message updated (cost/tokens)
			if (eventType === "message.updated") {
				return wrapResult(
					translateMessageUpdated(event, recordTurnStep(event)),
					"message updated: not an assistant message, or still running",
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

			// Terminals stream from the relay's PtyManager through the project's
			// PTY subscription (conduit-test-ni8.11), not from OpenCode's SSE.
			if (eventType.startsWith("pty.")) {
				return {
					ok: false,
					reason: `${eventType} served by SubscribePtys`,
				};
			}

			// Session error (quota exhausted, model failure, etc.)
			if (eventType === "session.error") {
				if (!isSessionErrorEvent(event)) {
					return { ok: false, reason: "session error: invalid event" };
				}
				const errMsg = sessionErrorText(event.properties.error);
				return {
					ok: true,
					messages: [
						{
							type: "done",
							code: 1,
							error: errMsg,
							alertId: crypto.randomUUID(),
						},
					],
				};
			}

			// The todo list is projected from the TodoWrite tool part and served
			// by the session's todo subscription (conduit-test-ni8.10).
			if (eventType === "todo.updated") {
				return {
					ok: false,
					reason: "todo.updated served by SubscribeSessionTodos",
				};
			}

			// Known event types handled by bridge/SSE wiring, not translator
			if (
				eventType === "permission.asked" ||
				eventType === "permission.replied" ||
				eventType === "question.asked" ||
				eventType === "session.updated"
			) {
				return {
					ok: false,
					reason: `${eventType} handled by bridge`,
				};
			}

			if (
				eventType === "file.edited" ||
				eventType === "file.watcher.updated" ||
				eventType === "installation.update-available"
			) {
				return { ok: false, reason: `${eventType} deliberately ignored` };
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
				sessionTurns.delete(sessionId);
			} else {
				sessionParts.clear();
				sessionTurns.clear();
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
 * Rebuild translator state from REST API messages, surfacing fetch/rebuild
 * failures to the caller.
 * Fetches messages for the given session and populates the translator's
 * seenParts map so it knows which parts already exist (prevents duplicate
 * tool_start/thinking_start on session switch or SSE reconnection).
 */
export async function rebuildTranslatorFromHistoryOrThrow<
	M extends {
		parts?: Array<{ id: string; type: string; [key: string]: unknown }>;
	},
>(
	translator: Translator,
	getMessages: (sessionId: string) => Promise<M[] | undefined>,
	sessionId: string,
): Promise<M[] | undefined> {
	const messages = await getMessages(sessionId);
	if (messages === undefined) return undefined;

	const parts = messages.map((m) => {
		const rawParts = (m as { parts?: unknown[] }).parts as
			| Array<{ id: string; type: PartType; state?: { status?: ToolStatus } }>
			| undefined;
		return rawParts != null ? { parts: rawParts } : {};
	});
	translator.rebuildStateFromHistory(sessionId, parts);
	return messages;
}

/**
 * Legacy imperative wrapper: rebuild failures are logged and represented as
 * undefined so existing callback-based callers keep their historical behavior.
 */
export async function rebuildTranslatorFromHistory<
	M extends {
		parts?: Array<{ id: string; type: string; [key: string]: unknown }>;
	},
>(
	translator: Translator,
	getMessages: (sessionId: string) => Promise<M[] | undefined>,
	sessionId: string,
	log: { warn(...args: unknown[]): void },
): Promise<M[] | undefined> {
	try {
		return await rebuildTranslatorFromHistoryOrThrow(
			translator,
			getMessages,
			sessionId,
		);
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
	event: SSEEvent,
	seenParts: Map<string, { type: PartType; status?: ToolStatus }>,
): UntaggedRelayMessage | UntaggedRelayMessage[] | null {
	if (!isPartUpdatedEvent(event)) return null;
	const { properties: props } = event;

	const rawPart = props.part;
	if (!rawPart?.type) return null;

	// After the guard we know type is defined; bind it for downstream functions
	const partType = rawPart.type;
	const part = { ...rawPart, type: partType };

	// OpenCode puts part ID in properties.part.id, not properties.partID
	const partID = props.partID ?? part.id ?? "";

	// Likewise the message id lives on the part (Part.messageID), not top-level.
	const messageId = part.messageID ?? props.messageID;
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
