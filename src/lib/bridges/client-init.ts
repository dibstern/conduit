// ─── Client Init (Ticket 3.6) ────────────────────────────────────────────────
// Handles the initial handshake when a browser client connects via WebSocket.
// Sends session info (with cached events or REST API history), model info,
// agent list, provider/model list, and PTY replay to the new client.
//
// Extracted from relay-stack.ts's `client_connected` handler so the logic is
// independently testable and relay-stack stays slim.

import { Effect } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import type { AgentList } from "../domain/relay/Services/agent-service.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import type {
	PendingPermissionRecoveryInput,
	PendingQuestion,
} from "../domain/relay/Services/pending-interaction-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import type {
	OpenCodeProviderList,
	OpenCodeSessionDetail,
} from "../domain/relay/Services/services.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { ModelOverride } from "../domain/relay/Services/session-overrides-state.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getDefaultVariant,
	getModel,
	getVariant,
	hasActiveProcessingTimeout,
	setDefaultModel,
} from "../domain/relay/Services/session-overrides-state.js";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { getSessionInputDraft } from "../handlers/index.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Logger } from "../logger.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import type { ProviderCapabilities } from "../provider/types.js";
import {
	buildSessionSwitchedMessage,
	extractOldestMessageId,
	patchMissingDoneForProcessingState,
	resolveSessionHistoryFromRows,
	type SessionHistorySource,
	type SessionSwitchDeps,
	switchClientToSession,
} from "../session/session-switch.js";
import type { ContextWindowOption } from "../shared-types.js";
import type {
	OpenCodeInstance,
	PendingPermission,
	ProviderInfo,
	RelayMessage,
} from "../types.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

/** Effect-backed session bootstrap capabilities needed by client-init. */
export interface ClientInitSessionService {
	getDefaultSessionId(title?: string): Promise<string>;
	sendDualSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: {
			statuses?:
				| Record<string, import("../instance/sdk-types.js").SessionStatus>
				| undefined;
		},
	): Promise<void>;
	resolveSessionHistory(sessionId: string): Promise<SessionHistorySource>;
	loadPreRenderedHistory(
		sessionId: string,
		offset?: number,
	): Promise<{
		messages: import("../shared-types.js").HistoryMessage[];
		hasMore: boolean;
		total?: number;
	}>;
	seedPaginationCursor(
		sessionId: string,
		messageId: string,
	): void | Promise<void>;
	getLastMessageAtMap?(): ReadonlyMap<string, number>;
}

export interface ClientInitOverrideState {
	getModel(sessionId: string): Promise<ModelOverride | undefined>;
	getDefaultModel(): Promise<ModelOverride | undefined>;
	getVariant(sessionId: string): Promise<string>;
	getDefaultVariant(): Promise<string>;
	getContextWindow(sessionId: string): Promise<string>;
	getDefaultContextWindow(): Promise<string>;
	setDefaultModel(model: ModelOverride): Promise<void>;
	hasActiveProcessingTimeout(sessionId: string): Promise<boolean>;
}

function findContextWindowOptions(
	providers: ReadonlyArray<{
		models: ReadonlyArray<{
			id: string;
			contextWindowOptions?: readonly ContextWindowOption[];
		}>;
	}>,
	modelId: string | undefined,
): readonly ContextWindowOption[] {
	if (!modelId) return [];
	for (const provider of providers) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model?.contextWindowOptions) return model.contextWindowOptions;
	}
	return [];
}

function toConfiguredOpenCodeProviders(
	providerResult: OpenCodeProviderList,
): ProviderInfo[] {
	const connectedSet = new Set(providerResult.connected);
	return providerResult.providers
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
}

