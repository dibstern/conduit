// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { formatErrorDetail, RelayError } from "../errors.js";
import { canonicalEvent } from "../persistence/events.js";
import { createRelayEventSink } from "../provider/relay-event-sink.js";
import type { SendTurnInput } from "../provider/types.js";
import { isClaudeProvider } from "./model.js";
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
			).toSystemError(),
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
			deps.wsHandler.sendTo(targetId, {
				type: "user_message",
				sessionId: activeId,
				text,
			});
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
		sessionId: activeId,
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
			).toMessage(activeId),
		);
		deps.wsHandler.sendToSession(activeId, {
			type: "done",
			sessionId: activeId,
			code: 1,
		});
	});
	// Phase 5: Route through OrchestrationEngine when available; fall back to
	// direct REST call for legacy paths (e.g. tests that don't provide the engine).
	if (deps.orchestrationEngine) {
		const model = deps.overrides.getModel(activeId);
		let providerId = deps.orchestrationEngine.getProviderForSession(activeId);
		if (!providerId) {
			providerId =
				model && isClaudeProvider(model.providerID) ? "claude" : "opencode";
		}
		// Persist user message for Claude provider sessions.
		// The Claude adapter never emits user-side message.created events, so we
		// record them here — before dispatch — to keep chronological order correct.
		if (providerId === "claude" && deps.claudeEventPersist != null) {
			try {
				const now = Date.now();
				const userMsgId = crypto.randomUUID();
				deps.claudeEventPersist.ensureSession(activeId);
				// Emit session.created so SessionProjector + ProviderProjector
				// create the session row and session_providers binding.
				// ON CONFLICT DO UPDATE in SessionProjector makes this idempotent.
				const storedSession = deps.claudeEventPersist.eventStore.append(
					canonicalEvent(
						"session.created",
						activeId,
						{
							sessionId: activeId,
							title: "Claude Session",
							provider: "claude",
						},
						{ provider: "claude", createdAt: now },
					),
				);
				deps.claudeEventPersist.projectionRunner.projectEvent(storedSession);
				const storedCreated = deps.claudeEventPersist.eventStore.append(
					canonicalEvent(
						"message.created",
						activeId,
						{ messageId: userMsgId, role: "user", sessionId: activeId },
						{ provider: "claude", createdAt: now },
					),
				);
				deps.claudeEventPersist.projectionRunner.projectEvent(storedCreated);
				const storedDelta = deps.claudeEventPersist.eventStore.append(
					canonicalEvent(
						"text.delta",
						activeId,
						{ messageId: userMsgId, partId: `${userMsgId}-0`, text },
						{ provider: "claude", createdAt: now },
					),
				);
				deps.claudeEventPersist.projectionRunner.projectEvent(storedDelta);
			} catch {
				// Non-fatal — persistence failure must not block message sending
			}
		}
		// ClaudeAdapter emits events via EventSink. Build a RelayEventSink that
		// translates CanonicalEvents → RelayMessages → WebSocket. OpenCodeAdapter
		// ignores eventSink (events flow via SSE), so a no-op sink is fine there.
		const eventSink =
			providerId === "claude"
				? createRelayEventSink({
						sessionId: activeId,
						send: (msg) => deps.wsHandler.sendToSession(activeId, msg),
						clearTimeout: () => deps.overrides.clearProcessingTimeout(activeId),
						resetTimeout: () => deps.overrides.resetProcessingTimeout(activeId),
						...(deps.claudeEventPersist != null
							? { persist: deps.claudeEventPersist }
							: {}),
						permissionBridge: deps.permissionBridge,
						questionBridge: deps.questionBridge,
					})
				: NOOP_EVENT_SINK;
		const sendTurnInput: SendTurnInput = {
			sessionId: activeId,
			turnId: crypto.randomUUID(),
			prompt: text,
			history: [],
			providerState: deps.providerStateService?.getState(activeId) ?? {},
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
			eventSink,
			abortSignal: new AbortController().signal,
			...(images && images.length > 0 ? { images } : {}),
			...(sessionAgent ? { agent: sessionAgent } : {}),
			...(variant ? { variant } : {}),
		};
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
					deps.wsHandler.sendToSession(activeId, {
						type: "done",
						sessionId: activeId,
						code: 1,
					});
					deps.wsHandler.sendTo(
						clientId,
						new RelayError(msg, { code: "SEND_FAILED" }).toMessage(activeId),
					);
				}
				// Persist resume cursor and other provider state updates
				if (result.status !== "error" && result.providerStateUpdates?.length) {
					try {
						deps.providerStateService?.saveUpdates(
							activeId,
							result.providerStateUpdates.map((u) => ({
								key: u.key,
								value: String(u.value),
							})),
						);
					} catch {
						// Non-fatal — resume is a convenience, not a requirement
					}
				}
				// Auto-rename Claude sessions after first successful turn.
				// OpenCode auto-titles sessions server-side, but Claude SDK
				// bypasses OpenCode's REST API — the prompt never reaches
				// OpenCode, so it never auto-titles.
				//
				// Guard: only rename when turnCount is 1 AND the session still
				// has a default title. This prevents spurious renames when the
				// SDK context is recreated (restart, endSession, eviction) —
				// turnCount resets to 0 on recreation, so the next turn would
				// otherwise overwrite the original title.
				if (result.status !== "error" && providerId === "claude") {
					const turnCount = result.providerStateUpdates?.find(
						(u) => u.key === "turnCount",
					)?.value;
					if (Number(turnCount) === 1) {
						const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
						// Only rename if title is still the default placeholder.
						// Prevents overwriting user-renamed or previously auto-renamed
						// sessions when the SDK context is recreated.
						deps.sessionMgr
							.listSessions()
							.then(async (sessions) => {
								const session = sessions.find((s) => s.id === activeId);
								const currentTitle = session?.title ?? "";
								const isDefault =
									!currentTitle ||
									currentTitle === "Claude Session" ||
									currentTitle.startsWith("New session");
								if (isDefault) {
									await deps.sessionMgr.renameSession(activeId, title);
								}
							})
							.catch((err) => {
								deps.log.warn(
									`Auto-rename failed for ${activeId}: ${err instanceof Error ? err.message : err}`,
								);
							});
					}
				}
			})
			.catch((sendErr) => {
				deps.log.warn(
					`client=${clientId} session=${activeId} Failed to send message:`,
					formatErrorDetail(sendErr),
				);
				deps.overrides.clearProcessingTimeout(activeId);
				deps.wsHandler.sendToSession(activeId, {
					type: "done",
					sessionId: activeId,
					code: 1,
				});
				deps.wsHandler.sendTo(
					clientId,
					RelayError.fromCaught(
						sendErr,
						"SEND_FAILED",
						"Failed to send message",
					).toMessage(activeId),
				);
			});
	} else {
		// Legacy path: direct REST call (used when engine is not wired, e.g. tests)
		try {
			await deps.client.session.prompt(activeId, prompt);
		} catch (sendErr) {
			deps.log.warn(
				`client=${clientId} session=${activeId} Failed to send message:`,
				formatErrorDetail(sendErr),
			);
			deps.overrides.clearProcessingTimeout(activeId);
			deps.wsHandler.sendToSession(activeId, {
				type: "done",
				sessionId: activeId,
				code: 1,
			});
			deps.wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					sendErr,
					"SEND_FAILED",
					"Failed to send message",
				).toMessage(activeId),
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

		// Route through OrchestrationEngine for Claude sessions so the
		// interrupt reaches ClaudeAdapter.interruptTurn() and aborts the
		// in-process SDK query.
		if (deps.orchestrationEngine) {
			const providerId =
				deps.orchestrationEngine.getProviderForSession(activeId);
			if (providerId === "claude") {
				try {
					await deps.orchestrationEngine.dispatch({
						type: "interrupt_turn",
						sessionId: activeId,
					});
				} catch (err) {
					deps.log.warn(
						`client=${clientId} session=${activeId} engine interrupt_turn failed:`,
						formatErrorDetail(err),
					);
				}
				deps.wsHandler.sendToSession(activeId, {
					type: "done",
					sessionId: activeId,
					code: 1,
				});
				return;
			}
		}

		// OpenCode path: abort via REST API
		try {
			await deps.client.session.abort(activeId);
		} catch (abortErr) {
			deps.log.warn(
				`client=${clientId} session=${activeId} Abort failed:`,
				formatErrorDetail(abortErr),
			);
		}
		deps.wsHandler.sendToSession(activeId, {
			type: "done",
			sessionId: activeId,
			code: 1,
		});
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
		await deps.client.session.revert(activeId, { messageID: messageId });
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
