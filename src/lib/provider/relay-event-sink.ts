// ─── Relay Event Sink ────────────────────────────────────────────────────────
// Translates adapter-emitted CanonicalEvents into RelayMessages and pushes
// them straight to WebSocket clients. Used for the in-process Claude SDK path
// (ClaudeAdapter) where there is no SSE stream to piggy-back on. Permissions
// and questions are bridged through the same path so the UI receives the
// familiar RelayMessage shapes.

import { createLogger } from "../logger.js";
import type { CanonicalEvent, StoredEvent } from "../persistence/events.js";
import type { PermissionId } from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
import { createDeferred, type Deferred } from "./deferred.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

const log = createLogger("relay-event-sink");

// ─── Deps ───────────────────────────────────────────────────────────────────

export interface RelayEventSinkPersist {
	readonly eventStore: { append(event: CanonicalEvent): StoredEvent };
	readonly projectionRunner: { projectEvent(event: StoredEvent): void };
	readonly ensureSession: (sessionId: string) => void;
}

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly send: (msg: RelayMessage) => void;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
	/** Optional: permission bridge for tracking pending permissions (enables replay on session switch). */
	readonly permissionBridge?: {
		trackPending(entry: {
			requestId: PermissionId;
			sessionId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			always: string[];
			timestamp: number;
		}): void;
		/** Clean up the bridge entry when a permission is resolved. */
		onPermissionReplied(requestId: string): boolean;
	};
	/** Optional: question bridge for tracking pending questions (enables replay on session switch). */
	readonly questionBridge?: {
		trackPending(entry: {
			requestId: string;
			sessionId: string;
			questions: Array<{
				question: string;
				header?: string;
				options?: unknown[];
				multiSelect?: boolean;
			}>;
			toolCallId?: string;
			timestamp: number;
		}): void;
		/** Clean up the bridge entry when a question is resolved. */
		onResolved(requestId: string): boolean;
	};
}