function addClaudeProvider(
	providers: ProviderInfo[],
	capabilities: ProviderCapabilities,
): boolean {
	if (capabilities.models.length === 0) return false;
	for (const p of providers) {
		if (p.id === "anthropic") {
			p.name = "Anthropic - opencode";
		}
	}
	providers.push({
		id: "claude",
		name: "Anthropic - claude",
		configured: true,
		models: capabilities.models.map((m) => ({
			id: m.id,
			name: m.name,
			provider: "claude",
			...(m.limit ? { limit: m.limit } : {}),
			...(m.variants && Object.keys(m.variants).length > 0
				? { variants: Object.keys(m.variants) }
				: {}),
			...(m.contextWindowOptions && m.contextWindowOptions.length > 0
				? {
						contextWindowOptions: m.contextWindowOptions.map((option) => ({
							value: option.value,
							label: option.label,
							...(option.isDefault != null
								? { isDefault: option.isDefault }
								: {}),
						})),
					}
				: {}),
		})),
	});
	return true;
}

export interface ClientInitDeps {
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendTo: (clientId: string, msg: RelayMessage) => void;
		setClientSession: (clientId: string, sessionId: string) => void;
		/**
		 * Phase 0b: called after the initial `session_list` has been
		 * dispatched so that any per-session events buffered during bootstrap
		 * are flushed to the client in the order they were produced.
		 */
		markClientBootstrapped: (clientId: string) => void;
	};
	client: OpenCodeAPI;
	sessionService: ClientInitSessionService;
	overrideState: ClientInitOverrideState;
	terminal: {
		replay(clientId: string): Promise<void>;
	};
	agentService: {
		listAgents(activeSessionId: string | undefined): Promise<AgentList>;
	};
	modelService: {
		getSession(sessionId: string): Promise<OpenCodeSessionDetail>;
		listProviders(): Promise<OpenCodeProviderList>;
	};
	pendingInteractions: {
		listPendingPermissions(): Promise<PendingPermission[]>;
		recoverPendingPermissions(
			permissions: readonly PendingPermissionRecoveryInput[],
		): Promise<PendingPermission[]>;
		listPendingQuestions(sessionId?: string): Promise<PendingQuestion[]>;
	};
	/** Optional legacy sync snapshot for Promise-shaped unit callers. */
	statusPoller?: {
		isProcessing(sessionId: string): boolean;
		getCurrentStatuses(): Record<
			string,
			import("../instance/sdk-types.js").SessionStatus
		>;
	};
	/** Optional supplier of the current OpenCode instance list */
	getInstances?: () =>
		| ReadonlyArray<Readonly<OpenCodeInstance>>
		| PromiseLike<ReadonlyArray<Readonly<OpenCodeInstance>>>;
	/** Optional supplier of cached update version (for replaying to new clients) */
	getCachedUpdate?: () => string | null | PromiseLike<string | null>;
	/** Optional Claude SDK capability discovery, provided by the relay Effect runtime. */
	discoverClaudeCapabilities?: () => Promise<ProviderCapabilities>;
	log: Logger;
}

export interface ClientInitEffectOptions {
	readonly getInstances?: () =>
		| ReadonlyArray<Readonly<OpenCodeInstance>>
		| PromiseLike<ReadonlyArray<Readonly<OpenCodeInstance>>>;
	readonly getCachedUpdate?: () => string | null | PromiseLike<string | null>;
}

const sendInitErrorEffect = (clientId: string, err: unknown, prefix: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		log.warn(`${prefix}: ${formatErrorDetail(err)}`);
		wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "INIT_FAILED", prefix).toSystemError(),
		);
	});

const resolveClientInitHistoryEffect = (sessionId: string) =>
	Effect.gen(function* () {
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		if (readQueryOption._tag === "Some") {
			const rows =
				yield* readQueryOption.value.getSessionMessagesWithParts(sessionId);
			return resolveSessionHistoryFromRows(rows, { pageSize: 50 });
		}

		const sessionManagerService = yield* SessionManagerServiceTag;
		const historyResult = yield* Effect.either(
			sessionManagerService.loadPreRenderedHistory(sessionId),
		);
		if (historyResult._tag === "Right") {
			return {
				kind: "rest-history",
				history: historyResult.right,
			} satisfies SessionHistorySource;
		}

		const logger = yield* LoggerTag;
		logger.warn(
			`Failed to load client init history for ${sessionId}: ${formatErrorDetail(historyResult.left)}`,
		);
		return { kind: "empty" } satisfies SessionHistorySource;
	});

