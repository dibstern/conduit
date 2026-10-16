import { Schema } from "effect";
import { SvelteMap } from "svelte/reactivity";
import { WorkspaceMoveError } from "../../contracts/session-workspace.js";
import type {
	InputDelivery,
	SteerBlocker,
} from "../../contracts/stored-event.js";
import { WorktreeCreationError } from "../../contracts/worktree.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";
import {
	draftSend,
	getOrCreateSessionSlot,
	getSessionPhase,
	sessionMessages,
} from "./chat.svelte.js";
import { getBrowserClientId } from "./client-identity.js";
import { permissionsState } from "./permissions.svelte.js";
import { getCurrentSlug } from "./router.svelte.js";
import {
	findSession,
	sessionState,
	switchToSession,
} from "./session.svelte.js";
import { usageState } from "./usage.svelte.js";
import { rateLimitChatSend } from "./ws-send.svelte.js";

export type SendOutcome =
	| { readonly kind: "started" }
	| { readonly kind: "waiting" }
	| { readonly kind: "refused"; readonly reason: SteerBlocker }
	| { readonly kind: "failed" };

type SendInput = {
	readonly text: string;
	readonly images?: readonly string[];
	readonly delivery: InputDelivery;
	readonly inputId?: string;
} & (
	| { readonly sessionId: string }
	| {
			readonly draft: Parameters<typeof rpc<"CreateSession">>[1];
			readonly onCreated?: (sessionId: string) => void;
	  }
	| {
			readonly sideThread: {
				readonly sessionId: string;
				readonly title: string;
			};
			readonly onCreated: (sessionId: string) => void;
	  }
);

type Intent = { readonly sessionId: string; readonly baseline: number };
const intents = new SvelteMap<string, Intent>();
// Even a guessed wait can finish before its reply. Retain its press baseline
// until that reply, so each applied upsert can settle it too.
const pendingReplies = new Map<string, Intent>();
const settledInputs = new Set<string>();
const refusals = new SvelteMap<string, { readonly reason: SteerBlocker }>();
let creatingDrafts = $state(0);

export function turn(sessionId: string | null) {
	return {
		working:
			sessionId === null
				? creatingDrafts > 0
				: getSessionPhase(sessionId) !== "idle" ||
					[...intents.values()].some(
						(intent) => intent.sessionId === sessionId,
					),
		refusal: sessionId === null ? null : (refusals.get(sessionId) ?? null),
	};
}

function predictsHandoff(sessionId: string): boolean {
	const row = findSession(sessionId);
	if (!row) return true;
	const inbox = sessionMessages.get(sessionId)?.transcript;
	return (
		row.status !== "busy" &&
		row.status !== "retry" &&
		!row.retrying &&
		!permissionsState.pendingPermissions.some(
			(permission) => permission.sessionId === sessionId,
		) &&
		!permissionsState.pendingQuestions.some(
			(question) => question.sessionId === sessionId,
		) &&
		!inbox?.pending.length &&
		!inbox?.paused &&
		!usageState.readings.some(
			(reading) =>
				reading.accountId === row.accountId && reading.status === "limited",
		)
	);
}

function settle(inputId: string): void {
	intents.delete(inputId);
	if (pendingReplies.has(inputId)) settledInputs.add(inputId);
}

/** Called for each applied upsert, never inferred from the latest row. */
export function applyTurnRow(row: SessionInfo): void {
	for (const [inputId, intent] of new Map([...intents, ...pendingReplies])) {
		if (
			(intent.sessionId === row.id || row.lastTurnEndInputId === inputId) &&
			(row.lastTurnEndVersion ?? 0) >
				(intent.sessionId === row.id ? intent.baseline : 0) &&
			(row.lastTurnEndInputId ?? inputId) === inputId
		)
			settle(inputId);
	}
}

