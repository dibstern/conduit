// ─── Message Poller (REST Polling Fallback) ──────────────────────────────────
// Polls GET /session/{id}/message to synthesize streaming events for sessions
// where SSE events aren't available (CLI/TUI-initiated sessions).
//
// When the active session is busy but no SSE events are arriving, this poller
// fetches messages via REST, diffs against previous state, and emits synthetic
// RelayMessages (delta, tool_start, tool_executing, tool_result, thinking_*,
// result, done, etc.) that feed into the same cache + broadcast pipeline.

import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Message } from "../instance/sdk-types.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { RelayMessage } from "../types.js";
import { mapToolName } from "./event-translator.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Polling interval when actively polling messages. */
const POLL_INTERVAL_MS = 750;

/** How long to wait after the last SSE event before starting REST polling. */
const SSE_SILENCE_THRESHOLD_MS = 2000;

/**
 * How long to poll with no new content before auto-stopping.
 * Prevents indefinite 750ms polling for truly idle sessions.
 * The poller can be restarted by calling startPolling() again.
 */
const IDLE_TIMEOUT_MS = 5000;

// ─── Part Snapshot ───────────────────────────────────────────────────────────

export interface PartSnapshot {
	type: string;
	/** For text/reasoning parts: last-seen text length */
	textLength: number;
	/** For text/reasoning parts: full text (needed for diff) */
	text: string;
	/** For tool parts: last-seen status */
	toolStatus?: string;
	/** For tool parts: whether we emitted tool_executing */
	emittedExecuting: boolean;
	/** For tool parts: whether we emitted tool_result */
	emittedResult: boolean;
	/** For reasoning parts: whether we emitted thinking_stop */
	emittedStop: boolean;
	/** Tool name (mapped) */
	toolName?: string;
	/** Tool callID or part id */
	callID?: string;
}

export interface MessageSnapshot {
	id: string;
	role: string;
	parts: Map<string, PartSnapshot>;
	/** Whether we already emitted a result event for this message */
	emittedResult: boolean;
}

// ─── Extracted Pure Functions ────────────────────────────────────────────────

/**
 * Synthesize delta events for text and reasoning parts.
 * Text parts only grow (append-only), so we emit the new suffix.
 */
export function synthesizeTextPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	events: RelayMessage[],
	messageId: string,
	deltaType: "delta" | "thinking_delta",
): void {
	const currentText = (part["text"] as string) ?? "";
	const prevLength = snap.textLength;

	// New reasoning part → emit thinking_start
	if (deltaType === "thinking_delta" && prevLength === 0 && currentText) {
		events.push({ type: "thinking_start", messageId });
	}

	// Emit new text as delta
	if (currentText.length > prevLength) {
		const newText = currentText.slice(prevLength);
		events.push({ type: deltaType, text: newText, messageId });
	}

	// Check if reasoning is done (has end time)
	if (deltaType === "thinking_delta" && !snap.emittedStop) {
		const time = part["time"] as { start?: number; end?: number } | undefined;
		if (
			time?.end !== undefined &&
			time.end !== null &&
			currentText.length > 0
		) {
			// Emit thinking_stop when the reasoning part is complete:
			// - First pass (prevLength === 0): part already finished, emit immediately.
			//   Without this, thinking_stop is deferred to the next poll cycle because
			//   the old condition (snap.textLength > 0) is always false on first pass.
			// - Subsequent passes: only emit when text has settled (no new content),
			//   to avoid premature stop while the part is still streaming.
			if (prevLength === 0 || currentText.length === prevLength) {
				events.push({ type: "thinking_stop", messageId });
				snap.emittedStop = true;
			}
		}
	}

	snap.textLength = currentText.length;
	snap.text = currentText;
}

/**
 * Synthesize events for tool parts based on status transitions.
 */
