// ─── Permission & Question Handlers ──────────────────────────────────────────
//
// Questions use a bridge-less design: the frontend receives the question's
// `que_` ID via the `ask_user` WebSocket message and sends it back with the
// answer. The handler calls the OpenCode REST API directly — no in-memory
// bridge state is needed, so questions survive relay restarts.

import { RelayError } from "../errors.js";
import type { PermissionDecision } from "../provider/types.js";
import { fixupConfigFile } from "./fixup-config-file.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession, resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/**
 * After a question is answered or rejected, the model resumes processing.
 * Restart the inactivity timeout so we detect if the model stalls.
 * (The timeout was cleared when the question was asked — see event-pipeline.ts.)
 */
function restartProcessingTimeout(deps: HandlerDeps, sessionId: string): void {
	if (!sessionId) return;
	deps.overrides.startProcessingTimeout(sessionId, () => {
		deps.log.warn(
			`session=${sessionId} Processing timeout (120s) after question answered — broadcasting done`,
		);
		deps.wsHandler.sendToSession(
			sessionId,
			new RelayError(
				"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
				{ code: "PROCESSING_TIMEOUT" },
			).toMessage(sessionId),
		);
		deps.wsHandler.sendToSession(sessionId, {
			type: "done",
			sessionId,
			code: 1,
		});
	});
}

export async function handlePermissionResponse(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["permission_response"],
): Promise<void> {
	const { requestId, decision, persistScope, persistPattern } = payload;
	const sessionId = resolveSessionForLog(deps, clientId);
	const result = deps.permissionBridge.onPermissionResponse(
		requestId,
		decision,
	);
	if (result) {
		deps.log.info(
			`client=${clientId} session=${sessionId} ${result.toolName}: ${result.mapped}`,
		);

		// Route through OrchestrationEngine for Claude sessions so the
		// decision reaches RelayEventSink.resolvePermission() and unblocks
		// the in-process SDK turn.
		if (deps.orchestrationEngine) {
			const providerId =
				deps.orchestrationEngine.getProviderForSession(sessionId);
			if (providerId === "claude") {
				try {
					await deps.orchestrationEngine.dispatch({
						type: "resolve_permission",
						sessionId,
						requestId,
						decision: result.mapped as PermissionDecision,
					});
				} catch (err) {
					deps.log.warn(
						`client=${clientId} session=${sessionId} engine resolve_permission failed: ${err}`,
					);
				}
			}
		}

		// Also call the OpenCode REST API (harmless no-op for Claude sessions)
		try {
			await deps.client.permission.reply(sessionId, requestId, result.mapped);
		} catch {
			// Swallow — this will fail for Claude-only sessions with no
			// OpenCode counterpart; the engine dispatch above is the real path.
		}
		deps.wsHandler.broadcast({
			type: "permission_resolved",
			sessionId,
			requestId,
			decision: result.mapped,
		});

		// Persist to opencode.jsonc when the user chose "Always Allow"
		if (decision === "allow_always" && persistScope) {
			await persistPermissionRule(
				deps,
				result.toolName,
				persistScope,
				persistPattern,
			);
		}
	}
}

async function persistPermissionRule(
	deps: HandlerDeps,
	toolName: string,
	scope: "tool" | "pattern",
	pattern?: string,
): Promise<void> {
	try {
		const config = await deps.client.config.get();
		const rawPermission = config["permission"];

		// Normalise: if permission is a simple string ("ask"/"allow"/"deny"),
		// expand to { "*": <value> } so we can add tool-level entries.
		let currentPermission: Record<string, unknown>;
		if (typeof rawPermission === "string") {
			currentPermission = { "*": rawPermission };
		} else if (
			rawPermission &&
			typeof rawPermission === "object" &&
			!Array.isArray(rawPermission)
		) {
			currentPermission = {
				...(rawPermission as Record<string, unknown>),
			};
		} else {
			currentPermission = {};
		}

		if (scope === "tool") {
			currentPermission[toolName] = "allow";
		} else if (scope === "pattern" && pattern) {
			const currentRule = currentPermission[toolName];
			const ruleObject =
				typeof currentRule === "object" &&
				currentRule !== null &&
				!Array.isArray(currentRule)
					? { ...(currentRule as Record<string, unknown>) }
					: {};
			ruleObject[pattern] = "allow";
			currentPermission[toolName] = ruleObject;
		} else {
			return;
		}

		await deps.client.config.update({ permission: currentPermission });
		await fixupConfigFile(deps.config.projectDir, deps.log);
		deps.log.info(`Persisted: ${toolName} ${scope}=${pattern ?? "*"}`);
	} catch (err) {
		deps.log.warn(`Config persist failed: ${err}`);
	}
}

/**
 * Convert browser answer format `Record<string, string>` to OpenCode's
 * `string[][]` format.  Each numeric key maps to one question; the value
 * is a single selected label (or comma-separated labels for multi-select).
 */
function formatAnswers(rawAnswers: Record<string, string>): string[][] {
	const formatted: string[][] = [];
	const keys = Object.keys(rawAnswers)
		.map(Number)
		.filter((n) => !Number.isNaN(n))
		.sort((a, b) => a - b);
	for (const key of keys) {
		const val = rawAnswers[String(key)] ?? "";
		formatted.push(val ? [val] : []);
	}
	return formatted;
}