const seedPaginationCursorFromHistoryEffect = (
	sessionId: string,
	source: SessionHistorySource,
) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		let oldestMessageId: string | undefined;

		if (source.kind === "cached-events" && source.hasMore) {
			oldestMessageId = extractOldestMessageId(source.events);
		} else if (source.kind === "rest-history" && source.history.hasMore) {
			oldestMessageId = source.history.messages[0]?.id;
		}

		if (oldestMessageId) {
			yield* sessionManagerService.seedPaginationCursor(
				sessionId,
				oldestMessageId,
			);
		}
	});

const switchClientToSessionForInitEffect = (
	clientId: string,
	sessionId: string,
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;
		const statusPoller = yield* StatusPollerTag;
		const hasActiveTimeout = yield* hasActiveProcessingTimeout(sessionId);

		wsHandler.setClientSession(clientId, sessionId);

		const sourceResult = yield* Effect.either(
			resolveClientInitHistoryEffect(sessionId),
		);
		const source =
			sourceResult._tag === "Right"
				? sourceResult.right
				: ({ kind: "empty" } satisfies SessionHistorySource);
		if (sourceResult._tag === "Left") {
			const log = yield* LoggerTag;
			log.warn(
				`Failed to load history for ${sessionId}: ${formatErrorDetail(sourceResult.left)}`,
			);
		}

		const pollerIsProcessing = yield* statusPoller.isProcessing(sessionId);
		const patchedSource = patchMissingDoneForProcessingState(
			source,
			sessionId,
			pollerIsProcessing || hasActiveTimeout,
		);
		yield* seedPaginationCursorFromHistoryEffect(sessionId, patchedSource);

		const draft = getSessionInputDraft(sessionId);
		wsHandler.sendTo(
			clientId,
			buildSessionSwitchedMessage(sessionId, patchedSource, {
				...(draft ? { draft } : {}),
			}),
		);
		wsHandler.sendTo(clientId, {
			type: "status",
			sessionId,
			status: pollerIsProcessing || hasActiveTimeout ? "processing" : "idle",
		});
	});

/**
 * Effect-owned production client bootstrap. This is the canonical relay path;
 * handleClientConnected() below remains for the existing Promise-shaped unit
 * tests while production no longer builds service bridges in relay-stack.
 */