export function synthesizeToolPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	prev: PartSnapshot | null,
	events: RelayMessage[],
	messageId: string,
): void {
	const state = part["state"] as
		| {
				status?: string;
				input?: unknown;
				output?: string;
				error?: string;
				metadata?: Record<string, unknown>;
		  }
		| undefined;
	const status = state?.status;
	const metadata = state?.metadata;
	const toolName = mapToolName((part["tool"] as string) ?? "");
	const callID = (part["callID"] as string) ?? part.id;

	snap.toolName = toolName;
	snap.callID = callID;
	if (status != null) {
		snap.toolStatus = status;
	}

	const isNew = !prev;
	const prevStatus = prev?.toolStatus;

	// New tool part with pending status → tool_start
	if (isNew && (status === "pending" || status === "running")) {
		events.push({
			type: "tool_start",
			id: callID,
			name: toolName,
			messageId,
		});
	}

	// Transition to running → tool_executing (only once)
	if (status === "running" && !snap.emittedExecuting) {
		// If we missed the pending state, emit tool_start first
		if (isNew || (!prev?.emittedExecuting && prevStatus !== "pending")) {
			if (!isNew || status !== "running") {
				// Already emitted tool_start above for new parts
			}
		}
		events.push({
			type: "tool_executing",
			id: callID,
			name: toolName,
			input: state?.input as Record<string, unknown> | undefined,
			...(metadata != null && { metadata }),
			messageId,
		});
		snap.emittedExecuting = true;
	}

	// Transition to completed/error → tool_result (only once)
	if ((status === "completed" || status === "error") && !snap.emittedResult) {
		// If we missed previous states, emit tool_start + tool_executing first
		if (!prev) {
			events.push({
				type: "tool_start",
				id: callID,
				name: toolName,
				messageId,
			});
		}
		if (!snap.emittedExecuting) {
			events.push({
				type: "tool_executing",
				id: callID,
				name: toolName,
				input: state?.input as Record<string, unknown> | undefined,
				...(metadata != null && { metadata }),
				messageId,
			});
			snap.emittedExecuting = true;
		}

		const isError = status === "error";
		events.push({
			type: "tool_result",
			id: callID,
			content: isError
				? (state?.error ?? "Unknown error")
				: (state?.output ?? ""),
			is_error: isError,
			messageId,
		});
		snap.emittedResult = true;
	}
}

/**
 * Synthesize events for a single message part by comparing against previous state.
 */
export function synthesizePartEvents(
	part: { id: string; type: string; [key: string]: unknown },
	prev: PartSnapshot | null,
	messageId: string,
): { events: RelayMessage[]; snapshot: PartSnapshot } {
	const events: RelayMessage[] = [];
	const partType = part.type;

	// Build current snapshot
	const snap: PartSnapshot = {
		type: partType,
		textLength: prev?.textLength ?? 0,
		text: prev?.text ?? "",
		...(prev?.toolStatus != null && { toolStatus: prev.toolStatus }),
		emittedExecuting: prev?.emittedExecuting ?? false,
		emittedResult: prev?.emittedResult ?? false,
		emittedStop: prev?.emittedStop ?? false,
		...(prev?.toolName != null && { toolName: prev.toolName }),
		...(prev?.callID != null && { callID: prev.callID }),
	};

	if (partType === "text") {
		synthesizeTextPart(part, snap, events, messageId, "delta");
	} else if (partType === "reasoning") {
		synthesizeTextPart(part, snap, events, messageId, "thinking_delta");
	} else if (partType === "tool") {
		synthesizeToolPart(part, snap, prev, events, messageId);
	}
	// Other part types (step_start, step_finish, snapshot, agent) are skipped
	// — they have no visual representation in the relay UI.

	return { events, snapshot: snap };
}

/** Extract text from a user message's parts. */
function extractUserText(msg: Message): string {
	if (!msg.parts) return "";
	return msg.parts
		.filter((p) => p.type === "text")
		.map((p) => (p["text"] as string) ?? "")
		.join("\n");
}

/**
 * Synthesize a result event from an assistant message's cost/token metadata.
 * Only emits when the message has been completed (has cost or token data).
 */
function synthesizeResultEvent(msg: Message): RelayMessage | null {
	const hasCost = msg.cost !== undefined && msg.cost > 0;
	const hasTokens =
		msg.tokens?.input !== undefined || msg.tokens?.output !== undefined;

	if (!hasCost && !hasTokens) return null;

	const duration =
		msg.time?.created !== undefined && msg.time?.completed !== undefined
			? msg.time.completed - msg.time.created
			: 0;

	return {
		type: "result",
		usage: {
			input: msg.tokens?.input ?? 0,
			output: msg.tokens?.output ?? 0,
			cache_read: msg.tokens?.cache?.read ?? 0,
			cache_creation: msg.tokens?.cache?.write ?? 0,
		},
		cost: msg.cost ?? 0,
		duration,
		sessionId: msg.sessionID,
		...(msg.id != null && { messageId: msg.id }),
	};
}