export async function handleAskUserResponse(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["ask_user_response"],
): Promise<void> {
	const { toolId, answers } = payload;
	const sessionId = resolveSession(deps, clientId) ?? "";

	const formatted = formatAnswers(answers);

	// The toolId from the frontend is the `que_` ID that was included in the
	// `ask_user` WebSocket message.  Call the OpenCode API directly.
	deps.log.info(
		`client=${clientId} session=${sessionId} answering: ${toolId} payload=${JSON.stringify({ id: toolId, answers: formatted })}`,
	);

	// Route through OrchestrationEngine for Claude sessions so the answer
	// reaches RelayEventSink.resolveQuestion() and unblocks the SDK turn.
	if (deps.orchestrationEngine && sessionId) {
		const providerId =
			deps.orchestrationEngine.getProviderForSession(sessionId);
		if (providerId === "claude") {
			try {
				await deps.orchestrationEngine.dispatch({
					type: "resolve_question",
					sessionId,
					requestId: toolId,
					answers: answers as Record<string, unknown>,
				});
				deps.wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId,
					sessionId,
				});
				if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
				restartProcessingTimeout(deps, sessionId);
				return;
			} catch (err) {
				deps.log.warn(
					`client=${clientId} session=${sessionId} engine resolve_question failed: ${err}`,
				);
			}
		}
	}

	try {
		await deps.client.question.reply(toolId, formatted);
		deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId, sessionId });
		if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
		restartProcessingTimeout(deps, sessionId);
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} replyQuestion failed for ${toolId}: ${err}`,
		);

		// API rejected the toolId — fall back to querying pending questions
		// and replying to the first match.
		try {
			const pendingQuestions = await deps.client.question.list();
			if (pendingQuestions.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				const queId = pendingQuestions[0]!.id;
				deps.log.info(
					`client=${clientId} session=${sessionId} API fallback: ${toolId} → ${queId}`,
				);
				await deps.client.question.reply(queId, formatted);
				deps.wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId: queId,
					sessionId,
				});
				if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
				restartProcessingTimeout(deps, sessionId);
				return;
			}
		} catch (fallbackErr) {
			deps.log.warn(
				`client=${clientId} session=${sessionId} API fallback also failed: ${fallbackErr}`,
			);
		}

		deps.log.warn(
			`client=${clientId} session=${sessionId} answer DROPPED (no pending question found): ${toolId}`,
		);

		// Notify the frontend so the QuestionCard can show an error
		// instead of silently reverting after 10s timeout.
		deps.wsHandler.sendTo(clientId, {
			type: "ask_user_error",
			sessionId,
			toolId,
			message:
				"This question was asked in a terminal session and can't be answered from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	}
}

export async function handleQuestionReject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["question_reject"],
): Promise<void> {
	const { toolId } = payload;
	if (!toolId) return;

	const sessionId = resolveSession(deps, clientId) ?? "";

	deps.log.info(`client=${clientId} session=${sessionId} rejecting: ${toolId}`);

	// Route through OrchestrationEngine for Claude sessions — resolve with
	// empty answers to signal rejection (the SDK interprets {} as skip).
	if (deps.orchestrationEngine && sessionId) {
		const providerId =
			deps.orchestrationEngine.getProviderForSession(sessionId);
		if (providerId === "claude") {
			try {
				await deps.orchestrationEngine.dispatch({
					type: "resolve_question",
					sessionId,
					requestId: toolId,
					answers: {},
				});
				deps.wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId,
					sessionId,
				});
				if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
				restartProcessingTimeout(deps, sessionId);
				return;
			} catch (err) {
				deps.log.warn(
					`client=${clientId} session=${sessionId} engine resolve_question (reject) failed: ${err}`,
				);
			}
		}
	}

	try {
		await deps.client.question.reject(toolId);
		deps.wsHandler.broadcast({ type: "ask_user_resolved", toolId, sessionId });
		if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
		restartProcessingTimeout(deps, sessionId);
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} rejectQuestion failed for ${toolId}: ${err}`,
		);

		// API rejected the toolId — fall back to querying pending questions
		try {
			const pendingQuestions = await deps.client.question.list();
			if (pendingQuestions.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				const queId = pendingQuestions[0]!.id;
				deps.log.info(
					`client=${clientId} session=${sessionId} reject fallback: ${toolId} → ${queId}`,
				);
				await deps.client.question.reject(queId);
				deps.wsHandler.broadcast({
					type: "ask_user_resolved",
					toolId: queId,
					sessionId,
				});
				if (sessionId) deps.sessionMgr.decrementPendingQuestionCount(sessionId);
				restartProcessingTimeout(deps, sessionId);
				return;
			}
		} catch (fallbackErr) {
			deps.log.warn(
				`client=${clientId} session=${sessionId} reject fallback also failed: ${fallbackErr}`,
			);
		}

		// Notify the frontend so the QuestionCard can show an error
		deps.wsHandler.sendTo(clientId, {
			type: "ask_user_error",
			sessionId,
			toolId,
			message:
				"This question was asked in a terminal session and can't be skipped from the browser. Answer it in the terminal, or send a follow-up message to continue.",
		});
	}
}