export const handleClientConnectedEffect = (
	clientId: string,
	requestedSessionId?: string,
	options: ClientInitEffectOptions = {},
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const client = yield* OpenCodeAPITag;
		const sessionService = yield* SessionManagerServiceTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const agentService = yield* AgentServiceTag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const terminal = yield* OpenCodeTerminalServiceTag;
		const statusPoller = yield* StatusPollerTag;
		const engine = yield* OrchestrationEngineTag;
		const log = yield* LoggerTag;

		const activeIdResult = requestedSessionId
			? yield* Effect.succeed({
					_tag: "Right",
					right: requestedSessionId,
				} as const)
			: yield* Effect.either(sessionService.getDefaultSessionId());
		const activeId =
			activeIdResult._tag === "Right" ? activeIdResult.right : undefined;
		if (activeIdResult._tag === "Left") {
			yield* sendInitErrorEffect(
				clientId,
				activeIdResult.left,
				"Failed to load default session",
			);
		}

		let activeSessionModel: ModelOverride | undefined;
		if (activeId) {
			yield* switchClientToSessionForInitEffect(clientId, activeId);

			const sessionInfoResult = yield* Effect.either(
				modelService.getSession(activeId),
			);
			if (sessionInfoResult._tag === "Right") {
				const session = sessionInfoResult.right;
				if (session.modelID) {
					activeSessionModel = {
						modelID: session.modelID,
						providerID: session.providerID ?? "",
					};
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: session.modelID,
						provider: session.providerID ?? "",
					});
				} else {
					const fallbackModel = yield* getModel(activeId);
					if (fallbackModel) {
						wsHandler.sendTo(clientId, {
							type: "model_info",
							model: fallbackModel.modelID,
							provider: fallbackModel.providerID,
						});
					}
				}
			} else {
				yield* Effect.sync(() =>
					log.warn(
						`Failed to load session info for ${activeId}: ${sessionInfoResult.left}`,
					),
				);
				const fallbackModel = yield* getModel(activeId);
				if (fallbackModel) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: fallbackModel.modelID,
						provider: fallbackModel.providerID,
					});
				}
			}
		}

		yield* sessionService
			.sendDualSessionLists((msg) => wsHandler.sendTo(clientId, msg), {
				statuses: yield* statusPoller.getCurrentStatuses(),
			})
			.pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to list sessions"),
				),
				Effect.ensuring(
					Effect.sync(() => wsHandler.markClientBootstrapped(clientId)),
				),
			);

		const servicePending = yield* pendingInteractions.listPendingPermissions();
		const sentPermissionIds = new Set<string>();
		for (const perm of servicePending) {
			wsHandler.sendTo(clientId, {
				type: "permission_request",
				sessionId: perm.sessionId,
				requestId: perm.requestId,
				toolName: perm.toolName,
				toolInput: perm.toolInput,
			});
			sentPermissionIds.add(perm.requestId);
		}

		const apiPermissionsResult = yield* Effect.either(
			Effect.gen(function* () {
				const apiPermissions = yield* Effect.tryPromise(() =>
					client.permission.list(),
				);
				const newPerms = apiPermissions.filter(
					(p) => !sentPermissionIds.has(p.id),
				);
				if (newPerms.length === 0) return;

				const recoveryInput = newPerms.map((p) => {
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
				});
				const recovered =
					yield* pendingInteractions.recoverPendingPermissions(recoveryInput);
				for (const perm of recovered) {
					wsHandler.sendTo(clientId, {
						type: "permission_request",
						sessionId: perm.sessionId,
						requestId: perm.requestId,
						toolName: perm.toolName,
						toolInput: perm.toolInput,
					});
				}
			}),
		);
		if (apiPermissionsResult._tag === "Left") {
			log.warn(
				`Failed to fetch pending permissions from API: ${formatErrorDetail(apiPermissionsResult.left)}`,
			);
		}

		const questionReplayResult = yield* Effect.either(
			Effect.gen(function* () {
				const sentQuestionIds = new Set<string>();
				const servicePendingQuestions =
					yield* pendingInteractions.listPendingQuestions(activeId);
				for (const pq of servicePendingQuestions) {
					if (pq.sessionId && activeId && pq.sessionId !== activeId) continue;
					wsHandler.sendTo(clientId, {
						type: "ask_user",
						sessionId: pq.sessionId || activeId || "",
						toolId: pq.requestId,
						questions: pq.questions.map((q) => ({
							question: q.question,
							header: q.header ?? "",
							options: (q.options ?? []) as Array<{
								label: string;
								description?: string;
							}>,
							multiSelect: q.multiSelect ?? false,
						})),
						...(pq.toolCallId ? { toolUseId: pq.toolCallId } : {}),
						...(pq.providerId ? { providerId: pq.providerId } : {}),
					});
					sentQuestionIds.add(pq.requestId);
				}
				const pendingQuestions = yield* Effect.tryPromise(() =>
					client.question.list(),
				);
				log.debug(
					`client=${clientId} listPendingQuestions returned ${pendingQuestions.length} question(s)${pendingQuestions.length > 0 ? `: ${JSON.stringify(pendingQuestions.map((q) => ({ id: q.id, hasQuestions: !!q["questions"], hasTool: !!q["tool"] })))}` : ""}`,
				);
				for (const pq of pendingQuestions) {
					if (sentQuestionIds.has(pq.id)) continue;
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
						log.debug(
							`client=${clientId} skipping question ${pq.id}: questions field is not an array (${typeof pq["questions"]})`,
						);
						continue;
					}
					const questions = mapQuestionFields(rawQuestions);
					const tool = pq["tool"] as { callID?: string } | undefined;
					const toolCallId = tool?.callID;
					log.debug(
						`client=${clientId} sending ask_user: toolId=${pq.id} toolUseId=${toolCallId ?? "none"} questionCount=${questions.length}`,
					);
					wsHandler.sendTo(clientId, {
						type: "ask_user",
						sessionId: qSessionId ?? activeId ?? "",
						toolId: pq.id,
						questions,
						providerId: "opencode",
						...(toolCallId ? { toolUseId: toolCallId } : {}),
					});
				}
			}),
		);
		if (questionReplayResult._tag === "Left") {
			log.warn(
				`Failed to replay pending questions: ${formatErrorDetail(questionReplayResult.left)}`,
			);
		}

		const agentResult = yield* Effect.either(agentService.listAgents(activeId));
		if (agentResult._tag === "Right") {
			wsHandler.sendTo(clientId, {
				type: "agent_list",
				agents: [...agentResult.right.agents],
				...(agentResult.right.activeAgentId
					? { activeAgentId: agentResult.right.activeAgentId }
					: {}),
			});
		} else {
			yield* sendInitErrorEffect(
				clientId,
				agentResult.left,
				"Failed to list agents",
			);
		}

		const providerResult = yield* Effect.either(
			Effect.gen(function* () {
				const openCodeProviderResult = yield* Effect.either(
					modelService.listProviders(),
				);
				const providers =
					openCodeProviderResult._tag === "Right"
						? toConfiguredOpenCodeProviders(openCodeProviderResult.right)
						: [];
				if (openCodeProviderResult._tag === "Right") {
					wsHandler.sendTo(clientId, { type: "model_list", providers });
				} else {
					log.warn(
						`OpenCode provider discovery failed during client init: ${formatErrorDetail(openCodeProviderResult.left)}`,
					);
				}

				const claudeCapsResult = yield* Effect.either(
					engine.dispatchEffect({
						type: "discover",
						providerId: "claude",
					}),
				);
				if (
					claudeCapsResult._tag === "Right" &&
					addClaudeProvider(providers, claudeCapsResult.right)
				) {
					wsHandler.sendTo(clientId, { type: "model_list", providers });
				}
				if (
					openCodeProviderResult._tag === "Left" &&
					(claudeCapsResult._tag === "Left" || providers.length === 0)
				) {
					return yield* Effect.fail(openCodeProviderResult.left);
				}

				const currentVariant = activeId
					? yield* getVariant(activeId)
					: yield* getDefaultVariant();
				const activeModelOverride = activeId
					? yield* getModel(activeId)
					: yield* getDefaultModel();
				const activeModel = activeId
					? (activeModelOverride ?? activeSessionModel)
					: activeModelOverride;
				const activeModelId = activeModel?.modelID;
				let availableVariants: string[] = [];
				if (activeModelId) {
					for (const p of providers) {
						const model = p.models.find(
							(m: { id: string; variants?: string[] }) =>
								m.id === activeModelId,
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
				wsHandler.sendTo(clientId, {
					type: "context_window_info",
					contextWindow: activeId
						? yield* getContextWindow(activeId)
						: yield* getDefaultContextWindow(),
					options: findContextWindowOptions(providers, activeModelId),
				});

				const defaultModel = yield* getDefaultModel();
				if (defaultModel) {
					wsHandler.sendTo(clientId, {
						type: "default_model_info",
						model: defaultModel.modelID,
						provider: defaultModel.providerID,
					});
				}

				if (!defaultModel && openCodeProviderResult._tag === "Right") {
					for (const providerId of openCodeProviderResult.right.connected) {
						const defaultModelId =
							openCodeProviderResult.right.defaults[providerId];
						if (defaultModelId) {
							yield* setDefaultModel({
								providerID: providerId,
								modelID: defaultModelId,
							});
							wsHandler.broadcast({
								type: "model_info",
								model: defaultModelId,
								provider: providerId,
							});
							log.info(
								`Auto-selected default: ${defaultModelId} (${providerId})`,
							);
							break;
						}
					}
				} else if (
					!defaultModel &&
					providers.some((provider) => provider.id === "claude")
				) {
					const defaultClaudeModel = providers
						.find((provider) => provider.id === "claude")
						?.models.at(0);
					if (defaultClaudeModel) {
						yield* setDefaultModel({
							providerID: "claude",
							modelID: defaultClaudeModel.id,
						});
						wsHandler.broadcast({
							type: "model_info",
							model: defaultClaudeModel.id,
							provider: "claude",
						});
						log.info(
							`Auto-selected default: ${defaultClaudeModel.id} (claude)`,
						);
					}
				} else if (
					defaultModel &&
					providers.some((provider) => provider.id === defaultModel.providerID)
				) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: defaultModel.modelID,
						provider: defaultModel.providerID,
					});
					log.info(
						`Default: ${defaultModel.modelID} (${defaultModel.providerID})`,
					);
				}
			}),
		);
		if (providerResult._tag === "Left") {
			yield* sendInitErrorEffect(
				clientId,
				providerResult.left,
				"Failed to list providers",
			);
		}

		yield* terminal
			.replay(clientId)
			.pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to replay terminals"),
				),
			);

		if (options.getInstances) {
			const instances = yield* Effect.tryPromise({
				try: () => Promise.resolve(options.getInstances?.() ?? []),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to list instances").pipe(
						Effect.as([] as ReadonlyArray<Readonly<OpenCodeInstance>>),
					),
				),
			);
			wsHandler.sendTo(clientId, { type: "instance_list", instances });
		}

		if (options.getCachedUpdate) {
			const version = yield* Effect.tryPromise({
				try: () => Promise.resolve(options.getCachedUpdate?.() ?? null),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((err) =>
					sendInitErrorEffect(clientId, err, "Failed to replay update").pipe(
						Effect.as(null),
					),
				),
			);
			if (version) {
				wsHandler.sendTo(clientId, { type: "update_available", version });
			}
		}
	});

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
	const { wsHandler, client, sessionService, pendingInteractions } = deps;
	const { overrideState } = deps;

	const sendInitError = (err: unknown, prefix: string) => {
		deps.log.warn(`${prefix}: ${formatErrorDetail(err)}`);
		wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "INIT_FAILED", prefix).toSystemError(),
		);
	};

	// ── Active session with event replay ─────────────────────────────────
	// Use the requested session (from ?session= query param) if provided,
	// otherwise compute the default (most recent or newly created).
	const activeId =
		requestedSessionId || (await sessionService.getDefaultSessionId());
	let activeSessionModel: ModelOverride | undefined;
	if (activeId) {
		// pollerManager intentionally omitted — not available in ClientInitDeps.
		// skipPollerSeed: true ensures switchClientToSession never accesses it.
		// The `satisfies` check guarantees a compile error if SessionSwitchDeps
		// adds new required fields that this object doesn't provide.
		await switchClientToSession(
			{
				sessionMgr: sessionService,
				wsHandler,
				...(deps.statusPoller != null && { statusPoller: deps.statusPoller }),
				processingTimeouts: {
					hasActiveProcessingTimeout: overrideState.hasActiveProcessingTimeout,
				},
				log: deps.log,
				getInputDraft: getSessionInputDraft,
				resolveSessionHistory: sessionService.resolveSessionHistory,
			} satisfies SessionSwitchDeps,
			clientId,
			activeId,
			{ skipPollerSeed: true },
		);

		// Send model/agent info from the active session
		try {
			const session = await deps.modelService.getSession(activeId);
			if (session.modelID) {
				activeSessionModel = {
					modelID: session.modelID,
					providerID: session.providerID ?? "",
				};
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: session.modelID,
					provider: session.providerID ?? "",
				});
			} else {
				// Session has no model set — fall back to per-session override or default
				const fallbackModel = await overrideState.getModel(activeId);
				if (fallbackModel) {
					wsHandler.sendTo(clientId, {
						type: "model_info",
						model: fallbackModel.modelID,
						provider: fallbackModel.providerID,
					});
				}
			}
		} catch (err) {
			deps.log.warn(
				`Failed to load session info for ${activeId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			const fallbackModel = await overrideState.getModel(activeId);
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
	// Phase 0b: session_list-first invariant — emit the initial session_list
	// before marking the client bootstrapped. Any per-session events that
	// fired on the project firehose during bootstrap are buffered
	// per-client by WebSocketHandler and flushed by markClientBootstrapped.
	try {
		const statuses = deps.statusPoller?.getCurrentStatuses();
		await sessionService.sendDualSessionLists(
			(msg) => wsHandler.sendTo(clientId, msg),
			{ statuses },
		);
	} catch (err) {
		sendInitError(err, "Failed to list sessions");
	} finally {
		// Mark bootstrapped even if session_list failed — otherwise the
		// client's queue would grow unbounded. A failed bootstrap still
		// emits INIT_FAILED, and the frontend handles the error path.
		wsHandler.markClientBootstrapped(clientId);
	}

	// ── Pending permissions + questions (reconnect replay) ───────────────
	// First replay any permissions already tracked by the pending interaction service.
	const servicePending = await pendingInteractions.listPendingPermissions();
	const sentPermissionIds = new Set<string>();
	for (const perm of servicePending) {
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
			const recoveryInput = newPerms.map((p) => {
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
			});
			const recovered =
				await pendingInteractions.recoverPendingPermissions(recoveryInput);
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
		const sentQuestionIds = new Set<string>();
		const servicePendingQuestions =
			await pendingInteractions.listPendingQuestions(activeId);
		for (const pq of servicePendingQuestions) {
			if (pq.sessionId && activeId && pq.sessionId !== activeId) continue;
			wsHandler.sendTo(clientId, {
				type: "ask_user",
				sessionId: pq.sessionId || activeId || "",
				toolId: pq.requestId,
				questions: pq.questions.map((q) => ({
					question: q.question,
					header: q.header ?? "",
					options: (q.options ?? []) as Array<{
						label: string;
						description?: string;
					}>,
					multiSelect: q.multiSelect ?? false,
				})),
				...(pq.toolCallId ? { toolUseId: pq.toolCallId } : {}),
				...(pq.providerId ? { providerId: pq.providerId } : {}),
			});
			sentQuestionIds.add(pq.requestId);
		}
		const pendingQuestions = await client.question.list();
		deps.log.debug(
			`client=${clientId} listPendingQuestions returned ${pendingQuestions.length} question(s)${pendingQuestions.length > 0 ? `: ${JSON.stringify(pendingQuestions.map((q) => ({ id: q.id, hasQuestions: !!q["questions"], hasTool: !!q["tool"] })))}` : ""}`,
		);
		for (const pq of pendingQuestions) {
			if (sentQuestionIds.has(pq.id)) continue;
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
				sessionId: qSessionId ?? activeId ?? "",
				toolId: pq.id,
				questions,
				providerId: "opencode",
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
		const result = await deps.agentService.listAgents(activeId);
		wsHandler.sendTo(clientId, {
			type: "agent_list",
			agents: [...result.agents],
			...(result.activeAgentId ? { activeAgentId: result.activeAgentId } : {}),
		});
	} catch (err) {
		sendInitError(err, "Failed to list agents");
	}

	// ── Provider/model list + auto-select default ────────────────────────
	try {
		let providerResult: OpenCodeProviderList | undefined;
		const providers: ProviderInfo[] = [];
		let openCodeError: unknown;
		try {
			providerResult = await deps.modelService.listProviders();
			providers.push(...toConfiguredOpenCodeProviders(providerResult));
			wsHandler.sendTo(clientId, { type: "model_list", providers });
		} catch (err) {
			openCodeError = err;
			deps.log.warn(
				`OpenCode provider discovery failed during client init: ${formatErrorDetail(err)}`,
			);
		}

		// Merge Claude in-process models when the orchestration engine is available.
		// Mirrors model discovery so the initial client_connected payload doesn't
		// overwrite the merged list the client later receives from RPC.
		//   "Anthropic - opencode" → routes via OpenCode REST API
		//   "Anthropic - claude"  → routes via in-process Claude Agent SDK
		let claudeAdded = false;
		if (deps.discoverClaudeCapabilities) {
			try {
				const claudeCaps = await deps.discoverClaudeCapabilities();
				claudeAdded = addClaudeProvider(providers, claudeCaps);
				if (claudeAdded) {
					wsHandler.sendTo(clientId, { type: "model_list", providers });
				}
			} catch {
				// Claude provider instance may not be available — skip silently
			}
		}
		if (openCodeError && !claudeAdded && providers.length === 0) {
			throw openCodeError;
		}

		// Send variant info — current thinking level and available variants
		// for the active model (per-session when available, global fallback)
		const currentVariant = activeId
			? await overrideState.getVariant(activeId)
			: await overrideState.getDefaultVariant();
		const activeModelOverride = activeId
			? await overrideState.getModel(activeId)
			: await overrideState.getDefaultModel();
		const activeModel = activeId
			? (activeModelOverride ?? activeSessionModel)
			: activeModelOverride;
		const activeModelId = activeModel?.modelID;
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
		wsHandler.sendTo(clientId, {
			type: "context_window_info",
			contextWindow: activeId
				? await overrideState.getContextWindow(activeId)
				: await overrideState.getDefaultContextWindow(),
			options: findContextWindowOptions(providers, activeModelId),
		});

		// Send default model info to new client
		const defaultModel = await overrideState.getDefaultModel();
		if (defaultModel) {
			wsHandler.sendTo(clientId, {
				type: "default_model_info",
				model: defaultModel.modelID,
				provider: defaultModel.providerID,
			});
		}

		// Auto-select default model if none set.
		// Priority: defaultModel (seeded from config or user-set) > provider-level default.
		if (!defaultModel && providerResult) {
			// Fallback: first connected provider's default model
			for (const providerId of providerResult.connected) {
				const defaultModelId = providerResult.defaults[providerId];
				if (defaultModelId) {
					await overrideState.setDefaultModel({
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
		} else if (!defaultModel && claudeAdded) {
			const defaultClaudeModel = providers
				.find((provider) => provider.id === "claude")
				?.models.at(0);
			if (defaultClaudeModel) {
				await overrideState.setDefaultModel({
					providerID: "claude",
					modelID: defaultClaudeModel.id,
				});
				wsHandler.broadcast({
					type: "model_info",
					model: defaultClaudeModel.id,
					provider: "claude",
				});
				deps.log.info(
					`Auto-selected default: ${defaultClaudeModel.id} (claude)`,
				);
			}
		} else if (
			defaultModel &&
			providers.some((provider) => provider.id === defaultModel.providerID)
		) {
			// Broadcast existing default to new client
			wsHandler.sendTo(clientId, {
				type: "model_info",
				model: defaultModel.modelID,
				provider: defaultModel.providerID,
			});
			deps.log.info(
				`Default: ${defaultModel.modelID} (${defaultModel.providerID})`,
			);
		}
	} catch (err) {
		sendInitError(err, "Failed to list providers");
	}

	// ── PTY list + scrollback replay ─────────────────────────────────────
	await deps.terminal.replay(clientId);

	// ── Instance list ─────────────────────────────────────────────────────
	if (deps.getInstances) {
		try {
			const instances = await deps.getInstances();
			wsHandler.sendTo(clientId, { type: "instance_list", instances });
		} catch (err) {
			sendInitError(err, "Failed to list instances");
		}
	}

	// ── Cached update notification ───────────────────────────────────────
	if (deps.getCachedUpdate) {
		try {
			const version = await deps.getCachedUpdate();
			if (version) {
				wsHandler.sendTo(clientId, { type: "update_available", version });
			}
		} catch (err) {
			sendInitError(err, "Failed to replay update");
		}
	}
}
