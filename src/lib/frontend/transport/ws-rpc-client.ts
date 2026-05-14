import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import { getRuntime } from "./runtime.js";
import {
	type CreateSessionResponse,
	type GetAgentsResponse,
	type GetCommandsResponse,
	type GetFileContentResponse,
	type GetFileListResponse,
	type GetFileTreeResponse,
	type GetModelsResponse,
	type GetProjectsResponse,
	type GetTodoResponse,
	type GetToolContentResponse,
	type ListDirectoriesResponse,
	type ListSessionsResponse,
	type LoadMoreHistoryResponse,
	type ReloadProviderSessionResponse,
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

export interface CreateSessionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly title?: string;
	readonly requestId?: string;
}

export interface ViewSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly originId: string;
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

const callCreateSession = (input: CreateSessionRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.CreateSession({
				projectSlug: input.projectSlug,
				originId: input.originId,
				...(input.title != null ? { title: input.title } : {}),
				...(input.requestId != null ? { requestId: input.requestId } : {}),
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

export async function cancelSessionRpc(
	input: CancelSessionRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callCancelSession(input));
}

export async function getModelsRpc(
	input: GetModelsRpcInput,
): Promise<GetModelsResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetModels(input));
}

export async function getAgentsRpc(
	input: GetAgentsRpcInput,
): Promise<GetAgentsResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetAgents(input));
}

export async function getCommandsRpc(
	input: GetCommandsRpcInput,
): Promise<GetCommandsResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetCommands(input));
}

export async function getProjectsRpc(
	input: GetProjectsRpcInput,
): Promise<GetProjectsResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetProjects(input));
}

export async function createSessionRpc(
	input: CreateSessionRpcInput,
): Promise<CreateSessionResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callCreateSession(input));
}

export async function viewSessionRpc(
	input: ViewSessionRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callViewSession(input));
}

export async function getTodoRpc(
	input: GetTodoRpcInput,
): Promise<GetTodoResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetTodo(input));
}

export async function getFileTreeRpc(
	input: GetFileTreeRpcInput,
): Promise<GetFileTreeResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetFileTree(input));
}

export async function getFileListRpc(
	input: GetFileListRpcInput,
): Promise<GetFileListResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetFileList(input));
}

export async function getFileContentRpc(
	input: GetFileContentRpcInput,
): Promise<GetFileContentResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetFileContent(input));
}

export async function getToolContentRpc(
	input: GetToolContentRpcInput,
): Promise<GetToolContentResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callGetToolContent(input));
}

export async function listDirectoriesRpc(
	input: ListDirectoriesRpcInput,
): Promise<ListDirectoriesResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callListDirectories(input));
}

export async function switchAgentRpc(
	input: SwitchAgentRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callSwitchAgent(input));
}

export async function switchContextWindowRpc(
	input: SwitchContextWindowRpcInput,
): Promise<SwitchContextWindowResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callSwitchContextWindow(input));
}

export async function switchModelRpc(
	input: SwitchModelRpcInput,
): Promise<SwitchModelResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callSwitchModel(input));
}

export async function setDefaultModelRpc(
	input: SetDefaultModelRpcInput,
): Promise<SetDefaultModelResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callSetDefaultModel(input));
}

export async function reloadProviderSessionRpc(
	input: ReloadProviderSessionRpcInput,
): Promise<ReloadProviderSessionResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callReloadProviderSession(input));
}

export async function renameSessionRpc(
	input: RenameSessionRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callRenameSession(input));
}

export async function switchVariantRpc(
	input: SwitchVariantRpcInput,
): Promise<SwitchVariantResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callSwitchVariant(input));
}

export async function listSessionsRpc(
	input: ListSessionsRpcInput,
): Promise<ListSessionsResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callListSessions(input));
}

export async function loadMoreHistoryRpc(
	input: LoadMoreHistoryRpcInput,
): Promise<LoadMoreHistoryResponse> {
	const runtime = await getRuntime();
	return await runtime.runPromise(callLoadMoreHistory(input));
}

export async function rewindSessionRpc(
	input: RewindSessionRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callRewindSession(input));
}

export async function sendMessageRpc(
	input: SendMessageRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callSendMessage(input));
}

export async function syncInputDraftRpc(
	input: SyncInputDraftRpcInput,
): Promise<void> {
	const runtime = await getRuntime();
	await runtime.runPromise(callSyncInputDraft(input));
}
