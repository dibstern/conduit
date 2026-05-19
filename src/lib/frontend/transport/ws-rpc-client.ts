import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import { runTransportEffect } from "./runtime.js";
import {
	type CreateSessionResponse,
	type DetectProxyResponse,
	type ForkSessionResponse,
	type GetAgentsResponse,
	type GetCommandsResponse,
	type GetFileContentResponse,
	type GetFileListResponse,
	type GetFileTreeResponse,
	type GetModelsResponse,
	type GetProjectsResponse,
	type GetTodoResponse,
	type GetToolContentResponse,
	type InstanceListResponse,
	type ListDirectoriesResponse,
	type ListSessionsResponse,
	type LoadMoreHistoryResponse,
	type PermissionDecision,
	type PermissionPersistScope,
	type PermissionUpdateDestination,
	type ProjectMutationResponse,
	type PtyListResponse,
	type ReloadProviderSessionResponse,
	type RpcLogLevel,
	type ScanNowResponse,
	type SetDefaultModelResponse,
	type SwitchContextWindowResponse,
	type SwitchModelResponse,
	type SwitchVariantResponse,
	WsRpcGroup,
} from "./ws-rpc.js";

export interface CancelSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
}

export interface GetModelsRpcInput {
	readonly projectSlug: string;
	readonly sessionId?: string;
}

export interface GetAgentsRpcInput {
	readonly projectSlug: string;
	readonly sessionId?: string;
}

export interface GetCommandsRpcInput {
	readonly projectSlug: string;
	readonly sessionId?: string;
}

export interface GetProjectsRpcInput {
	readonly projectSlug: string;
}

export interface AddProjectRpcInput {
	readonly projectSlug: string;
	readonly directory: string;
	readonly instanceId?: string;
}

export interface RemoveProjectRpcInput {
	readonly projectSlug: string;
	readonly slug: string;
}

export interface RenameProjectRpcInput {
	readonly projectSlug: string;
	readonly slug: string;
	readonly title: string;
}

export interface SetProjectInstanceRpcInput {
	readonly projectSlug: string;
	readonly slug: string;
	readonly instanceId: string;
}

export interface InstanceMutationRpcInput {
	readonly projectSlug: string;
	readonly instanceId: string;
}

export interface RenameInstanceRpcInput {
	readonly projectSlug: string;
	readonly instanceId: string;
	readonly name: string;
}

export interface ScanNowRpcInput {
	readonly projectSlug: string;
}

export interface DetectProxyRpcInput {
	readonly projectSlug: string;
}

export interface ListPtysRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
}

export interface CreatePtyRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
}

export interface ResizePtyRpcInput {
	readonly projectSlug: string;
	readonly ptyId: string;
	readonly originId?: string;
	readonly cols?: number;
	readonly rows?: number;
}

export interface ClosePtyRpcInput {
	readonly projectSlug: string;
	readonly ptyId: string;
}

export interface CreateSessionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly title?: string;
	readonly requestId?: string;
	readonly providerId?: string;
}

export interface ViewSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly originId: string;
}

export interface DeleteSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly originId?: string;
}

export interface ForkSessionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly sessionId?: string;
	readonly messageId?: string;
}

export interface RespondPermissionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
	readonly persistScope?: PermissionPersistScope;
	readonly persistPattern?: string;
	readonly permissionDestination?: PermissionUpdateDestination;
}

export interface AnswerQuestionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly toolId: string;
	readonly answers: Readonly<Record<string, string>>;
}

export interface RejectQuestionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly toolId: string;
}

export interface GetTodoRpcInput {
	readonly projectSlug: string;
}

export interface GetFileTreeRpcInput {
	readonly projectSlug: string;
}

export interface GetFileListRpcInput {
	readonly projectSlug: string;
	readonly path?: string;
}

export interface GetFileContentRpcInput {
	readonly projectSlug: string;
	readonly path: string;
}

export interface GetToolContentRpcInput {
	readonly projectSlug: string;
	readonly toolId: string;
}

export interface ListDirectoriesRpcInput {
	readonly projectSlug: string;
	readonly path: string;
}

export interface SwitchAgentRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly agentId: string;
	readonly originId?: string;
}

