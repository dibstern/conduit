import { Effect } from "effect";
import { RateLimiterTag } from "../domain/relay/Layers/rate-limiter-layer.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { DirectoryListingServiceTag } from "../domain/relay/Services/directory-listing-service.js";
import { InstanceManagementServiceTag } from "../domain/relay/Services/instance-management-service.js";
import { ProjectManagementServiceTag } from "../domain/relay/Services/project-management-service.js";
import { ScanServiceTag } from "../domain/relay/Services/scan-service.js";
import { WebSocketHandlerTag } from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import { switchContextWindowForSession } from "../handlers/context-window.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../handlers/model.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "../handlers/permissions.js";
import {
	cancelSessionById,
	rewindSessionToMessage,
	sendMessageToSession,
	syncInputDraftForSession,
} from "../handlers/prompt.js";
import { reloadProviderSessionForClient } from "../handlers/reload.js";
import {
	createSessionForClient,
	deleteSessionForClient,
	forkSessionForClient,
	loadMoreHistoryForSession,
	renameSessionForClient,
	viewSessionForClient,
} from "../handlers/session.js";
import {
	getCommandsForSession,
	getTodoState,
	normalizeProjectTitle,
} from "../handlers/settings.js";
import type { OpenCodeInstance, PermissionId } from "../shared-types.js";

export {
	AddProject,
	AnswerQuestion,
	CancelSession,
	ClosePty,
	CreatePty,
	CreateSession,
	type CreateSessionResponse,
	DeleteSession,
	DetectProxy,
	type DetectProxyResponse,
	ForkSession,
	type ForkSessionResponse,
	GetAgents,
	type GetAgentsResponse,
	GetCommands,
	type GetCommandsResponse,
	GetFileContent,
	type GetFileContentResponse,
	GetFileList,
	type GetFileListResponse,
	GetFileTree,
	type GetFileTreeResponse,
	GetModels,
	type GetModelsResponse,
	GetProjects,
	type GetProjectsResponse,
	GetTodo,
	type GetTodoResponse,
	GetToolContent,
	type GetToolContentResponse,
	type InstanceListResponse,
	ListDirectories,
	type ListDirectoriesResponse,
	ListPtys,
	ListSessions,
	type ListSessionsResponse,
	LoadMoreHistory,
	type LoadMoreHistoryResponse,
	type ModelInfo,
	type ProjectMutationResponse,
	type ProviderInfo,
	type PtyInfo,
	type PtyListResponse,
	RejectQuestion,
	ReloadProviderSession,
	type ReloadProviderSessionResponse,
	RemoveInstance,
	RemoveProject,
	RenameInstance,
	RenameProject,
	RenameSession,
	ResizePty,
	RespondPermission,
	RewindSession,
	ScanNow,
	type ScanNowResponse,
	SendMessage,
	type SessionInfo,
	SetDefaultModel,
	type SetDefaultModelResponse,
	SetLogLevel,
	SetProjectInstance,
	StartInstance,
	StopInstance,
	SwitchAgent,
	SwitchContextWindow,
	type SwitchContextWindowResponse,
	SwitchModel,
	type SwitchModelResponse,
	SwitchVariant,
	type SwitchVariantResponse,
	SyncInputDraft,
	ViewSession,
	WsRpcError,
	WsRpcGroup,
	WsRpcRequest,
} from "../contracts/ws-rpc.js";

import { WsRpcError, WsRpcGroup } from "../contracts/ws-rpc.js";
import {
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../handlers/files.js";
import { getToolContentValue } from "../handlers/tool-content.js";
import { setLogLevel } from "../logger.js";

const CCS_DEFAULT_PORT = 8317;

const instanceServiceOrFail = (operation: string) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			return yield* Effect.fail(
				new WsRpcError({
					message: `${operation} failed: Instance management not available`,
				}),
			);
		}
		return serviceOption.value;
	});

const mapRpcFailure =
	(operation: string) =>
	(error: unknown): Effect.Effect<never, WsRpcError> =>
		error instanceof WsRpcError
			? Effect.fail(error)
			: Effect.fail(
					new WsRpcError({
						message: `${operation} failed: ${String(error)}`,
					}),
				);

