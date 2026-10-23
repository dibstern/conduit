import { Schema } from "effect";
import { untrack } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { parseAttachmentDataUrl } from "../../attachment-data-url.js";
import { accountLimit } from "../../contracts/account-limit.js";
import { WorkspaceMoveError } from "../../contracts/session-workspace.js";
import type {
	InputDelivery,
	SteerBlocker,
} from "../../contracts/stored-event.js";
import { WorktreeCreationError } from "../../contracts/worktree.js";
import { DraftAlreadySent } from "../../contracts/ws-rpc.js";
import { stopBackgroundTasks } from "../components/session/background-tasks.svelte.js";
import { toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";
import {
	getOrCreateSessionSlot,
	getSessionPhase,
	localSends,
	sessionMessages,
} from "./chat.svelte.js";
import { getBrowserClientId } from "./client-identity.js";
import { clock } from "./clock.svelte.js";
import {
	getAvailableInstances,
	getDraftPick,
	getEffectiveInstanceId,
} from "./discovery.svelte.js";
import {
	getDriverTraits,
	getInstanceById,
	instanceState,
} from "./instance.svelte.js";
import { permissionsState } from "./permissions.svelte.js";
import { getDraftProject, projectState } from "./project-state.svelte.js";
import { selection } from "./selection.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { dismissToast, showToast, uiState } from "./ui.svelte.js";
import { usageState } from "./usage.svelte.js";
import { rateLimitChatSend } from "./ws-send.svelte.js";

export type SendOutcome =
	| { readonly kind: "started" }
	| { readonly kind: "waiting" }
	| { readonly kind: "refused"; readonly reason: SteerBlocker }
	| { readonly kind: "failed"; readonly alreadySent?: boolean };

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
/** Drafts whose CreateSession is in flight, by draft id. */
const creatingDrafts = new SvelteSet<string | undefined>();
let dismissTaskStopToast: (() => void) | undefined;

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
				? draft && creatingDrafts.has(selection.scope?.draftId)
				: (getSessionPhase(sessionId) !== "idle" &&
						findSession(sessionId)?.canStop !== false) ||
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
	const reading = usageState.readings.find(
		(reading) => reading.accountId === row.accountId,
	);
	const recovery = row.limitRecovery;
	return (
		row.status !== "busy" &&
		row.status !== "retry" &&
		!row.retrying &&
		!permissionsState.pendingPermissions.some(
			(permission) => permission.sessionId === sessionId,
		) &&
		!permissionsState.pendingQuestions.some(
			(question) =>
				question.sessionId === sessionId && question.delivery !== "async",
		) &&
		!inbox?.pending.length &&
		!inbox?.paused &&
		accountLimit({
			asker: "user",
			modelId: row.model?.model,
			...(reading ? { reading } : {}),
			...(recovery && !recovery.switched ? { recovery } : {}),
			now: clock.now,
		}).kind !== "wait-until"
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

export async function stop(sessionId: string): Promise<void> {
	// Include guessed waits: their late handoff replies must stay settled too.
	rebaseTurns([sessionId]);
	const session = findSession(sessionId);
	const driver = getInstanceById(session?.accountId ?? "")?.driver;
	const hadTasks =
		getDriverTraits(driver)?.sessionCapabilities.supportsTaskStop &&
		(session?.backgroundTasks?.length ?? 0) > 0;
	try {
		await rpc("CancelSession", {
			sessionId,
			commandId: crypto.randomUUID(),
		});
		if (!hadTasks || sessionState.currentId !== sessionId) return;
		const count = findSession(sessionId)?.backgroundTasks?.length ?? 0;
		if (count === 0) return;
		dismissTaskStopToast?.();
		const id = showToast(
			`Turn stopped. ${count} ${count === 1 ? "task" : "tasks"} still running`,
			{
				duration: 6000,
				action: {
					label: "Stop them",
					run: () => {
						if (sessionState.currentId === sessionId)
							void stopBackgroundTasks(sessionId);
					},
				},
			},
		);
		// The offer follows the shown session, independent of composer mounts.
		dismissTaskStopToast = $effect.root(() => {
			$effect(() => {
				const count = findSession(sessionId)?.backgroundTasks?.length ?? 0;
				const active = sessionState.currentId === sessionId;
				const toast = uiState.toasts.find((toast) => toast.id === id);
				untrack(() => {
					if (!active || count === 0 || !toast) {
						dismissTaskStopToast?.();
						dismissTaskStopToast = undefined;
					} else
						toast.title = `Turn stopped. ${count} ${count === 1 ? "task" : "tasks"} still running`;
				});
			});
			return () => dismissToast(id);
		});
	} catch (error) {
		toastFailure("Failed to stop session")(error);
	}
}

export async function send(input: SendInput): Promise<SendOutcome> {
	const from = input.from === undefined ? selection.scope : input.from;
	const inputId = input.inputId ?? crypto.randomUUID();
	let sessionId: string | undefined;
	let creating = false;
	const message = {
		type: "user",
		uuid: inputId,
		text: input.text,
		createdAt: Date.now(),
		...(input.images?.length
			? {
					attachments: input.images.map((url) => {
						const { mime, name, size } = parseAttachmentDataUrl(url);
						return {
							id: crypto.randomUUID(),
							name: name ?? "Attachment",
							mime,
							url,
							size,
						};
					}),
				}
			: {}),
	} as const;
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
			const draftId = from?.draftId;
			creatingDrafts.add(draftId);
			localSends.set(inputId, {
				sessionId: null,
				draftId,
				message,
				opensSession: true,
			});
			try {
				const created = await rpc("CreateSession", input.draft);
				sessionId = created.sessionId;
			} finally {
				creatingDrafts.delete(draftId);
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
		// A send that will start a turn shows at once; a queued one shows in
		// the tray, and a steer stays in the composer until it lands.
		if ("draft" in input || intents.has(inputId))
			localSends.set(inputId, {
				sessionId,
				message,
				opensSession: "draft" in input,
			});
		if ("draft" in input) {
			// follow records the session's project and only moves a sender who
			// stayed put; the composer's promotion then lands on the same path.
			selection.follow(from, sessionId, "push");
			input.onCreated?.(sessionId);
		}
		const sentToSessionId = sessionId;
		const sentFrom =
			"draft" in input && from
				? { project: from.project, sessionId: sentToSessionId }
				: from;
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
			localSends.delete(inputId);
			refusals.set(sessionId, { reason: reply.reason });
			return { kind: "refused", reason: reply.reason };
		}
		if (reply.sessionId !== sentToSessionId) {
			const shown = localSends.get(inputId);
			if (shown)
				localSends.set(inputId, { ...shown, sessionId: reply.sessionId });
			selection.follow(sentFrom, reply.sessionId, "replace");
		}
		return {
			kind:
				reply.handedOff && input.delivery !== "steer" ? "started" : "waiting",
		};
	} catch (error) {
		intents.delete(inputId);
		localSends.delete(inputId);
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
		return {
			kind: "failed",
			...(Schema.is(DraftAlreadySent)(error) ? { alreadySent: true } : {}),
		};
	} finally {
		pendingReplies.delete(inputId);
		settledInputs.delete(inputId);
	}
}
