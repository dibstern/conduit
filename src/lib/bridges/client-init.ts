// ─── Client Init (Ticket 3.6) ────────────────────────────────────────────────
// Handles the initial handshake when a browser client connects via WebSocket.
// Sends session info (with cached events or REST API history), model info,
// agent list, provider/model list, and PTY replay to the new client.
//
// Extracted from relay-stack.ts's `client_connected` handler so the logic is
// independently testable and relay-stack stays slim.

import { mapQuestionFields } from "../bridges/question-bridge.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { filterAgents, getSessionInputDraft } from "../handlers/index.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Logger } from "../logger.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { OrchestrationEngine } from "../provider/orchestration-engine.js";
import type { PtyManager } from "../relay/pty-manager.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import {
	type SessionSwitchDeps,
	switchClientToSession,
} from "../session/session-switch.js";
import type { PtyInfo } from "../shared-types.js";
import type { OpenCodeInstance, RelayMessage } from "../types.js";
import type { PermissionBridge } from "./permission-bridge.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface ClientInitDeps {
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendTo: (clientId: string, msg: RelayMessage) => void;
		setClientSession: (clientId: string, sessionId: string) => void;
	};
	client: OpenCodeAPI;
	sessionMgr: SessionManager;
	overrides: SessionOverrides;
	ptyManager: PtyManager;
	permissionBridge: Pick<PermissionBridge, "getPending" | "recoverPending">;
	/** Optional poller for session processing state */
	statusPoller?: Pick<
		SessionStatusPoller,
		"isProcessing" | "getCurrentStatuses"
	>;
	/** Optional supplier of the current OpenCode instance list */
	getInstances?: () => ReadonlyArray<Readonly<OpenCodeInstance>>;
	/** Optional supplier of cached update version (for replaying to new clients) */
	getCachedUpdate?: () => string | null;
	/** Optional orchestration engine for Claude SDK model discovery */
	orchestrationEngine?: OrchestrationEngine;
	/** SQLite read query service (optional — absent when persistence is not configured) */
	readQuery?: ReadQueryService;
	log: Logger;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Handle a newly connected browser client. Sends all initial state:
 * - Active session with cached events or REST API history
 * - Session list
 * - Model info (from session or overrides)
 * - Agent list (filtered)
 * - Provider/model list (connected only)
 * - PTY list + scrollback replay
 *
 * When `requestedSessionId` is provided (via ?session= WS query param),
 * it overrides the global active session for this client's init — preventing
 * a flash of wrong content when opening a session link in a new tab.
 *
 * Errors are sent as INIT_FAILED messages without crashing the handler.
 */