const broadcastInstanceList = (instances: ReadonlyArray<OpenCodeInstance>) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.broadcast({ type: "instance_list", instances });
	});

export const WsRpcServerLayer = WsRpcGroup.toLayer({
	GetAgents: (request) =>
		Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			const result = yield* agentService.listAgents(request.sessionId);
			return {
				projectSlug: request.projectSlug,
				providerScope: result.providerScope,
				agents: result.agents,
				...(result.activeAgentId != null
					? { activeAgentId: result.activeAgentId }
					: {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetAgents failed: ${String(error)}`,
					}),
				),
			),
		),
	GetCommands: (request) =>
		getCommandsForSession(request.sessionId).pipe(
			Effect.map((commands) => ({
				projectSlug: request.projectSlug,
				commands,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetCommands failed: ${String(error)}`,
					}),
				),
			),
		),
	GetProjects: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.list();
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetProjects failed: ${String(error)}`,
					}),
				),
			),
		),
	AddProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const result = yield* projectService.add(
				request.directory,
				request.instanceId,
			);
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects: result.projects,
				...(current ? { current } : {}),
				addedSlug: result.project.slug,
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `AddProject failed: ${String(error)}`,
					}),
				),
			),
		),
	RemoveProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const projects = yield* projectService.remove(request.slug);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RemoveProject failed: ${String(error)}`,
					}),
				),
			),
		),
	RenameProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const title = normalizeProjectTitle(request.title);
			if (!title) {
				return yield* Effect.fail(
					new WsRpcError({
						message: "RenameProject failed: title is required",
					}),
				);
			}
			const projects = yield* projectService.rename(request.slug, title);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `RenameProject failed: ${String(error)}`,
							}),
						),
			),
		),
	SetProjectInstance: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const projects = yield* projectService.setProjectInstance(
				request.slug,
				request.instanceId,
			);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetProjectInstance failed: ${String(error)}`,
					}),
				),
			),
		),
	StartInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StartInstance");
			const instances = yield* instanceService.start(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("StartInstance"))),
	StopInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("StopInstance");
			const instances = yield* instanceService.stop(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("StopInstance"))),
	RemoveInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RemoveInstance");
			const instances = yield* instanceService.remove(request.instanceId);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("RemoveInstance"))),
	RenameInstance: (request) =>
		Effect.gen(function* () {
			const instanceService = yield* instanceServiceOrFail("RenameInstance");
			const name = request.name.trim();
			if (!name) {
				return yield* Effect.fail(
					new WsRpcError({
						message: "RenameInstance failed: name is required",
					}),
				);
			}
			const instances = yield* instanceService.rename(request.instanceId, name);
			yield* broadcastInstanceList(instances);
			return {
				projectSlug: request.projectSlug,
				instances,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("RenameInstance"))),
	ScanNow: (request) =>
		Effect.gen(function* () {
			const scanService = yield* ScanServiceTag;
			const result = yield* scanService.scanNow();
			return {
				projectSlug: request.projectSlug,
				discovered: result.discovered,
				lost: result.lost,
				active: result.active,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ScanNow"))),
	DetectProxy: (request) =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${CCS_DEFAULT_PORT}/health`, {
						signal: AbortSignal.timeout(3_000),
					}),
				),
			);
			return {
				projectSlug: request.projectSlug,
				found: result._tag === "Right" && result.right.ok,
				port: CCS_DEFAULT_PORT,
			};
		}),
	ListPtys: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			const ptys = yield* terminal.list(request.originId);
			return {
				projectSlug: request.projectSlug,
				ptys,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ListPtys"))),
	CreatePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.create(request.originId);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("CreatePty"))),
	ResizePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.resize(
				request.originId ?? "rpc",
				request.ptyId,
				request.rows ?? 24,
				request.cols ?? 80,
			);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("ResizePty"))),
	ClosePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.close(request.ptyId);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("ClosePty"))),
	ListDirectories: (request) =>
		Effect.gen(function* () {
			const directoryListing = yield* DirectoryListingServiceTag;
			const result = yield* directoryListing.list(request.path);
			return {
				projectSlug: request.projectSlug,
				path: result.path,
				entries: [...result.entries],
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ListDirectories failed: ${String(error)}`,
					}),
				),
			),
		),
	GetTodo: (request) =>
		getTodoState().pipe(
			Effect.map((items) => ({
				projectSlug: request.projectSlug,
				items: [...items],
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetTodo failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchAgent: (request) =>
		Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			yield* agentService.switchAgent({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				agentId: request.agentId,
			});
			return { ok: true as const };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchAgent failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchContextWindow: (request) =>
		switchContextWindowForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			contextWindow: request.contextWindow,
		}).pipe(
			Effect.map((message) => ({
				projectSlug: request.projectSlug,
				contextWindow: message.contextWindow,
				options: message.options,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchContextWindow failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchModel: (request) =>
		switchModelForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			modelId: request.modelId,
			providerId: request.providerId,
		}).pipe(
			Effect.map((messages) => ({
				projectSlug: request.projectSlug,
				model: messages.model.model,
				provider: messages.model.provider,
				variant: messages.variant.variant,
				variants: messages.variant.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchModel failed: ${String(error)}`,
					}),
				),
			),
		),
	SetDefaultModel: (request) =>
		setDefaultModelForRelay({
			clientId: request.originId ?? "rpc",
			model: request.model,
			provider: request.provider,
		}).pipe(
			Effect.map((messages) => ({
				projectSlug: request.projectSlug,
				model: messages.model.model,
				provider: messages.model.provider,
				variant: messages.variant.variant,
				variants: messages.variant.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetDefaultModel failed: ${String(error)}`,
					}),
				),
			),
		),
	ReloadProviderSession: (request) =>
		reloadProviderSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			commandId: request.commandId,
		}).pipe(
			Effect.as({
				projectSlug: request.projectSlug,
				sessionId: request.sessionId,
			}),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ReloadProviderSession failed: ${String(error)}`,
					}),
				),
			),
		),
	RenameSession: (request) =>
		renameSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			title: request.title,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RenameSession failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchVariant: (request) =>
		switchVariantForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			variant: request.variant,
		}).pipe(
			Effect.map((message) => ({
				projectSlug: request.projectSlug,
				variant: message.variant,
				variants: message.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchVariant failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileTree: (request) =>
		getFileTreeEntries().pipe(
			Effect.map((entries) => ({
				projectSlug: request.projectSlug,
				entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileTree failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileList: (request) =>
		getFileListResponse(request.path ?? ".").pipe(
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				path: result.path,
				entries: result.entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileList failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileContent: (request) =>
		getFileContentResponse(request.path).pipe(
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				path: result.path,
				content: result.content,
				...(result.binary != null ? { binary: result.binary } : {}),
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileContent failed: ${String(error)}`,
					}),
				),
			),
		),
	GetToolContent: (request) =>
		getToolContentValue(request.toolId).pipe(
			Effect.flatMap((content) =>
				content == null
					? Effect.fail(
							new WsRpcError({
								message: "Full tool content not available",
							}),
						)
					: Effect.succeed({
							projectSlug: request.projectSlug,
							toolId: request.toolId,
							content,
						}),
			),
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `GetToolContent failed: ${String(error)}`,
							}),
						),
			),
		),
	GetModels: (request) =>
		getModelsResponse({
			projectSlug: request.projectSlug,
			...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetModels failed: ${String(error)}`,
					}),
				),
			),
		),
	ListSessions: (request) =>
		Effect.gen(function* () {
			const sessionManager = yield* SessionManagerServiceTag;
			const roots = request.roots ?? false;
			const query = request.query?.trim() ?? "";
			const normalizedQuery = query.toLowerCase();
			const sessions = yield* sessionManager.listSessions({ roots });
			const filtered =
				normalizedQuery.length === 0
					? sessions
					: sessions.filter(
							(session) =>
								(session.title ?? "").toLowerCase().includes(normalizedQuery) ||
								session.id.toLowerCase().includes(normalizedQuery),
						);
			return {
				projectSlug: request.projectSlug,
				sessions: filtered,
				roots,
				...(query.length > 0 ? { search: true } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ListSessions failed: ${String(error)}`,
					}),
				),
			),
		),
	CreateSession: (request) =>
		createSessionForClient({
			clientId: request.originId,
			...(request.title != null ? { title: request.title } : {}),
			...(request.requestId != null ? { requestId: request.requestId } : {}),
			...(request.providerId != null ? { providerId: request.providerId } : {}),
		}).pipe(
			Effect.map((session) => ({
				projectSlug: request.projectSlug,
				sessionId: session.id,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `CreateSession failed: ${String(error)}`,
					}),
				),
			),
		),
	ViewSession: (request) =>
		viewSessionForClient({
			clientId: request.originId,
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ViewSession failed: ${String(error)}`,
					}),
				),
			),
		),
	DeleteSession: (request) =>
		deleteSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `DeleteSession failed: ${String(error)}`,
					}),
				),
			),
		),
	ForkSession: (request) =>
		forkSessionForClient({
			clientId: request.originId,
			...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
			...(request.messageId != null ? { messageId: request.messageId } : {}),
		}).pipe(
			Effect.flatMap((session) =>
				session == null
					? Effect.fail(
							new WsRpcError({
								message: "ForkSession failed: no active session",
							}),
						)
					: Effect.succeed({
							projectSlug: request.projectSlug,
							sessionId: session.id,
						}),
			),
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `ForkSession failed: ${String(error)}`,
							}),
						),
			),
		),
	RespondPermission: (request) =>
		handlePermissionResponse(request.originId, {
			requestId: request.requestId as PermissionId,
			commandId: request.commandId,
			decision: request.decision,
			...(request.persistScope != null
				? { persistScope: request.persistScope }
				: {}),
			...(request.persistPattern != null
				? { persistPattern: request.persistPattern }
				: {}),
			...(request.permissionDestination != null
				? { permissionDestination: request.permissionDestination }
				: {}),
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RespondPermission failed: ${String(error)}`,
					}),
				),
			),
		),
	AnswerQuestion: (request) =>
		handleAskUserResponse(request.originId, {
			toolId: request.toolId,
			commandId: request.commandId,
			answers: request.answers,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `AnswerQuestion failed: ${String(error)}`,
					}),
				),
			),
		),
	RejectQuestion: (request) =>
		handleQuestionReject(request.originId, {
			toolId: request.toolId,
			commandId: request.commandId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RejectQuestion failed: ${String(error)}`,
					}),
				),
			),
		),
	LoadMoreHistory: (request) =>
		loadMoreHistoryForSession({
			sessionId: request.sessionId,
			offset: request.offset,
		}).pipe(
			Effect.map((page) => ({
				projectSlug: request.projectSlug,
				sessionId: page.sessionId,
				messages: page.messages,
				hasMore: page.hasMore,
				...(page.total != null ? { total: page.total } : {}),
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `LoadMoreHistory failed: ${String(error)}`,
					}),
				),
			),
		),
	RewindSession: (request) =>
		rewindSessionToMessage({
			clientId: "rpc",
			sessionId: request.sessionId,
			messageId: request.messageId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RewindSession failed: ${String(error)}`,
					}),
				),
			),
		),
	SendMessage: (request) =>
		Effect.gen(function* () {
			const limiterOption = yield* Effect.serviceOption(RateLimiterTag);
			if (limiterOption._tag === "Some") {
				const result = yield* limiterOption.value.checkLimit(
					request.originId ?? request.sessionId,
				);
				if (!result.allowed) {
					return yield* Effect.fail(
						new WsRpcError({
							message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
						}),
					);
				}
			}
			yield* sendMessageToSession({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				text: request.text,
				commandId: request.commandId,
				...(request.images ? { images: request.images } : {}),
				...(request.originId ? { originId: request.originId } : {}),
				errorDelivery: "session",
			});
			return { ok: true as const };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SendMessage failed: ${String(error)}`,
					}),
				),
			),
		),
	SyncInputDraft: (request) =>
		syncInputDraftForSession({
			sessionId: request.sessionId,
			text: request.text,
			...(request.originId ? { from: request.originId } : {}),
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SyncInputDraft failed: ${String(error)}`,
					}),
				),
			),
		),
	CancelSession: (request) =>
		cancelSessionById("rpc", request.sessionId, request.commandId).pipe(
			Effect.as({ ok: true as const }),
		),
	SetLogLevel: (request) =>
		Effect.sync(() => {
			setLogLevel(request.level);
			return { ok: true as const };
		}),
});