export interface SwitchContextWindowRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly contextWindow: string;
	readonly originId?: string;
}

export interface SwitchModelRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly modelId: string;
	readonly providerId: string;
	readonly originId?: string;
}

export interface SetDefaultModelRpcInput {
	readonly projectSlug: string;
	readonly model: string;
	readonly provider: string;
	readonly originId?: string;
}

export interface ReloadProviderSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly originId?: string;
}

export interface RenameSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly title: string;
	readonly originId?: string;
}

export interface SwitchVariantRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly variant: string;
	readonly originId?: string;
}

export interface ListSessionsRpcInput {
	readonly projectSlug: string;
	readonly roots?: boolean;
	readonly query?: string;
}

export interface LoadMoreHistoryRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly offset: number;
}

export interface RewindSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly messageId: string;
}

export interface SendMessageRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly text: string;
	readonly images?: readonly string[];
	readonly originId?: string;
}

export interface SyncInputDraftRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly text: string;
	readonly originId?: string;
}

export interface SetLogLevelRpcInput {
	readonly projectSlug: string;
	readonly level: RpcLogLevel;
}

export interface WsRpcLocation {
	readonly protocol: string;
	readonly host: string;
}

export const makeWsRpcUrl = (
	projectSlug: string,
	location: WsRpcLocation = window.location,
): string => {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/p/${encodeURIComponent(projectSlug)}/rpc`;
};

const callCancelSession = (input: CancelSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.CancelSession(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetModels = (input: GetModelsRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetModels(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetAgents = (input: GetAgentsRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetAgents(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetCommands = (input: GetCommandsRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetCommands(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetProjects = (input: GetProjectsRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetProjects(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callAddProject = (input: AddProjectRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.AddProject({
				projectSlug: input.projectSlug,
				directory: input.directory,
				...(input.instanceId != null ? { instanceId: input.instanceId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRemoveProject = (input: RemoveProjectRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.RemoveProject(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRenameProject = (input: RenameProjectRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.RenameProject(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSetProjectInstance = (input: SetProjectInstanceRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SetProjectInstance(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callStartInstance = (input: InstanceMutationRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.StartInstance(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callStopInstance = (input: InstanceMutationRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.StopInstance(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRemoveInstance = (input: InstanceMutationRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.RemoveInstance(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRenameInstance = (input: RenameInstanceRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.RenameInstance(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callScanNow = (input: ScanNowRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ScanNow(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callDetectProxy = (input: DetectProxyRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.DetectProxy(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callListPtys = (input: ListPtysRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ListPtys(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callCreatePty = (input: CreatePtyRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.CreatePty(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callResizePty = (input: ResizePtyRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.ResizePty({
				projectSlug: input.projectSlug,
				ptyId: input.ptyId,
				...(input.originId != null ? { originId: input.originId } : {}),
				...(input.cols != null ? { cols: input.cols } : {}),
				...(input.rows != null ? { rows: input.rows } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callClosePty = (input: ClosePtyRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.ClosePty(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callCreateSession = (input: CreateSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.CreateSession({
				projectSlug: input.projectSlug,
				originId: input.originId,
				...(input.title != null ? { title: input.title } : {}),
				...(input.requestId != null ? { requestId: input.requestId } : {}),
				...(input.providerId != null ? { providerId: input.providerId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callViewSession = (input: ViewSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.ViewSession(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callDeleteSession = (input: DeleteSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.DeleteSession({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				...(input.originId != null ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callForkSession = (input: ForkSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ForkSession({
				projectSlug: input.projectSlug,
				originId: input.originId,
				...(input.sessionId != null ? { sessionId: input.sessionId } : {}),
				...(input.messageId != null ? { messageId: input.messageId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRespondPermission = (input: RespondPermissionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.RespondPermission({
				projectSlug: input.projectSlug,
				originId: input.originId,
				requestId: input.requestId,
				decision: input.decision,
				...(input.persistScope != null
					? { persistScope: input.persistScope }
					: {}),
				...(input.persistPattern != null
					? { persistPattern: input.persistPattern }
					: {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callAnswerQuestion = (input: AnswerQuestionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.AnswerQuestion({
				projectSlug: input.projectSlug,
				originId: input.originId,
				toolId: input.toolId,
				answers: { ...input.answers },
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRejectQuestion = (input: RejectQuestionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.RejectQuestion(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetTodo = (input: GetTodoRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetTodo(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetFileTree = (input: GetFileTreeRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetFileTree(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetFileList = (input: GetFileListRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetFileList(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetFileContent = (input: GetFileContentRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetFileContent(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callGetToolContent = (input: GetToolContentRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.GetToolContent(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callListDirectories = (input: ListDirectoriesRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ListDirectories(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSwitchAgent = (input: SwitchAgentRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.SwitchAgent({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				agentId: input.agentId,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSwitchContextWindow = (input: SwitchContextWindowRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SwitchContextWindow({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				contextWindow: input.contextWindow,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSwitchModel = (input: SwitchModelRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SwitchModel({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				modelId: input.modelId,
				providerId: input.providerId,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSetDefaultModel = (input: SetDefaultModelRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SetDefaultModel({
				projectSlug: input.projectSlug,
				model: input.model,
				provider: input.provider,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callReloadProviderSession = (input: ReloadProviderSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ReloadProviderSession({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRenameSession = (input: RenameSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.RenameSession({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				title: input.title,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSwitchVariant = (input: SwitchVariantRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SwitchVariant({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				variant: input.variant,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callListSessions = (input: ListSessionsRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.ListSessions(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callLoadMoreHistory = (input: LoadMoreHistoryRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.LoadMoreHistory(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callRewindSession = (input: RewindSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.RewindSession(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSendMessage = (input: SendMessageRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.SendMessage({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				text: input.text,
				...(input.images ? { images: [...input.images] } : {}),
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSyncInputDraft = (input: SyncInputDraftRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.SyncInputDraft({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				text: input.text,
				...(input.originId ? { originId: input.originId } : {}),
			});
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

const callSetLogLevel = (input: SetLogLevelRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			yield* client.SetLogLevel(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

export async function cancelSessionRpc(
	input: CancelSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callCancelSession(input));
}

export async function getModelsRpc(
	input: GetModelsRpcInput,
): Promise<GetModelsResponse> {
	return await runTransportEffect(callGetModels(input));
}

export async function getAgentsRpc(
	input: GetAgentsRpcInput,
): Promise<GetAgentsResponse> {
	return await runTransportEffect(callGetAgents(input));
}

export async function getCommandsRpc(
	input: GetCommandsRpcInput,
): Promise<GetCommandsResponse> {
	return await runTransportEffect(callGetCommands(input));
}

export async function getProjectsRpc(
	input: GetProjectsRpcInput,
): Promise<GetProjectsResponse> {
	return await runTransportEffect(callGetProjects(input));
}

export async function addProjectRpc(
	input: AddProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callAddProject(input));
}

export async function removeProjectRpc(
	input: RemoveProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRemoveProject(input));
}

export async function renameProjectRpc(
	input: RenameProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRenameProject(input));
}

export async function setProjectInstanceRpc(
	input: SetProjectInstanceRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callSetProjectInstance(input));
}

export async function startInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callStartInstance(input));
}

export async function stopInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callStopInstance(input));
}

export async function removeInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRemoveInstance(input));
}

export async function renameInstanceRpc(
	input: RenameInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRenameInstance(input));
}

export async function scanNowRpc(
	input: ScanNowRpcInput,
): Promise<ScanNowResponse> {
	return await runTransportEffect(callScanNow(input));
}

export async function detectProxyRpc(
	input: DetectProxyRpcInput,
): Promise<DetectProxyResponse> {
	return await runTransportEffect(callDetectProxy(input));
}

export async function listPtysRpc(
	input: ListPtysRpcInput,
): Promise<PtyListResponse> {
	return await runTransportEffect(callListPtys(input));
}

export async function createPtyRpc(input: CreatePtyRpcInput): Promise<void> {
	await runTransportEffect(callCreatePty(input));
}

export async function resizePtyRpc(input: ResizePtyRpcInput): Promise<void> {
	await runTransportEffect(callResizePty(input));
}

export async function closePtyRpc(input: ClosePtyRpcInput): Promise<void> {
	await runTransportEffect(callClosePty(input));
}

export async function createSessionRpc(
	input: CreateSessionRpcInput,
): Promise<CreateSessionResponse> {
	return await runTransportEffect(callCreateSession(input));
}

export async function viewSessionRpc(
	input: ViewSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callViewSession(input));
}

export async function deleteSessionRpc(
	input: DeleteSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callDeleteSession(input));
}

export async function forkSessionRpc(
	input: ForkSessionRpcInput,
): Promise<ForkSessionResponse> {
	return await runTransportEffect(callForkSession(input));
}

export async function respondPermissionRpc(
	input: RespondPermissionRpcInput,
): Promise<void> {
	await runTransportEffect(callRespondPermission(input));
}

export async function answerQuestionRpc(
	input: AnswerQuestionRpcInput,
): Promise<void> {
	await runTransportEffect(callAnswerQuestion(input));
}

export async function rejectQuestionRpc(
	input: RejectQuestionRpcInput,
): Promise<void> {
	await runTransportEffect(callRejectQuestion(input));
}

export async function getTodoRpc(
	input: GetTodoRpcInput,
): Promise<GetTodoResponse> {
	return await runTransportEffect(callGetTodo(input));
}

export async function getFileTreeRpc(
	input: GetFileTreeRpcInput,
): Promise<GetFileTreeResponse> {
	return await runTransportEffect(callGetFileTree(input));
}

export async function getFileListRpc(
	input: GetFileListRpcInput,
): Promise<GetFileListResponse> {
	return await runTransportEffect(callGetFileList(input));
}

export async function getFileContentRpc(
	input: GetFileContentRpcInput,
): Promise<GetFileContentResponse> {
	return await runTransportEffect(callGetFileContent(input));
}

export async function getToolContentRpc(
	input: GetToolContentRpcInput,
): Promise<GetToolContentResponse> {
	return await runTransportEffect(callGetToolContent(input));
}

export async function listDirectoriesRpc(
	input: ListDirectoriesRpcInput,
): Promise<ListDirectoriesResponse> {
	return await runTransportEffect(callListDirectories(input));
}

export async function switchAgentRpc(
	input: SwitchAgentRpcInput,
): Promise<void> {
	await runTransportEffect(callSwitchAgent(input));
}

export async function switchContextWindowRpc(
	input: SwitchContextWindowRpcInput,
): Promise<SwitchContextWindowResponse> {
	return await runTransportEffect(callSwitchContextWindow(input));
}

export async function switchModelRpc(
	input: SwitchModelRpcInput,
): Promise<SwitchModelResponse> {
	return await runTransportEffect(callSwitchModel(input));
}

export async function setDefaultModelRpc(
	input: SetDefaultModelRpcInput,
): Promise<SetDefaultModelResponse> {
	return await runTransportEffect(callSetDefaultModel(input));
}

export async function reloadProviderSessionRpc(
	input: ReloadProviderSessionRpcInput,
): Promise<ReloadProviderSessionResponse> {
	return await runTransportEffect(callReloadProviderSession(input));
}

export async function renameSessionRpc(
	input: RenameSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRenameSession(input));
}

export async function switchVariantRpc(
	input: SwitchVariantRpcInput,
): Promise<SwitchVariantResponse> {
	return await runTransportEffect(callSwitchVariant(input));
}

export async function listSessionsRpc(
	input: ListSessionsRpcInput,
): Promise<ListSessionsResponse> {
	return await runTransportEffect(callListSessions(input));
}

export async function loadMoreHistoryRpc(
	input: LoadMoreHistoryRpcInput,
): Promise<LoadMoreHistoryResponse> {
	return await runTransportEffect(callLoadMoreHistory(input));
}

export async function rewindSessionRpc(
	input: RewindSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRewindSession(input));
}

export async function sendMessageRpc(
	input: SendMessageRpcInput,
): Promise<void> {
	await runTransportEffect(callSendMessage(input));
}

export async function syncInputDraftRpc(
	input: SyncInputDraftRpcInput,
): Promise<void> {
	await runTransportEffect(callSyncInputDraft(input));
}

export async function setLogLevelRpc(
	input: SetLogLevelRpcInput,
): Promise<void> {
	await runTransportEffect(callSetLogLevel(input));
}
