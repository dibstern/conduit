import { Rpc, type RpcGroup } from "@effect/rpc";
import { type Context, Effect, type Layer, Stream, Struct } from "effect";
import {
	type OpenCodeInstance,
	type ProjectInfo,
	WsRpcError,
	WsRpcGroup,
} from "../contracts/ws-rpc.js";
import { subscribeApprovals } from "../domain/relay/Services/approvals-subscription.js";
import { subscribeProjectSettings } from "../domain/relay/Services/project-settings.js";
import { subscribePtys } from "../domain/relay/Services/pty-subscription.js";
import { subscribeSessionDetail } from "../domain/relay/Services/session-detail-subscription.js";
import { encodeSessionDetail } from "../domain/relay/Services/session-detail-wire.js";
import { subscribeShell } from "../domain/relay/Services/shell-subscription.js";
import { subscribeSessionTodos } from "../domain/relay/Services/todo-subscription.js";
import { getSessionInputDraft } from "../handlers/prompt.js";
import { conversationHandlers } from "./ws-rpc/conversation.js";
import { daemonOnlyHandlers } from "./ws-rpc/daemon.js";
import { filesHandlers } from "./ws-rpc/files.js";
import { instancesHandlers } from "./ws-rpc/instances.js";
import { modelsHandlers } from "./ws-rpc/models.js";
import { projectsHandlers } from "./ws-rpc/projects.js";
import { sessionSkillsHandlers } from "./ws-rpc/session-skills.js";
import { sessionsHandlers } from "./ws-rpc/sessions.js";
import { settingsHandlers } from "./ws-rpc/settings.js";
import { terminalsHandlers } from "./ws-rpc/terminals.js";

export {
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
	FindFolders,
	type FindFoldersResponse,
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
	GetGoalDetails,
	GetInstanceStatus,
	type GetInstanceStatusResponse,
	GetInstances,
	GetModels,
	type GetModelsResponse,
	GetProjects,
	type GetProjectsResponse,
	GetSessionSkills,
	type GetSessionSkillsResponse,
	GetSkillContent,
	type GetSkillContentResponse,
	GetStatus,
	type GetStatusResponse,
	GetToolContent,
	type GetToolContentResponse,
	type GoalDetails,
	type InstanceListResponse,
	ListDaemonSessions,
	type ListDaemonSessionsResponse,
	ListPtys,
	LoadMoreHistory,
	type LoadMoreHistoryResponse,
	MarkSessionRead,
	MarkSessionSeen,
	MarkSessionUnread,
	type ModelInfo,
	type ProjectMutationResponse,
	type ProviderInfo,
	type PtyEnvelope,
	type PtyInfo,
	PtyInput,
	type PtyListResponse,
	RejectQuestion,
	ReloadProviderSession,
	type ReloadProviderSessionResponse,
	RemoveInstance,
	RemoveProject,
	RenameInstance,
	RenameSession,
	ResizePty,
	ResolveClaudeSettings,
	type ResolveClaudeSettingsResponse,
	ResolveSession,
	RespondPermission,
	RestartWithConfig,
	RewindSession,
	SaveProject,
	type SaveProjectResponse,
	ScanNow,
	type ScanNowResponse,
	SendMessage,
	type SessionInfo,
	SetAgent,
	SetClaudeSettings,
	SetDefaultModel,
	type SetDefaultModelResponse,
	SetDefaultPermissionMode,
	type SetDefaultPermissionModeResponse,
	SetKeepAwake,
	SetKeepAwakeCommand,
	type SetKeepAwakeResponse,
	SetLogLevel,
	SetPin,
	SetProjectInstance,
	SetSessionAutoSettle,
	SetSessionPinned,
	SetSessionSettled,
	Shutdown,
	SnoozeSession,
	StartInstance,
	StopInstance,
	SubscribePtys,
	SubscribeSessionDetail,
	SubscribeSessionTodos,
	SubscribeShell,
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

const unaryHandlers = {
	...daemonOnlyHandlers,
	...projectsHandlers,
	...instancesHandlers,
	...settingsHandlers,
	...terminalsHandlers,
	...filesHandlers,
	...sessionSkillsHandlers,
	...modelsHandlers,
	...sessionsHandlers,
	...conversationHandlers,
};

export const wsRpcHandlers = WsRpcGroup.of({
	SubscribeShell: (request) =>
		Rpc.fork(
			subscribeShell(
				request.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: request.resumeFromSequence },
			).pipe(
				Stream.mapError(
					(error) =>
						new WsRpcError({
							message: `SubscribeShell failed: ${String(error)}`,
						}),
				),
			),
		),
	SubscribeApprovals: (request) =>
		Rpc.fork(
			subscribeApprovals(
				request.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: request.resumeFromSequence },
			).pipe(
				Stream.mapError(
					(error) =>
						new WsRpcError({
							message: `SubscribeApprovals failed: ${String(error)}`,
						}),
				),
			),
		),
	SubscribeSessionDetail: (request) =>
		Rpc.fork(
			subscribeSessionDetail({
				sessionId: request.sessionId,
				...(request.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: request.resumeFromSequence }),
			}).pipe(
				(stream) =>
					request.textSuffixes === true ? encodeSessionDetail(stream) : stream,
				Stream.mapError(
					(error) =>
						new WsRpcError({
							message: `SubscribeSessionDetail failed: ${String(error)}`,
						}),
				),
			),
		),
	SubscribeSessionTodos: (request) =>
		Rpc.fork(
			subscribeSessionTodos({
				sessionId: request.sessionId,
				...(request.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: request.resumeFromSequence }),
			}).pipe(
				Stream.mapError(
					(error) =>
						new WsRpcError({
							message: `SubscribeSessionTodos failed: ${String(error)}`,
						}),
				),
			),
		),
	SubscribePtys: () =>
		Rpc.fork(
			subscribePtys().pipe(
				Stream.mapError(
					(error) =>
						new WsRpcError({
							message: `SubscribePtys failed: ${String(error)}`,
						}),
				),
			),
		),
	SubscribeProjectSettings: () => Rpc.fork(subscribeProjectSettings()),
	SubscribeInstances: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeInstances requires daemon mode" }),
		),
	SubscribeProjects: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeProjects requires daemon mode" }),
		),
	...unaryHandlers,
});