export interface RelayEventSink extends EventSink {
	/** Resolve a pending permission request (from UI). */
	resolvePermission(requestId: string, response: PermissionResponse): void;
	/** Resolve a pending question request (from UI). */
	resolveQuestion(requestId: string, answers: Record<string, unknown>): void;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRelayEventSink(deps: RelayEventSinkDeps): RelayEventSink {
	const { sessionId, send, clearTimeout, resetTimeout, persist } = deps;

	const pendingPermissions = new Map<string, Deferred<PermissionResponse>>();
	const pendingQuestions = new Map<string, Deferred<Record<string, unknown>>>();

	function reset(): void {
		if (resetTimeout) resetTimeout();
	}

	function finish(): void {
		if (clearTimeout) clearTimeout();
	}

	return {
		async push(event: CanonicalEvent): Promise<void> {
			reset();
			// Persist to SQLite when available (before WS send for durability)
			if (persist) {
				try {
					persist.ensureSession(sessionId);
					const stored = persist.eventStore.append(event);
					persist.projectionRunner.projectEvent(stored);
				} catch (err) {
					// Non-fatal — same pattern as dual-write-hook.ts:149.
					// Covers: disk full, DB locked, projection recovery guard, etc.
					log.debug(
						`Persist failed for ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
					);
				}
			}
			const msg = translateCanonicalEvent(event);
			if (msg) {
				for (const raw of msg) {
					const m = tagWithSessionId(raw, sessionId);
					send(m);
					// Done is always terminal; errors are terminal except RETRY,
					// which is a non-terminal progress signal during API retries.
					const isTerminal =
						m.type === "done" || (m.type === "error" && m.code !== "RETRY");
					if (isTerminal) finish();
				}
			}
		},

		async requestPermission(
			request: PermissionRequest,
		): Promise<PermissionResponse> {
			reset();
			// Register with the permission bridge so this permission can be
			// replayed when the user switches sessions and comes back.
			if (deps.permissionBridge) {
				deps.permissionBridge.trackPending({
					requestId: request.requestId as PermissionId,
					sessionId,
					toolName: request.toolName,
					toolInput: request.toolInput as Record<string, unknown>,
					always: request.always ?? [],
					timestamp: Date.now(),
				});
			}
			send({
				type: "permission_request",
				sessionId,
				requestId: request.requestId as PermissionId,
				toolName: request.toolName,
				toolInput: request.toolInput,
				always: request.always ?? [],
			});
			const deferred = createDeferred<PermissionResponse>();
			pendingPermissions.set(request.requestId, deferred);
			return deferred.promise;
		},

		async requestQuestion(
			request: QuestionRequest,
		): Promise<Record<string, unknown>> {
			reset();
			// Register with the question bridge so this question can be
			// replayed when the user switches sessions and comes back.
			if (deps.questionBridge) {
				deps.questionBridge.trackPending({
					requestId: request.requestId,
					sessionId,
					questions: request.questions.map((q) => ({
						question: q.question,
						header: q.header,
						options: q.options,
						multiSelect: q.multiSelect ?? false,
					})),
					timestamp: Date.now(),
				});
			}
			send({
				type: "ask_user",
				sessionId,
				toolId: request.requestId,
				questions: request.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect ?? false,
					custom: q.custom ?? true,
				})),
			});
			const deferred = createDeferred<Record<string, unknown>>();
			pendingQuestions.set(request.requestId, deferred);
			return deferred.promise;
		},

		resolvePermission(requestId: string, response: PermissionResponse): void {
			const deferred = pendingPermissions.get(requestId);
			if (!deferred) {
				log.warn(
					`resolvePermission: no pending request ${requestId} (session=${sessionId})`,
				);
				return;
			}
			pendingPermissions.delete(requestId);
			// Clean up the bridge entry so it is no longer replayed on
			// session switch / reconnect.
			if (deps.permissionBridge) {
				deps.permissionBridge.onPermissionReplied(requestId);
			}
			deferred.resolve(response);
		},

		resolveQuestion(requestId: string, answers: Record<string, unknown>): void {
			const deferred = pendingQuestions.get(requestId);
			if (!deferred) {
				log.warn(
					`resolveQuestion: no pending request ${requestId} (session=${sessionId})`,
				);
				return;
			}
			pendingQuestions.delete(requestId);
			// Clean up the bridge entry so it is no longer replayed on
			// session switch / reconnect.
			if (deps.questionBridge) {
				deps.questionBridge.onResolved(requestId);
			}
			deferred.resolve(answers);
		},
	};
}

// ─── Translation ────────────────────────────────────────────────────────────
// Maps CanonicalEvent (adapter-emitted) → RelayMessage[] (client-facing).
// An event may produce zero, one, or many relay messages.

function translateCanonicalEvent(
	event: CanonicalEvent,
): import("../shared-types.js").UntaggedRelayMessage[] {
	switch (event.type) {
		case "text.delta":
			return [
				{
					type: "delta",
					text: event.data.text,
					messageId: event.data.messageId,
				},
			];

		case "thinking.start":
			return [{ type: "thinking_start", messageId: event.data.messageId }];

		case "thinking.delta":
			return [
				{
					type: "thinking_delta",
					text: event.data.text,
					messageId: event.data.messageId,
				},
			];

		case "thinking.end":
			return [{ type: "thinking_stop", messageId: event.data.messageId }];

		case "tool.started": {
			const { toolName, callId, input, messageId } = event.data;
			return [
				{
					type: "tool_start",
					id: callId,
					name: toolName,
					messageId,
				},
				{
					type: "tool_executing",
					id: callId,
					name: toolName,
					input: isRecord(input) ? input : undefined,
					messageId,
				},
			];
		}

		case "tool.running": {
			// No callId in ToolRunningPayload — pass partId as the best anchor.
			return [];
		}

		case "tool.input_updated": {
			// Claude SDK streams tool_use input via input_json_delta — the
			// initial tool.started event fires with `input: {}` and this
			// event carries the real parsed input once each delta parses.
			// Forward as tool_executing so the browser-side tool registry
			// merges the new input on the already-running tool entry.
			const { partId, input, messageId, toolName } = event.data;
			return [
				{
					type: "tool_executing",
					id: partId,
					name: toolName ?? "",
					input: isRecord(input) ? input : undefined,
					messageId,
				},
			];
		}

		case "tool.completed": {
			const { partId, result, messageId } = event.data;
			return [
				{
					type: "tool_result",
					id: partId,
					content: typeof result === "string" ? result : stringify(result),
					is_error: false,
					messageId,
				},
			];
		}

		case "turn.completed": {
			const { tokens, cost, duration } = event.data;
			const result: RelayMessage = {
				type: "result",
				usage: {
					input: tokens?.input ?? 0,
					output: tokens?.output ?? 0,
					cache_read: tokens?.cacheRead ?? 0,
					cache_creation: tokens?.cacheWrite ?? 0,
				},
				cost: cost ?? 0,
				duration: duration ?? 0,
				sessionId: event.sessionId,
			};
			return [result, { type: "done", code: 0 }];
		}

		case "turn.error": {
			const { error, code } = event.data;
			return [
				{
					type: "error",
					code: code ?? "TURN_ERROR",
					message: error,
				},
				{ type: "done", code: 1 },
			];
		}

		case "turn.interrupted":
			return [{ type: "done", code: 1 }];

		case "session.status":
			// status="retry" means the SDK is retrying a failed API call.
			// Surface it as a non-terminal error so the UI can show progress
			// (matching the OpenCode retry UX in event-translator.ts).
			if (event.data.status === "retry") {
				const reason =
					typeof event.metadata.correlationId === "string"
						? event.metadata.correlationId
						: "Retrying";
				return [{ type: "error", code: "RETRY", message: reason }];
			}
			// idle/busy/error statuses are informational here — the prompt handler
			// already sends "processing" and the terminal done/error events cover
			// the lifecycle, so we skip them to avoid duplicate signals.
			return [];

		case "message.created":
		case "session.created":
		case "session.renamed":
		case "session.provider_changed":
			return [];

		case "permission.asked":
		case "permission.resolved":
		case "question.asked":
		case "question.resolved":
			// Permission/question side-channel is handled via the
			// requestPermission/requestQuestion APIs on the sink — the adapter
			// should not push these as canonical events. Defensive no-op.
			return [];

		default:
			return [];
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringify(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