/**
 * Compare current messages against previous snapshot, synthesize events
 * for any changes detected. Pure function — returns new snapshot instead
 * of mutating state.
 */
export function diffAndSynthesize(
	previousSnapshot: Map<string, MessageSnapshot>,
	messages: Message[],
): { events: RelayMessage[]; newSnapshot: Map<string, MessageSnapshot> } {
	const events: RelayMessage[] = [];
	const newSnapshot = new Map<string, MessageSnapshot>();

	for (const msg of messages) {
		const msgId = msg.id;
		const prevMsg = previousSnapshot.get(msgId);

		const msgSnap: MessageSnapshot = {
			id: msgId,
			role: msg.role,
			parts: new Map(),
			emittedResult: prevMsg?.emittedResult ?? false,
		};

		// Handle user messages we haven't seen before
		if (!prevMsg && msg.role === "user") {
			const text = extractUserText(msg);
			if (text) {
				events.push({ type: "user_message", text });
			}
		}

		// Process each part (skip user messages — their text is already
		// handled above as a user_message event, and synthesizePartEvents
		// would incorrectly emit delta events for user text parts, which
		// the client appends to the current assistant message).
		if (msg.role !== "user") {
			for (const part of msg.parts ?? []) {
				const partId = part.id;
				const prevPart = prevMsg?.parts.get(partId);

				const synthesized = synthesizePartEvents(part, prevPart ?? null, msgId);
				events.push(...synthesized.events);
				msgSnap.parts.set(partId, synthesized.snapshot);
			}
		}

		// Emit result event for assistant messages with cost/token info
		if (msg.role === "assistant" && !msgSnap.emittedResult) {
			const resultEvent = synthesizeResultEvent(msg);
			if (resultEvent) {
				events.push(resultEvent);
				msgSnap.emittedResult = true;
			}
		}

		newSnapshot.set(msgId, msgSnap);
	}

	return { events, newSnapshot };
}

/**
 * Build the initial snapshot baseline from existing messages.
 * Returns the snapshot map instead of assigning to instance state.
 *
 * Walks each message's parts and records them as if they were already
 * seen in a previous poll cycle — marking text lengths, tool statuses,
 * and result emission flags so diffAndSynthesize() skips them.
 */