export async function handleClientConnected(
	deps: ClientInitDeps,
	clientId: string,
	requestedSessionId?: string,
): Promise<void> {
	const {
		wsHandler,
		client,
		sessionMgr,
		overrides,
		ptyManager,
		permissionBridge,
	} = deps;

	const sendInitError = (err: unknown, prefix: string) => {
		deps.log.warn(`${prefix}: ${formatErrorDetail(err)}`);
		wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "INIT_FAILED", prefix).toMessage(),
		);
	};

	// ── Active session with event replay ─────────────────────────────────
	// Use the requested session (from ?session= query param) if provided,
	// otherwise compute the default (most recent or newly created).
	const activeId =
		requestedSessionId || (await sessionMgr.getDefaultSessionId());
	if (activeId) {
		// pollerManager intentionally omitted — not available in ClientInitDeps.
		// skipPollerSeed: true ensures switchClientToSession never accesses it.
		// The `satisfies` check guarantees a compile error if SessionSwitchDeps
		// adds new required fields that this object doesn't provide.
		await switchClientToSession(
			{
				sessionMgr,
				wsHandler,
				...(deps.statusPoller != null && { statusPoller: deps.statusPoller }),
				log: deps.log,
				getInputDraft: getSessionInputDraft,
				...(deps.readQuery != null && { readQuery: deps.readQuery }),
			} satisfies SessionSwitchDeps,
			clientId,
			activeId,
			{ skipPollerSeed: true },
		);

		// Send model/agent info from the active session
		try {
			const session = await client.session.get(activeId);
			if (session.modelID) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: session.modelID,
					provider: session.providerID ?? "",
				});
			} else {
				// Session has no model set — fall back to per-session override or default
				const fallbackModel = overrides.getModel(activeId);
				if (fallbackModel) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: fallbackModel.modelID,
						provider: fallbackModel.providerID,
					});
				}
			}
		} catch (err) {
			sendInitError(err, "Failed to load session info");
			const fallbackModel = overrides.getModel(activeId);
			if (fallbackModel) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: fallbackModel.modelID,
					provider: fallbackModel.providerID,
				});
			}
		}
	}

	// ── Session list ─────────────────────────────────────────────────────
	try {
		const statuses = deps.statusPoller?.getCurrentStatuses();
		await sessionMgr.sendDualSessionLists(
			(msg) => wsHandler.sendTo(clientId, msg),
			{ statuses },
		);
	} catch (err) {
		sendInitError(err, "Failed to list sessions");
	}

	// ── Pending permissions + questions (reconnect replay) ───────────────
	// First replay any permissions already tracked in-memory by the bridge.
	const bridgePending = permissionBridge.getPending();
	const sentPermissionIds = new Set<string>();
	for (const perm of bridgePending) {
		wsHandler.sendTo(clientId, {
			type: "permission_request",
			sessionId: perm.sessionId,
			requestId: perm.requestId,
			toolName: perm.toolName,
			toolInput: perm.toolInput,
		});
		sentPermissionIds.add(perm.requestId);
	}
	// Then fetch from the API to recover any permissions the bridge missed
	// (e.g. relay restart, SSE event lost). Dedup against already-sent IDs.
	try {
		const apiPermissions = await client.permission.list();
		const newPerms = apiPermissions.filter((p) => !sentPermissionIds.has(p.id));
		if (newPerms.length > 0) {
			const recovered = permissionBridge.recoverPending(
				newPerms.map((p) => {
					const raw = p as {
						id: string;
						permission: string;
						sessionID?: string;
						patterns?: string[];
						metadata?: Record<string, unknown>;
						always?: string[];
					};
					return {
						id: raw.id,
						permission: raw.permission,
						...(raw.sessionID != null && { sessionId: raw.sessionID }),
						...(raw.patterns != null && { patterns: raw.patterns }),
						...(raw.metadata != null && { metadata: raw.metadata }),
						...(raw.always != null && { always: raw.always }),
					};
				}),
			);
			for (const perm of recovered) {
				wsHandler.sendTo(clientId, {
					type: "permission_request",
					sessionId: perm.sessionId,
					requestId: perm.requestId,
					toolName: perm.toolName,
					toolInput: perm.toolInput,
				});
			}
		}
	} catch (err) {
		deps.log.warn(
			`Failed to fetch pending permissions from API: ${formatErrorDetail(err)}`,
		);
	}
	// Replay pending questions for the client's active session only
	try {
		const pendingQuestions = await client.question.list();
		deps.log.debug(
			`client=${clientId} listPendingQuestions returned ${pendingQuestions.length} question(s)${pendingQuestions.length > 0 ? `: ${JSON.stringify(pendingQuestions.map((q) => ({ id: q.id, hasQuestions: !!q["questions"], hasTool: !!q["tool"] })))}` : ""}`,
		);
		for (const pq of pendingQuestions) {
			// Filter: only send questions belonging to the client's active session
			const qSessionId = pq["sessionID"] as string | undefined;
			if (qSessionId && activeId && qSessionId !== activeId) continue;

			const rawQuestions = pq["questions"] as
				| Array<{
						question?: string;
						header?: string;
						options?: Array<{ label?: string; description?: string }>;
						multiple?: boolean;
						custom?: boolean;
				  }>
				| undefined;
			if (!Array.isArray(rawQuestions)) {
				deps.log.debug(
					`client=${clientId} skipping question ${pq.id}: questions field is not an array (${typeof pq["questions"]})`,
				);
				continue;
			}
			const questions = mapQuestionFields(rawQuestions);
			const tool = pq["tool"] as { callID?: string } | undefined;
			const toolCallId = tool?.callID;
			deps.log.debug(
				`client=${clientId} sending ask_user: toolId=${pq.id} toolUseId=${toolCallId ?? "none"} questionCount=${questions.length}`,
			);
			wsHandler.sendTo(clientId, {
				type: "ask_user",
				toolId: pq.id,
				questions,
				...(toolCallId ? { toolUseId: toolCallId } : {}),
			});
		}
	} catch (err) {
		deps.log.warn(
			`Failed to replay pending questions: ${formatErrorDetail(err)}`,
		);
	}

	// ── Agent list (filter out internal agents) ──────────────────────────
	try {
		const rawAgents = await client.app.agents();
		const agents = filterAgents(rawAgents);
		wsHandler.sendTo(clientId, { type: "agent_list", agents });
	} catch (err) {
		sendInitError(err, "Failed to list agents");
	}

	// ── Provider/model list + auto-select default ────────────────────────
	try {
		const providerResult = await client.provider.list();
		const connectedSet = new Set(providerResult.connected);
		const providers = providerResult.providers
			.map((p) => ({
				id: p.id || p.name || "",
				name: p.name || p.id || "",
				configured: connectedSet.has(p.id) || connectedSet.has(p.name),
				models: (p.models ?? []).map((m) => ({
					id: m.id,
					name: m.name || m.id,
					provider: p.id || p.name || "",
					...(m.limit && { limit: m.limit }),
					...(m.variants &&
						Object.keys(m.variants).length > 0 && {
							variants: Object.keys(m.variants),
						}),
				})),
			}))
			.filter((p) => p.configured);

		// Merge Claude in-process models when the orchestration engine is available.
		// Mirrors handleGetModels so the initial client_connected payload doesn't
		// overwrite the merged list the client later receives from get_models.
		//   "Anthropic - opencode" → routes via OpenCode REST API
		//   "Anthropic - claude"  → routes via in-process Claude Agent SDK
		if (deps.orchestrationEngine) {
			try {
				const claudeCaps = await deps.orchestrationEngine.dispatch({
					type: "discover",
					providerId: "claude",
				});
				if (claudeCaps.models.length > 0) {
					for (const p of providers) {
						if (p.id === "anthropic") {
							p.name = "Anthropic - opencode";
						}
					}
					providers.push({
						id: "claude",
						name: "Anthropic - claude",
						configured: true,
						models: claudeCaps.models.map((m) => ({
							id: m.id,
							name: m.name,
							provider: "claude",
							...(m.limit ? { limit: m.limit } : {}),
						})),
					});
				}
			} catch {
				// Claude adapter may not be available — skip silently
			}
		}

		wsHandler.sendTo(clientId, { type: "model_list", providers });

		// Send variant info — current thinking level and available variants
		// for the active model (per-session when available, global fallback)
		const currentVariant = activeId
			? overrides.getVariant(activeId)
			: overrides.defaultVariant;
		const activeModelId = activeId
			? overrides.getModel(activeId)?.modelID
			: overrides.defaultModel?.modelID;
		let availableVariants: string[] = [];
		if (activeModelId) {
			for (const p of providers) {
				const model = p.models.find(
					(m: { id: string; variants?: string[] }) => m.id === activeModelId,
				);
				if (model?.variants) {
					availableVariants = model.variants;
					break;
				}
			}
		}
		wsHandler.sendTo(clientId, {
			type: "variant_info",
			variant: currentVariant,
			variants: availableVariants,
		});

		// Send default model info to new client
		if (overrides.defaultModel) {
			wsHandler.sendTo(clientId, {
				type: "default_model_info",
				model: overrides.defaultModel.modelID,
				provider: overrides.defaultModel.providerID,
			});
		}

		// Auto-select default model if none set.
		// Priority: defaultModel (seeded from config or user-set) > provider-level default.
		if (!overrides.defaultModel) {
			// Fallback: first connected provider's default model
			for (const providerId of providerResult.connected) {
				const defaultModelId = providerResult.defaults[providerId];
				if (defaultModelId) {
					overrides.setDefaultModel({
						providerID: providerId,
						modelID: defaultModelId,
					});
					wsHandler.broadcast({
						type: "model_info",
						model: defaultModelId,
						provider: providerId,
					});
					deps.log.info(
						`Auto-selected default: ${defaultModelId} (${providerId})`,
					);
					break;
				}
			}
		} else if (connectedSet.has(overrides.defaultModel.providerID)) {
			// Broadcast existing default to new client
			wsHandler.sendTo(clientId, {
				type: "model_info",
				model: overrides.defaultModel.modelID,
				provider: overrides.defaultModel.providerID,
			});
			deps.log.info(
				`Default: ${overrides.defaultModel.modelID} (${overrides.defaultModel.providerID})`,
			);
		}
	} catch (err) {
		sendInitError(err, "Failed to list providers");
	}

	// ── PTY list + scrollback replay ─────────────────────────────────────
	if (ptyManager.sessionCount > 0) {
		const ptys = ptyManager.listSessions();
		wsHandler.sendTo(clientId, {
			type: "pty_list",
			// PtyManager.listSessions() returns minimal {id, status} objects;
			// the frontend only uses those fields from the pty_list message.
			ptys: ptys as unknown as PtyInfo[],
		});
		// Replay scrollback for each PTY to this specific client
		for (const { id: ptyId } of ptys) {
			const scrollback = ptyManager.getScrollback(ptyId);
			if (scrollback) {
				wsHandler.sendTo(clientId, {
					type: "pty_output",
					ptyId,
					data: scrollback,
				});
			}
			const session = ptyManager.getSession(ptyId);
			if (session?.exited) {
				wsHandler.sendTo(clientId, {
					type: "pty_exited",
					ptyId,
					exitCode: session.exitCode ?? 0,
				});
			}
		}
	}

	// ── Instance list ─────────────────────────────────────────────────────
	if (deps.getInstances) {
		const instances = deps.getInstances();
		wsHandler.sendTo(clientId, { type: "instance_list", instances });
	}

	// ── Cached update notification ───────────────────────────────────────
	if (deps.getCachedUpdate) {
		const version = deps.getCachedUpdate();
		if (version) {
			wsHandler.sendTo(clientId, { type: "update_available", version });
		}
	}
}
