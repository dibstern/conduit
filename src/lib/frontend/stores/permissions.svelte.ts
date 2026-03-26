// ─── Permissions Store ───────────────────────────────────────────────────────
// Pending permission requests and user questions.

import type {
	AskUserQuestion,
	PermissionRequest,
	QuestionRequest,
	RelayMessage,
} from "../types.js";
import { createFrontendLogger } from "../utils/logger.js";
import { dispatch } from "./notification-reducer.svelte.js";
import { sessionState } from "./session.svelte.js";

const log = createFrontendLogger("permissions");

// ─── State ──────────────────────────────────────────────────────────────────

export const permissionsState = $state({
	pendingPermissions: [] as (PermissionRequest & { id: string })[],
	pendingQuestions: [] as QuestionRequest[],
	/** Error messages for questions that could not be delivered, keyed by toolId. */
	questionErrors: new Map<string, string>(),
});

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the total number of pending items requiring user attention. */
export function getPendingCount(): number {
	return (
		permissionsState.pendingPermissions.length +
		permissionsState.pendingQuestions.length
	);
}

/** Get whether there are any pending permissions or questions. */
export function getHasPending(): boolean {
	return getPendingCount() > 0;
}

/**
 * Collect all descendant session IDs (children, grandchildren, etc.)
 * for a given session. Uses BFS over `sessionState.allSessions` which
 * includes `parentID` for subagent sessions.
 */
export function getDescendantSessionIds(parentId: string): Set<string> {
	const descendants = new Set<string>();
	const queue = [parentId];
	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: safe — queue.length > 0 guarantees shift returns a value
		const id = queue.shift()!;
		for (const s of sessionState.allSessions) {
			if (s.parentID === id && !descendants.has(s.id)) {
				descendants.add(s.id);
				queue.push(s.id);
			}
		}
	}
	return descendants;
}

/**
 * Permissions for the session the user is currently viewing → full PermissionCard.
 * Includes permissions from descendant (subagent) sessions so that when
 * viewing a parent session, its subagents' permission requests appear inline.
 * Also includes permissions with unknown session (sessionId="") since they
 * need human attention and have no better place to render.
 */
export function getLocalPermissions(
	currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
	if (!currentSessionId) return [];
	const descendants = getDescendantSessionIds(currentSessionId);
	return permissionsState.pendingPermissions.filter(
		(p) =>
			p.sessionId === currentSessionId ||
			descendants.has(p.sessionId) ||
			p.sessionId === "",
	);
}

/**
 * Permissions for OTHER sessions → notification component.
 * Excludes permissions from descendant (subagent) sessions of the
 * current session, since those appear inline via getLocalPermissions.
 * Also excludes unknown-session permissions (sessionId="") since
 * those are shown inline via getLocalPermissions.
 */
