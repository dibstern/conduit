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
import {
	getAvailableInstances,
	getDraftPick,
	getEffectiveInstanceId,
} from "./discovery.svelte.js";
import { instanceState } from "./instance.svelte.js";
import { permissionsState } from "./permissions.svelte.js";
import { getDraftProject, projectState } from "./project-state.svelte.js";
import { selection } from "./selection.svelte.js";
import { findSession } from "./session.svelte.js";
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
	readonly from?: typeof selection.scope;
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

export function turn() {
	const shown = selection.shown;
	const sessionId = shown.kind === "placed" ? shown.sessionId : null;
	const draft =
		shown.kind === "draft" ||
		(shown.kind === "none" && selection.scope !== null);
	const draftProject = draft
		? projectState.projects.find(
				(project) => project.slug === getDraftProject(),
			)
		: undefined;
	return {
		working:
			sessionId === null
				? draft && creatingDrafts > 0
				: getSessionPhase(sessionId) !== "idle" ||
					[...intents.values()].some(
						(intent) => intent.sessionId === sessionId,
					),
		refusal: sessionId === null ? null : (refusals.get(sessionId) ?? null),
		ready:
			shown.kind === "placed" ||
			(draft &&
				!(
					(draftProject?.folders.length ?? 0) > 1 &&
					getAvailableInstances().find(
						(instance) => instance.id === getEffectiveInstanceId(),
					)?.capabilities?.supportsMultiFolder === false
				) &&
				(getDraftPick() !== undefined ||
					(instanceState.loaded && !getEffectiveInstanceId()))),
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
	const from = input.from === undefined ? selection.scope : input.from;
	const inputId = input.inputId ?? crypto.randomUUID();
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
			selection.follow(from, created.sessionId, "push");
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
		if ("draft" in input) {
			input.onCreated?.(sessionId);
			selection.follow(from, sessionId, "push");
		}
		const sentToSessionId = sessionId;
		const sentFrom =
			"draft" in input && from ? { ...from, sessionId: sentToSessionId } : from;
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
		if (reply.sessionId !== sentToSessionId)
			selection.follow(sentFrom, reply.sessionId, "replace");
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