export function buildSeedSnapshot(
	messages: Message[],
): Map<string, MessageSnapshot> {
	const snapshot = new Map<string, MessageSnapshot>();

	for (const msg of messages) {
		const msgSnap: MessageSnapshot = {
			id: msg.id,
			role: msg.role,
			parts: new Map(),
			// Mark result as already emitted if the message has cost/token data
			emittedResult:
				(msg.cost !== undefined && msg.cost > 0) ||
				msg.tokens?.input !== undefined ||
				msg.tokens?.output !== undefined,
		};

		for (const part of msg.parts ?? []) {
			const partType = part.type;
			const snap: PartSnapshot = {
				type: partType,
				textLength: 0,
				text: "",
				emittedExecuting: false,
				emittedResult: false,
				emittedStop: false,
			};

			if (partType === "text" || partType === "reasoning") {
				const text = (part["text"] as string) ?? "";
				snap.textLength = text.length;
				snap.text = text;
				// For reasoning parts, mark thinking_stop as already emitted if
				// the part has an end time (it's already completed)
				if (partType === "reasoning") {
					const time = part["time"] as
						| { start?: number; end?: number }
						| undefined;
					if (time?.end !== undefined && time.end !== null) {
						snap.emittedStop = true;
					}
				}
			} else if (partType === "tool") {
				const state = part["state"] as
					| {
							status?: string;
							input?: unknown;
							output?: string;
							error?: string;
					  }
					| undefined;
				const status = state?.status;
				snap.toolName = mapToolName((part["tool"] as string) ?? "");
				snap.callID = (part["callID"] as string) ?? part.id;
				if (status != null) {
					snap.toolStatus = status;
				}
				// Mark lifecycle events as already emitted based on current status
				if (
					status === "running" ||
					status === "completed" ||
					status === "error"
				) {
					snap.emittedExecuting = true;
				}
				if (status === "completed" || status === "error") {
					snap.emittedResult = true;
				}
			}

			msgSnap.parts.set(part.id, snap);
		}

		snapshot.set(msg.id, msgSnap);
	}

	return snapshot;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessagePollerOptions {
	client: Pick<OpenCodeAPI, "session">;
	/** Polling interval in milliseconds (default: 750) */
	interval?: number;
	log?: Logger;
	/**
	 * Optional callback checked before applying the idle timeout.
	 * When this returns true, the poller stays alive even without new
	 * content — used to keep polling while browser clients are viewing
	 * a session (e.g. TUI sessions where SSE events don't cross processes).
	 */
	hasViewers?: () => boolean;
}

export type MessagePollerEvents = {
	/** Emitted with synthesized streaming events from REST diff */
	events: [messages: RelayMessage[]];
};

// ─── Poller ──────────────────────────────────────────────────────────────────

export class MessagePoller extends TrackedService<MessagePollerEvents> {
	private readonly client: Pick<OpenCodeAPI, "session">;
	private readonly interval: number;
	private readonly log: Logger;
	private readonly hasViewers: (() => boolean) | undefined;

	private timer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private activeSessionId: string | null = null;
	private previousSnapshot: Map<string, MessageSnapshot> = new Map();

	/** Timestamp of the last SSE event for the active session */
	private lastSSEEventAt = 0;

	/** Timestamp of the last poll that found new content */
	private lastContentAt = 0;

	/**
	 * True when SSE events have been received since the last reseed.
	 * When the poller detects SSE silence after this flag is set, it
	 * reseeds the snapshot from the REST API to avoid re-synthesizing
	 * content that SSE already delivered.
	 */
	private needsReseed = false;

	/**
	 * True when startPolling() was called without seed messages.
	 * The first poll will seed the snapshot from REST instead of synthesizing,
	 * preventing duplicate events when the client already has cached history.
	 */
	private needsSeedOnFirstPoll = false;

	constructor(registry: ServiceRegistry, options: MessagePollerOptions) {
		super(registry);
		this.client = options.client;
		this.interval = options.interval ?? POLL_INTERVAL_MS;
		this.log = options.log ?? createSilentLogger();
		this.hasViewers = options.hasViewers;
	}

	// ─── Public API ────────────────────────────────────────────────────────

	/**
	 * Start polling messages for a session.
	 * Replaces any existing polling target.
	 *
	 * @param seedMessages  Optional array of existing messages to seed the
	 *   snapshot baseline. When provided, the poller builds its initial
	 *   `previousSnapshot` from these messages so it only emits events for
	 *   genuinely NEW content that appears after polling starts. This prevents
	 *   duplicate events when both SSE and the poller observe the same content.
	 */
	startPolling(sessionId: string, seedMessages?: Message[]): void {
		if (this.activeSessionId === sessionId && this.timer) return;

		this.stopPolling();
		this.activeSessionId = sessionId;
		this.previousSnapshot = new Map();
		this.lastSSEEventAt = 0;
		this.lastContentAt = Date.now(); // Grace period: treat start as "content" to avoid immediate timeout
		this.needsReseed = false;
		this.needsSeedOnFirstPoll = false;

		// Seed the snapshot from existing messages so the first poll doesn't
		// re-emit events for content that SSE already delivered.
		if (seedMessages && seedMessages.length > 0) {
			this.previousSnapshot = buildSeedSnapshot(seedMessages);
			this.log.info(
				`START session=${sessionId.slice(0, 12)} interval=${this.interval}ms seeded=${seedMessages.length} messages`,
			);
		} else {
			// No seed provided — first poll will build a baseline snapshot from
			// REST instead of synthesizing events. This prevents re-emitting
			// the entire history as duplicate events when the client already
			// has cached events from session_switched.
			this.needsSeedOnFirstPoll = true;
			this.log.info(
				`START session=${sessionId.slice(0, 12)} interval=${this.interval}ms`,
			);
		}

		this.timer = this.repeating(() => {
			this.tracked(this.poll());
		}, this.interval);

		// Immediate first poll
		this.tracked(this.poll());
	}

	/** Stop polling and clear state. */
	stopPolling(): void {
		if (this.timer) {
			this.clearTrackedTimer(this.timer);
			this.timer = null;
		}
		if (this.activeSessionId) {
			this.log.info(`STOP session=${this.activeSessionId.slice(0, 12)}`);
		}
		this.activeSessionId = null;
		this.previousSnapshot = new Map();
	}

	/** Whether we're actively polling a session. */
	isPolling(): boolean {
		return this.timer !== null;
	}

	/** Which session we're polling (if any). */
	getPollingSessionId(): string | null {
		return this.activeSessionId;
	}

	/**
	 * Notify the poller that an SSE event was received for a session.
	 * If SSE events are flowing, REST polling is unnecessary and will be suppressed.
	 */
	notifySSEEvent(sessionId: string): void {
		if (sessionId === this.activeSessionId) {
			this.lastSSEEventAt = Date.now();
			this.needsReseed = true;
		}
	}

	/**
	 * Check if SSE events are currently flowing for the active session.
	 * Returns true if we received an SSE event within the silence threshold.
	 */
	isSSEActive(): boolean {
		if (this.lastSSEEventAt === 0) return false;
		return Date.now() - this.lastSSEEventAt < SSE_SILENCE_THRESHOLD_MS;
	}

	/**
	 * Emit a done event for the session when it transitions to idle.
	 * Called externally by the status poller integration.
	 */
	emitDone(sessionId: string): void {
		if (sessionId !== this.activeSessionId) return;
		this.emit("events", [{ type: "done", code: 0 }]);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async poll(): Promise<void> {
		if (this.polling) {
			this.log.verbose(`poll skipped — previous poll still running`);
			return;
		}
		if (!this.activeSessionId) return;

		// If SSE events are flowing, skip REST polling
		if (this.isSSEActive()) {
			this.log.verbose(
				`poll skipped — SSE active for session=${this.activeSessionId?.slice(0, 12)}`,
			);
			return;
		}

		// Auto-stop if no content detected for IDLE_TIMEOUT_MS,
		// but only when no browser clients are viewing this session.
		// When viewers are present, keep polling so we can detect
		// activity from external processes (e.g. the OpenCode TUI).
		if (
			this.lastContentAt > 0 &&
			Date.now() - this.lastContentAt > IDLE_TIMEOUT_MS &&
			!this.hasViewers?.()
		) {
			this.log.info(
				`IDLE TIMEOUT session=${this.activeSessionId.slice(0, 12)} — auto-stopping`,
			);
			this.stopPolling();
			return;
		}

		this.polling = true;
		const sessionId = this.activeSessionId;

		try {
			const messages = await this.client.session.messages(sessionId);

			// ── Seed on first poll (no seed provided at startPolling) ──
			// Build a baseline snapshot from REST instead of synthesizing
			// events. Without this, the first poll with an empty snapshot
			// would re-emit the entire history as duplicate events.
			if (this.needsSeedOnFirstPoll) {
				this.needsSeedOnFirstPoll = false;
				this.previousSnapshot = buildSeedSnapshot(messages);
				this.log.info(
					`SEEDED session=${sessionId.slice(0, 12)} — first poll baseline (${messages.length} messages)`,
				);
				return; // Skip this cycle — snapshot is now current
			}

			// ── Reseed after SSE silence ─────────────────────────────────
			// When SSE was active (needsReseed=true) but has now gone silent,
			// reseed the snapshot from the REST API before diffing. This
			// prevents the poller from re-synthesizing content that SSE
			// already delivered to clients.
			if (this.needsReseed) {
				this.needsReseed = false;
				this.previousSnapshot = buildSeedSnapshot(messages);
				this.log.info(
					`RESEEDED session=${sessionId.slice(0, 12)} — SSE silence transition`,
				);
				return; // Skip this cycle — snapshot is now current
			}

			const events = this.doDiffAndSynthesize(sessionId, messages);

			if (events.length > 0) {
				this.lastContentAt = Date.now();
				this.log.info(
					`SYNTHESIZED session=${sessionId.slice(0, 12)} events=${events.length} types=[${events.map((e) => e.type).join(",")}]`,
				);
				this.emit("events", events);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log.warn(`poll failed: ${msg}`);
		} finally {
			this.polling = false;
		}
	}

	// ─── Diff + Synthesis ──────────────────────────────────────────────────

	private doDiffAndSynthesize(
		_sessionId: string,
		messages: Message[],
	): RelayMessage[] {
		const { events, newSnapshot } = diffAndSynthesize(
			this.previousSnapshot,
			messages,
		);
		this.previousSnapshot = newSnapshot;
		return events;
	}
}
