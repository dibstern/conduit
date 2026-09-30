import { type Context, Effect } from "effect";
import { WsRpcError, WsRpcGroup } from "../contracts/ws-rpc.js";
import { conversationHandlers } from "./ws-rpc/conversation.js";
import { filesHandlers } from "./ws-rpc/files.js";
import { instancesHandlers } from "./ws-rpc/instances.js";
import { modelsHandlers } from "./ws-rpc/models.js";
import { projectsHandlers } from "./ws-rpc/projects.js";
import { sessionsHandlers } from "./ws-rpc/sessions.js";
import { settingsHandlers } from "./ws-rpc/settings.js";
import { terminalsHandlers } from "./ws-rpc/terminals.js";

export {
	AddProject,
	AnswerQuestion,
	AttachProject,
	CancelSession,
	type ClaudeSettingsResponse,
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
	GetClaudeSettings,
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
	GetSkillContent,
	type GetSkillContentResponse,
	GetTodo,
	type GetTodoResponse,
	GetToolContent,
	type GetToolContentResponse,
	type InstanceListResponse,
	ListDaemonSessions,
	type ListDaemonSessionsResponse,
	ListDirectories,
	type ListDirectoriesResponse,
	ListPtys,
	ListSessions,
	type ListSessionsResponse,
	LoadMoreHistory,
	type LoadMoreHistoryResponse,
	MarkSessionRead,
	MarkSessionUnread,
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
	ResolveClaudeSettings,
	type ResolveClaudeSettingsResponse,
	ResolveSession,
	RespondPermission,
	RewindSession,
	ScanNow,
	type ScanNowResponse,
	SendMessage,
	type SessionInfo,
	SetClaudeSettings,
	SetDefaultModel,
	type SetDefaultModelResponse,
	SetDefaultPermissionMode,
	type SetDefaultPermissionModeResponse,
	SetLogLevel,
	SetProjectInstance,
	SetSessionAutoSettle,
	SetSessionPinned,
	SetSessionSettled,
	SnoozeSession,
	StartInstance,
	StopInstance,
	SwitchAgent,
	SwitchContextWindow,
	type SwitchContextWindowResponse,
	SwitchModel,
	type SwitchModelResponse,
	SwitchPermissionMode,
	type SwitchPermissionModeResponse,
	SwitchVariant,
	type SwitchVariantResponse,
	SyncInputDraft,
	UnsnoozeSession,
	ViewSession,
	WsRpcError,
	WsRpcGroup,
	WsRpcRequest,
} from "../contracts/ws-rpc.js";

export const wsRpcHandlers = WsRpcGroup.of({
	...projectsHandlers,
	...instancesHandlers,
	...settingsHandlers,
	...terminalsHandlers,
	...filesHandlers,
	...modelsHandlers,
	...sessionsHandlers,
	...conversationHandlers,
});

export const WsRpcServerLayer = WsRpcGroup.toLayer(wsRpcHandlers);

export type ResolveRpcContext = (
	projectSlug: string,
) => Effect.Effect<Context.Context<unknown>, WsRpcError>;

export type ReattachDaemonViewSession = (payload: {
	readonly projectSlug: string;
	readonly originId: string;
	readonly sessionId?: string;
}) => Effect.Effect<boolean, WsRpcError>;

export type DaemonRpcName =
	| "GetProjects"
	| "AddProject"
	| "RemoveProject"
	| "RenameProject"
	| "SetProjectInstance"
	| "StartInstance"
	| "StopInstance"
	| "RemoveInstance"
	| "RenameInstance"
	| "AddInstance"
	| "UpdateInstance"
	| "GetAutoSettleSetting"
	| "SetAutoSettleSetting"
	| "ScanNow"
	| "DetectProxy"
	| "ListDirectories"
	| "ListDaemonSessions"
	| "SetLogLevel"
	| "ResolveSession";

export type DaemonRpcHandlers = {
	[K in DaemonRpcName]: (
		payload: Parameters<(typeof wsRpcHandlers)[K]>[0],
	) => Effect.Effect<
		Effect.Effect.Success<ReturnType<(typeof wsRpcHandlers)[K]>>,
		WsRpcError
	>;
};

export const makeRoutedWsRpcServerLayer = (
	resolveContext: ResolveRpcContext,
	daemonHandlers?: DaemonRpcHandlers,
	defaultProjectSlug?: string,
	reattachViewSession?: ReattachDaemonViewSession,
) => {
	const routeHandler =
		<P extends { readonly projectSlug?: string }, A, E, R>(
			handler: (payload: P) => Effect.Effect<A, E, R>,
		) =>
		(payload: P) =>
			Effect.gen(function* () {
				const slug = payload.projectSlug ?? defaultProjectSlug;
				if (slug === undefined)
					return yield* Effect.fail(
						new WsRpcError({ message: "projectSlug is required" }),
					);
				const context = yield* resolveContext(slug);
				return yield* Effect.provide(handler(payload), context);
			});

	// Object.entries/fromEntries loses the key-to-payload/result correlation.
	// Each wrapper preserves its original handler's payload and success type.
	const handlers = Object.fromEntries(
		Object.entries({ ...wsRpcHandlers, ...daemonHandlers }).map(
			([name, handler]) => [
				name,
				daemonHandlers && Object.hasOwn(daemonHandlers, name)
					? handler
					: routeHandler<never, unknown, unknown, unknown>(handler),
			],
		),
	) as {
		-readonly [K in keyof typeof wsRpcHandlers]: (
			payload: Parameters<(typeof wsRpcHandlers)[K]>[0],
		) => Effect.Effect<
			Effect.Effect.Success<ReturnType<(typeof wsRpcHandlers)[K]>>,
			Effect.Effect.Error<ReturnType<(typeof wsRpcHandlers)[K]>> | WsRpcError
		>;
	};
	handlers.AttachProject = (payload) =>
		reattachViewSession
			? reattachViewSession(payload).pipe(Effect.as({ ok: true as const }))
			: wsRpcHandlers.AttachProject(payload);
	if (reattachViewSession) {
		const routeViewSession = routeHandler(wsRpcHandlers.ViewSession);
		handlers.ViewSession = (
			payload: Parameters<(typeof wsRpcHandlers)["ViewSession"]>[0],
		) =>
			reattachViewSession(payload).pipe(
				Effect.flatMap((reattached) =>
					reattached
						? Effect.succeed({ ok: true as const })
						: routeViewSession(payload),
				),
			);
	}
	return WsRpcGroup.toLayer(handlers);
};