export const WsRpcServerLayer = WsRpcGroup.toLayer(wsRpcHandlers);

export type ResolveRpcContext = (
	projectSlug: string,
) => Effect.Effect<
	Context.Context<Layer.Layer.Context<typeof WsRpcServerLayer>>,
	WsRpcError
>;

export type ReattachDaemonViewSession = (payload: {
	readonly projectSlug: string;
	readonly originId: string;
	readonly sessionId?: string;
}) => Effect.Effect<boolean, WsRpcError>;

export type DaemonRpcName =
	| keyof typeof daemonOnlyHandlers
	| "GetProjects"
	| "SaveProject"
	| "RemoveProject"
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
	| "FindFolders"
	| "ListDaemonSessions"
	| "SetLogLevel"
	| "ResolveSession";

export type DaemonRpcHandlers = {
	[K in DaemonRpcName]: (
		payload: Parameters<(typeof unaryHandlers)[K]>[0],
	) => Effect.Effect<
		Rpc.Success<
			Extract<RpcGroup.Rpcs<typeof WsRpcGroup>, { readonly _tag: K }>
		>,
		Rpc.Error<Extract<RpcGroup.Rpcs<typeof WsRpcGroup>, { readonly _tag: K }>>
	>;
} & {
	readonly SubscribeInstances: () => Stream.Stream<
		{ readonly instances: readonly OpenCodeInstance[] },
		WsRpcError
	>;
	readonly SubscribeProjects: () => Stream.Stream<
		{ readonly projects: readonly ProjectInfo[] },
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

	const daemonUnaryHandlers =
		daemonHandlers &&
		Struct.omit(daemonHandlers, "SubscribeInstances", "SubscribeProjects");
	// Object.entries/fromEntries loses the key-to-payload/result correlation.
	// Each wrapper preserves its original handler's payload and success type.
	const handlers = Object.fromEntries(
		Object.entries({ ...unaryHandlers, ...daemonUnaryHandlers }).map(
			([name, handler]) => [
				name,
				(daemonUnaryHandlers && Object.hasOwn(daemonUnaryHandlers, name)) ||
				Object.hasOwn(daemonOnlyHandlers, name)
					? handler
					: routeHandler<never, unknown, unknown, unknown>(handler),
			],
		),
	) as {
		-readonly [K in keyof typeof unaryHandlers]: (
			payload: Parameters<(typeof unaryHandlers)[K]>[0],
		) => Effect.Effect<
			Effect.Effect.Success<ReturnType<(typeof unaryHandlers)[K]>>,
			Effect.Effect.Error<ReturnType<(typeof unaryHandlers)[K]>> | WsRpcError
		>;
	};
	handlers.AttachProject = (payload) =>
		reattachViewSession
			? reattachViewSession(payload).pipe(Effect.as({ ok: true as const }))
			: unaryHandlers.AttachProject(payload);
	if (reattachViewSession) {
		const routeViewSession = routeHandler(unaryHandlers.ViewSession);
		handlers.ViewSession = (
			payload: Parameters<(typeof unaryHandlers)["ViewSession"]>[0],
		) =>
			reattachViewSession(payload).pipe(
				Effect.flatMap((reattached) =>
					reattached
						? Effect.succeed({
								ok: true as const,
								draft: getSessionInputDraft(payload.sessionId),
							})
						: routeViewSession(payload),
				),
			);
	}
	const routeStream = <
		A,
		E,
		R extends Layer.Layer.Context<typeof WsRpcServerLayer>,
	>(
		projectSlug: string,
		make: () => Stream.Stream<A, E, R>,
	) =>
		Rpc.fork(
			Stream.unwrap(
				Effect.map(resolveContext(projectSlug), (context) =>
					Stream.provideContext(make(), context).pipe(
						Stream.mapError(
							(error) =>
								new WsRpcError({
									message: `Subscription failed: ${String(error)}`,
								}),
						),
					),
				),
			),
		);
	return WsRpcGroup.toLayer({
		...handlers,
		SubscribeShell: (request) =>
			routeStream(request.projectSlug, () =>
				subscribeShell(
					request.resumeFromSequence === undefined
						? {}
						: { resumeFromSequence: request.resumeFromSequence },
				),
			),
		SubscribeApprovals: (request) =>
			routeStream(request.projectSlug, () =>
				subscribeApprovals(
					request.resumeFromSequence === undefined
						? {}
						: { resumeFromSequence: request.resumeFromSequence },
				),
			),
		SubscribeSessionDetail: (request) =>
			routeStream(request.projectSlug, () => {
				const source = subscribeSessionDetail({
					sessionId: request.sessionId,
					...(request.resumeFromSequence === undefined
						? {}
						: { resumeFromSequence: request.resumeFromSequence }),
				});
				return request.textSuffixes === true
					? encodeSessionDetail(source)
					: source;
			}),
		SubscribeSessionTodos: (request) =>
			routeStream(request.projectSlug, () =>
				subscribeSessionTodos({
					sessionId: request.sessionId,
					...(request.resumeFromSequence === undefined
						? {}
						: { resumeFromSequence: request.resumeFromSequence }),
				}),
			),
		SubscribePtys: (request) => routeStream(request.projectSlug, subscribePtys),
		SubscribeProjectSettings: (request) =>
			routeStream(request.projectSlug, () => subscribeProjectSettings()),
		SubscribeInstances: () =>
			daemonHandlers
				? Rpc.fork(daemonHandlers.SubscribeInstances())
				: wsRpcHandlers.SubscribeInstances(),
		SubscribeProjects: () =>
			daemonHandlers
				? Rpc.fork(daemonHandlers.SubscribeProjects())
				: wsRpcHandlers.SubscribeProjects(),
	});
};
