// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { formatErrorDetail, RelayError } from "../errors.js";
import type { SendTurnInput } from "../provider/types.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import type { HandlerDeps, PromptOptions } from "./types.js";

// ─── Minimal no-op EventSink for OpenCodeAdapter (which ignores it) ──────────
// OpenCodeAdapter routes messages via REST + SSE, not EventSink. The sink is
// required by the SendTurnInput interface but unused on the OpenCode path.
const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Promise.resolve(),
	requestPermission: () => Promise.resolve({ decision: "once" as const }),
	requestQuestion: () => Promise.resolve({}),
};

// ─── Per-session input draft store ──────────────────────────────────────────
// Stores the last input_sync text per session so that newly connecting clients
// (e.g. opening on a different device) receive the current draft.

const sessionInputDrafts = new Map<string, string>();

/** Get the stored input draft for a session (empty string if none). */
export function getSessionInputDraft(sessionId: string): string {
	return sessionInputDrafts.get(sessionId) ?? "";
}

/** Clear the stored input draft for a session (e.g. after sending a message). */
export function clearSessionInputDraft(sessionId: string): void {
	sessionInputDrafts.delete(sessionId);
}

export async function handleMessage(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["message"],
): Promise<void> {
	const { text, images } = payload;
	const activeId = resolveSession(deps, clientId);
	if (!text) return;
	if (!activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"No active session. Create or switch to a session first.",
				{
					code: "NO_SESSION",
				},
			).toMessage(),
		);
		return;
	}
	deps.log.info(
		`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
	);

	// Clear the input draft — the user's draft is now a sent message.
	// Without this, the stale draft would be re-applied on reconnect or
	// session switch (session_switched includes inputText from the draft store).
	clearSessionInputDraft(activeId);

	// Send user_message to OTHER clients viewing this session.
	// The sending client already added the message locally in the frontend,
	// and the SSE echo from OpenCode is suppressed (sse-wiring.ts) to avoid
	// duplicates. But other clients need to see the message immediately.
	const targets = deps.wsHandler.getClientsForSession(activeId);
	for (const targetId of targets) {
		if (targetId !== clientId) {
			deps.wsHandler.sendTo(targetId, { type: "user_message", text });
		}
	}

	// Track message activity for session ordering
	deps.sessionMgr.recordMessageActivity(activeId);

	const prompt: PromptOptions = {
		text,
		...(images && images.length > 0 && { images }),
	};
	const sessionAgent = deps.overrides.getAgent(activeId);
	if (sessionAgent) prompt.agent = sessionAgent;
	const sessionModel = deps.overrides.getModel(activeId);
	if (sessionModel && deps.overrides.isModelUserSelected(activeId))
		prompt.model = sessionModel;
	const variant = deps.overrides.getVariant(activeId);
	if (variant) prompt.variant = variant;

	deps.wsHandler.sendToSession(activeId, {
		type: "status",
		status: "processing",
	});
	deps.overrides.startProcessingTimeout(activeId, () => {
		deps.log.warn(
			`client=${clientId} session=${activeId} Processing timeout (120s) — broadcasting done`,
		);
		deps.wsHandler.sendToSession(
			activeId,
			new RelayError(
				"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
				{ code: "PROCESSING_TIMEOUT" },
			).toMessage(),
		);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
	});
	// Phase 5: Route through OrchestrationEngine when available; fall back to
	// direct REST call for legacy paths (e.g. tests that don't provide the engine).
	if (deps.orchestrationEngine) {
		const model = deps.overrides.getModel(activeId);
		const sendTurnInput: SendTurnInput = {
			sessionId: activeId,
			turnId: crypto.randomUUID(),
			prompt: text,
			history: [],
			providerState: {},
			// Only pass model when user has explicitly selected one
			...(model && deps.overrides.isModelUserSelected(activeId)
				? {
						model: {
							providerId: model.providerID,
							modelId: model.modelID,
						},
					}
				: {}),
			workspaceRoot: deps.config.projectDir ?? "",
			eventSink: NOOP_EVENT_SINK,
			abortSignal: new AbortController().signal,
			...(images && images.length > 0 ? { images } : {}),
			...(sessionAgent ? { agent: sessionAgent } : {}),
			...(variant ? { variant } : {}),
		};
		const providerId =
			deps.orchestrationEngine.getProviderForSession(activeId) ?? "opencode";
		// Fire-and-forget: the engine manages the turn lifecycle asynchronously.
		// Errors are surfaced via the .then() handler below.
		void deps.orchestrationEngine
			.dispatch({ type: "send_turn", providerId, input: sendTurnInput })
			.then((result) => {
				if (result.status === "error") {
					const msg = result.error?.message ?? "Send failed";
					deps.log.warn(
						`client=${clientId} session=${activeId} engine dispatch error: ${msg}`,
					);
					deps.overrides.clearProcessingTimeout(activeId);
					deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
					deps.wsHandler.sendTo(
						clientId,
						new RelayError(msg, { code: "SEND_FAILED" }).toMessage(),
					);
				}
			})
			.catch((sendErr) => {
				deps.log.warn(
					`client=${clientId} session=${activeId} Failed to send message:`,
					formatErrorDetail(sendErr),
				);
				deps.overrides.clearProcessingTimeout(activeId);
				deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
				deps.wsHandler.sendTo(
					clientId,
					RelayError.fromCaught(
						sendErr,
						"SEND_FAILED",
						"Failed to send message",
					).toMessage(),
				);
			});
	} else {
		// Legacy path: direct REST call (used when engine is not wired, e.g. tests)
		try {
			await deps.client.sendMessageAsync(activeId, prompt);
		} catch (sendErr) {
			deps.log.warn(
				`client=${clientId} session=${activeId} Failed to send message:`,
				formatErrorDetail(sendErr),
			);
			deps.overrides.clearProcessingTimeout(activeId);
			deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
			deps.wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					sendErr,
					"SEND_FAILED",
					"Failed to send message",
				).toMessage(),
			);
		}
	}
}

export async function handleCancel(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["cancel"],
): Promise<void> {
	const activeId = resolveSession(deps, clientId);
	if (activeId) {
		deps.log.info(`client=${clientId} session=${activeId} Aborting`);
		deps.overrides.clearProcessingTimeout(activeId);
		try {
			await deps.client.abortSession(activeId);
		} catch (abortErr) {
			deps.log.warn(
				`client=${clientId} session=${activeId} Abort failed:`,
				formatErrorDetail(abortErr),
			);
		}
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
	}
}

export async function handleRewind(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["rewind"],
): Promise<void> {
	const messageId = payload.messageId ?? payload.uuid ?? "";
	const activeId = resolveSession(deps, clientId);
	if (messageId && activeId) {
		await deps.client.revertSession(activeId, messageId);
		// Invalidate pagination cursor — revert deletes messages, so the old
		// cursor would point to a non-existent message ID.
		deps.sessionMgr.clearPaginationCursor(activeId);
		deps.log.info(
			`client=${clientId} session=${activeId} Reverted to message: ${messageId}`,
		);
	}
}

export async function handleInputSync(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["input_sync"],
): Promise<void> {
	const senderSession = deps.wsHandler.getClientSession(clientId);
	if (!senderSession) return;

	// Store the draft so newly connecting clients receive it
	if (payload.text) {
		sessionInputDrafts.set(senderSession, payload.text);
	} else {
		sessionInputDrafts.delete(senderSession);
	}

	const targets = deps.wsHandler.getClientsForSession(senderSession);
	for (const targetId of targets) {
		if (targetId !== clientId) {
			deps.wsHandler.sendTo(targetId, {
				type: "input_sync",
				text: payload.text,
				from: clientId,
			});
		}
	}
}