/** A reconnect supersedes every covered intent. */
export function rebaseTurns(sessionIds: Iterable<string>): void {
	const covered = new Set(sessionIds);
	for (const [inputId, intent] of new Map([...intents, ...pendingReplies]))
		if (covered.has(intent.sessionId)) settle(inputId);
}

/** A feed removal alone is not a deletion. */
export function deleteTurn(sessionId: string): void {
	rebaseTurns([sessionId]);
	refusals.delete(sessionId);
}

export async function send(input: SendInput): Promise<SendOutcome> {
	const inputId = input.inputId ?? crypto.randomUUID();
	const projectSlug =
		"sessionId" in input
			? (findSession(input.sessionId)?.projectSlug ?? getCurrentSlug())
			: undefined;
	let sessionId: string | undefined;
	let creating = false;
	try {
		if ("sideThread" in input) {
			const created = await rpc("StartSideThread", {
				sessionId: input.sideThread.sessionId,
				title: input.sideThread.title,
				inputId,
				text: input.text,
				...(input.images?.length ? { images: input.images } : {}),
				originId: getBrowserClientId(),
			});
			input.onCreated(created.sessionId);
			return { kind: "started" };
		}
		if ("draft" in input) {
			creating = true;
			creatingDrafts++;
			try {
				const created = await rpc("CreateSession", input.draft);
				sessionId = created.sessionId;
				draftSend.sessionId = sessionId;
			} finally {
				creatingDrafts--;
			}
			creating = false;
		} else sessionId = input.sessionId;

		getOrCreateSessionSlot(sessionId);
		const intent = {
			sessionId,
			baseline: findSession(sessionId)?.lastTurnEndVersion ?? 0,
		};
		pendingReplies.set(inputId, intent);
		if (input.delivery !== "steer" && predictsHandoff(sessionId))
			intents.set(inputId, intent);
		refusals.delete(sessionId);
		if ("draft" in input) input.onCreated?.(sessionId);
		const sentToSessionId = sessionId;
		const reply = await new Promise<
			Awaited<ReturnType<typeof rpc<"input.submit">>>
		>((resolve, reject) =>
			rateLimitChatSend(() => {
				rpc("input.submit", {
					sessionId: sentToSessionId,
					text: input.text,
					inputId,
					delivery: input.delivery,
					...(input.images ? { images: input.images } : {}),
					originId: getBrowserClientId(),
				}).then(resolve, reject);
			}),
		);
		if (!reply.ok || !reply.handedOff || input.delivery === "steer")
			intents.delete(inputId);
		else if (!settledInputs.has(inputId))
			intents.set(inputId, {
				sessionId: reply.sessionId,
				baseline: reply.sessionId === sessionId ? intent.baseline : 0,
			});
		if (!reply.ok) {
			if (draftSend.sessionId === sessionId) draftSend.message = null;
			refusals.set(sessionId, { reason: reply.reason });
			return { kind: "refused", reason: reply.reason };
		}
		// Preserve the existing fork redirect, including its navigation guard.
		if (reply.sessionId !== sentToSessionId) {
			if (sessionState.currentId === sentToSessionId)
				switchToSession(
					reply.sessionId,
					projectSlug ??
						("draft" in input ? input.draft.projectSlug : undefined) ??
						undefined,
					undefined,
					{ replace: true },
				);
		}
		return {
			kind:
				reply.handedOff && input.delivery !== "steer" ? "started" : "waiting",
		};
	} catch (error) {
		intents.delete(inputId);
		if (creating || draftSend.sessionId === sessionId) draftSend.message = null;
		toastFailure(
			"sideThread" in input
				? "Failed to start Side Thread"
				: creating
					? Schema.is(WorktreeCreationError)(error) ||
						Schema.is(WorkspaceMoveError)(error)
						? "Could not start session"
						: "Failed to create session"
					: "Failed to send message",
		)(error);
		return { kind: "failed" };
	} finally {
		pendingReplies.delete(inputId);
		settledInputs.delete(inputId);
	}
}
