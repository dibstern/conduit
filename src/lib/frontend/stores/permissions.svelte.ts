// Pending permission requests and user questions.

import type { Approval } from "../../shared-types.js";
import {
	type Change,
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "../transport/subscription-state.js";
import type {
	AskUserQuestion,
	PermissionRequest,
	QuestionRequest,
} from "../types.js";
import { sessionState } from "./session.svelte.js";

// This store has no client half: every entry is a request the server is waiting
// on, as the approvals subscription (ni8.9) reports it. Which option the user
// has highlighted lives in the card component until it is submitted.

export const permissionsState = $state({
	pendingPermissions: [] as (PermissionRequest & { id: string })[],
	pendingQuestions: [] as QuestionRequest[],
});

// The authoritative copy; the two lists above are views of it.
let approvals: SubscriptionState<Approval> = emptySubscription();

const approvalId = (approval: Approval): string =>
	approval._tag === "permission" ? approval.requestId : approval.toolId;

const toPermission = (
	approval: Extract<Approval, { _tag: "permission" }>,
): PermissionRequest & { id: string } => ({
	id: approval.requestId,
	requestId: approval.requestId,
	sessionId: approval.sessionId,
	toolName: approval.toolName,
	toolInput: approval.toolInput,
	...(approval.toolUseId != null && { toolUseId: approval.toolUseId }),
	...(approval.always != null && { always: [...approval.always] }),
	...(approval.permissionSuggestions != null && {
		permissionSuggestions: [...approval.permissionSuggestions],
	}),
	...(approval.permissionTitle != null && {
		permissionTitle: approval.permissionTitle,
	}),
	...(approval.permissionDisplayName != null && {
		permissionDisplayName: approval.permissionDisplayName,
	}),
	...(approval.permissionDescription != null && {
		permissionDescription: approval.permissionDescription,
	}),
	...(approval.permissionReason != null && {
		permissionReason: approval.permissionReason,
	}),
});

const toQuestion = (
	approval: Extract<Approval, { _tag: "question" }>,
): QuestionRequest => ({
	toolId: approval.toolId,
	sessionId: approval.sessionId,
	...(approval.toolUseId != null && { toolUseId: approval.toolUseId }),
	...(approval.providerId != null && { providerId: approval.providerId }),
	questions: approval.questions.map((question) => ({
		question: question.question,
		header: question.header,
		multiSelect: question.multiSelect,
		...(question.custom != null && { custom: question.custom }),
		options: question.options.map(({ label, description }) => ({
			label,
			...(description != null && { description }),
		})),
	})),
});

const publish = (next: SubscriptionState<Approval>): void => {
	approvals = next;
	const rows = [...next.rows.values()];
	permissionsState.pendingPermissions = rows.flatMap((approval) =>
		approval._tag === "permission" ? [toPermission(approval)] : [],
	);
	permissionsState.pendingQuestions = rows.flatMap((approval) =>
		approval._tag === "question" ? [toQuestion(approval)] : [],
	);
};

/**
 * Fold one approvals envelope into the store. Returns the approvals that were
 * not pending before it, which are the ones worth a notification: a replayed
 * upsert or a reconnect snapshot re-reports what the user was already told.
 */
export function applyApprovalEnvelope(change: Change<Approval>): Approval[] {
	const before = approvals;
	const next = reduce(before, change, approvalId);
	if (next === before) return [];
	publish(next);
	return [...next.rows].flatMap(([id, approval]) =>
		before.rows.has(id) ? [] : [approval],
	);
}

/** Whether an approval is still waiting on the user. */
export function isApprovalPending(id: string): boolean {
	return approvals.rows.has(id);
}

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
 * for a given session, from `sessionState.familySessions` which includes
 * `parentID` for subagent sessions.
 *
 * Reads the family exactly once: a workflow can own thousands of subagents,
 * and rescanning the reactive array per descendant was quadratic in tracked
 * reads, freezing the UI for seconds on every family update.
 */
export function getDescendantSessionIds(parentId: string): Set<string> {
	const childrenByParent = new Map<string, string[]>();
	for (const { id, parentID } of sessionState.familySessions) {
		if (!parentID) continue;
		const siblings = childrenByParent.get(parentID);
		if (siblings) siblings.push(id);
		else childrenByParent.set(parentID, [id]);
	}
	const descendants = new Set<string>();
	const pending = [parentId];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		for (const child of childrenByParent.get(id) ?? []) {
			if (descendants.has(child)) continue;
			descendants.add(child);
			pending.push(child);
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

/**
 * Take an answered approval down before the server confirms it. The
 * subscription's remove follows; until then the row is kept out of the view
 * so a recompute does not bring the card back.
 */
const dismiss = (id: string): void => {
	if (!approvals.rows.has(id)) return;
	const rows = new Map(approvals.rows);
	rows.delete(id);
	publish({ ...approvals, rows });
};

/** Remove a permission request (after responding). */
export function removePermission(requestId: string): void {
	dismiss(requestId);
}

/** Remove a question request (after responding). */
export function removeQuestion(toolId: string): void {
	dismiss(toolId);
}

/** Clear all pending items (e.g. on disconnect).
 *  Cross-session indicators need no clearing: they are on the session rows, and
 *  the next snapshot replaces them wholesale. */
export function clearAll(): void {
	publish(emptySubscription());
}

/** Clear all permissions state (for project switch). */
export function clearAllPermissions(): void {
	publish(emptySubscription());
}