export function getRemotePermissions(
	currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
	if (!currentSessionId) return permissionsState.pendingPermissions;
	const descendants = getDescendantSessionIds(currentSessionId);
	return permissionsState.pendingPermissions.filter(
		(p) =>
			p.sessionId !== currentSessionId &&
			!descendants.has(p.sessionId) &&
			p.sessionId !== "",
	);
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Build the answer payload for a question response.
 *  Keys are numeric string indices ("0", "1", ...) — NOT the question text.
 */
export function buildAnswerPayload(
	selections: Map<number, string>,
	questions: AskUserQuestion[],
): Record<string, string> {
	const answers: Record<string, string> = {};
	for (const [idx, value] of selections) {
		if (idx < questions.length) {
			answers[String(idx)] = value;
		}
	}
	return answers;
}

/** Check if all questions can be auto-submitted (single option each). */
export function shouldAutoSubmit(questions: AskUserQuestion[]): boolean {
	return questions.every(
		(q) => q.options.length === 1 && !q.multiSelect && !q.custom,
	);
}

/** Check if all required questions have been answered. */
export function isValidSubmission(
	selections: Map<number, string>,
	questions: AskUserQuestion[],
): boolean {
	for (let i = 0; i < questions.length; i++) {
		if (!selections.has(i)) return false;
	}
	return true;
}

/** Format a question header for display. */
export function formatQuestionHeader(header: string): string {
	// Capitalize first letter
	if (!header) return "";
	return header.charAt(0).toUpperCase() + header.slice(1);
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handlePermissionRequest(
	msg: Extract<RelayMessage, { type: "permission_request" }>,
	_sendFn?: (data: Record<string, unknown>) => void,
): void {
	const { requestId, toolName, toolInput } = msg;

	if (!requestId || !toolName) return;

	const permission: PermissionRequest & { id: string } = {
		id: requestId,
		requestId,
		sessionId: msg.sessionId,
		toolName,
		toolInput,
		...(msg.always != null && { always: msg.always }),
	};

	permissionsState.pendingPermissions = [
		...permissionsState.pendingPermissions,
		permission,
	];
}

export function handlePermissionResolved(
	msg: Extract<RelayMessage, { type: "permission_resolved" }>,
): void {
	const { requestId } = msg;
	if (!requestId) return;

	permissionsState.pendingPermissions =
		permissionsState.pendingPermissions.filter(
			(p) => p.requestId !== requestId,
		);
}

export function handleAskUser(
	msg: Extract<RelayMessage, { type: "ask_user" }>,
	sessionId?: string,
): void {
	const { toolId, questions, toolUseId } = msg;

	if (!toolId || !Array.isArray(questions)) {
		log.warn("handleAskUser: dropped — invalid payload", {
			toolId,
			questionsType: typeof questions,
			msg,
		});
		return;
	}

	// Deduplicate: skip if this question is already pending.
	// This can happen when ask_user arrives via both SSE + API replay
	// (e.g., reconnect, session switch, or the SSE connected handler).
	const isDuplicate = permissionsState.pendingQuestions.some(
		(q) => q.toolId === toolId,
	);
	if (isDuplicate) return;

	const request: QuestionRequest = {
		toolId,
		sessionId: sessionId ?? "",
		...(toolUseId != null && { toolUseId }),
		questions,
	};
	permissionsState.pendingQuestions = [
		...permissionsState.pendingQuestions,
		request,
	];
}

export function handleAskUserResolved(
	msg: Extract<RelayMessage, { type: "ask_user_resolved" }>,
): void {
	const { toolId } = msg;
	if (!toolId) return;

	// Remove from pending questions
	permissionsState.pendingQuestions = permissionsState.pendingQuestions.filter(
		(q) => q.toolId !== toolId,
	);
}

/**
 * Handle a question error — the server could not deliver the user's answer.
 * Records the error message so the QuestionCard can display it.
 */
export function handleAskUserError(
	msg: Extract<RelayMessage, { type: "ask_user_error" }>,
): void {
	const { toolId, message } = msg;
	if (!toolId) return;

	// Store the error keyed by toolId so components can react
	permissionsState.questionErrors.set(toolId, message);
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Remove a permission request (after responding). */
export function removePermission(requestId: string): void {
	permissionsState.pendingPermissions =
		permissionsState.pendingPermissions.filter(
			(p) => p.requestId !== requestId,
		);
}

/** Remove a question request (after responding). */
export function removeQuestion(toolId: string): void {
	permissionsState.pendingQuestions = permissionsState.pendingQuestions.filter(
		(q) => q.toolId !== toolId,
	);
}

/** Clear all pending items (e.g. on disconnect).
 *  Also resets the notification reducer (cross-session indicators). */
export function clearAll(): void {
	permissionsState.pendingPermissions = [];
	permissionsState.pendingQuestions = [];
	permissionsState.questionErrors = new Map();
	dispatch({ type: "reset" });
}

/** Clear only session-local pending items (for session switch).
 *  Keeps remote permissions so the AttentionBanner persists. */
export function clearSessionLocal(previousSessionId: string | null): void {
	if (previousSessionId) {
		permissionsState.pendingPermissions =
			permissionsState.pendingPermissions.filter(
				(p) => p.sessionId !== previousSessionId,
			);
	}
	permissionsState.pendingQuestions = [];
	permissionsState.questionErrors = new Map();
}

/** Clear all permissions state (for project switch).
 *  Also resets the notification reducer (cross-session indicators). */
export function clearAllPermissions(): void {
	permissionsState.pendingPermissions = [];
	permissionsState.pendingQuestions = [];
	permissionsState.questionErrors = new Map();
	dispatch({ type: "reset" });
}
