import { Effect } from "effect";
import type { ClaudeSettingsOverrides } from "../../contracts/claude-settings.js";
import { ProviderInstanceIdSchema } from "../../contracts/provider-instance.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import { runTransportEffect } from "./runtime.js";
import { type WsRpcClient, WsRpcClients } from "./shared-client.js";

// Keep the public URL helper available to existing callers.
export { makeWsRpcUrl, type WsRpcLocation } from "./shared-client.js";

import type {
	ClaudeSettingsResponse,
	CreateSessionResponse,
	DetectProxyResponse,
	ForkSessionResponse,
	GetAgentsResponse,
	GetCommandsResponse,
	GetFileContentResponse,
	GetFileListResponse,
	GetFileTreeResponse,
	GetModelsResponse,
	GetProjectsResponse,
	GetTodoResponse,
	GetToolContentResponse,
	InstanceListResponse,
	ListDirectoriesResponse,
	ListSessionsResponse,
	LoadMoreHistoryResponse,
	PermissionDecision,
	PermissionPersistScope,
	PermissionUpdateDestination,
	ProjectMutationResponse,
	PtyListResponse,
	ReloadProviderSessionResponse,
	ResolveClaudeSettingsResponse,
	RewindSessionResponse,
	RpcLogLevel,
	ScanNowResponse,
	SetDefaultModelResponse,
	SetDefaultPermissionModeResponse,
	SetHiddenEntriesResponse,
	SwitchContextWindowResponse,
	SwitchModelResponse,
	SwitchPermissionModeResponse,
	SwitchVariantResponse,
} from "./ws-rpc.js";

export interface CancelSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly commandId: string;
}

export interface GetModelsRpcInput {
	readonly projectSlug: string;
	readonly sessionId?: string;
	readonly instanceId?: string;
}

export interface GetAgentsRpcInput {
	readonly projectSlug: string;
	readonly sessionId?: string;
	readonly instanceId?: string;
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

export interface AddInstanceRpcInput {
	readonly projectSlug: string;
	readonly name: string;
	readonly driver?: string;
	readonly managed?: boolean;
	readonly port?: number;
	readonly url?: string;
	readonly env?: Record<string, string>;
	readonly configDir?: string;
}

export interface UpdateInstanceRpcInput {
	readonly projectSlug: string;
	readonly instanceId: string;
	readonly name?: string;
	readonly port?: number;
	readonly env?: Record<string, string>;
	readonly configDir?: string;
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
	/** Harness instance to bind the session to (preferred over providerId). */
	readonly instanceId?: string;
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
	readonly commandId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
	readonly persistScope?: PermissionPersistScope;
	readonly persistPattern?: string;
	readonly permissionDestination?: PermissionUpdateDestination;
}

export interface AnswerQuestionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly commandId: string;
	readonly toolId: string;
	readonly answers: Readonly<Record<string, string>>;
}

export interface RejectQuestionRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly commandId: string;
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

export interface SetDefaultPermissionModeRpcInput {
	readonly projectSlug: string;
	readonly mode: SessionPermissionMode;
	readonly originId?: string;
}

export interface SetHiddenEntriesRpcInput {
	readonly projectSlug: string;
	readonly hiddenModels?: readonly string[];
	readonly hiddenAgents?: readonly string[];
	readonly originId?: string;
}

export interface GetClaudeSettingsRpcInput {
	readonly projectSlug: string;
}

export interface SetClaudeSettingsRpcInput {
	readonly projectSlug: string;
	readonly overrides: ClaudeSettingsOverrides;
	readonly originId?: string;
}

export interface ResolveClaudeSettingsRpcInput {
	readonly projectSlug: string;
	readonly instanceId: string;
}

export interface ReloadProviderSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly commandId: string;
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

export interface SwitchPermissionModeRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly mode: SessionPermissionMode;
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
	readonly commandId: string;
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

const callControl = <A, E>(
	projectSlug: string,
	call: (client: WsRpcClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, WsRpcClients> =>
	Effect.gen(function* () {
		const clients = yield* WsRpcClients;
		const { control } = yield* clients.forProject(projectSlug);
		return yield* call(control);
	});

const callCancelSession = (input: CancelSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.CancelSession(input).pipe(Effect.asVoid),
	);

const callGetModels = (input: GetModelsRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetModels(input));

const callGetAgents = (input: GetAgentsRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetAgents(input));

const callGetCommands = (input: GetCommandsRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetCommands(input));

const callGetProjects = (input: GetProjectsRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetProjects(input));

const callAddProject = (input: AddProjectRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.AddProject({
			projectSlug: input.projectSlug,
			directory: input.directory,
			...(input.instanceId != null ? { instanceId: input.instanceId } : {}),
		}),
	);

const callRemoveProject = (input: RemoveProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client.RemoveProject(input));

const callRenameProject = (input: RenameProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client.RenameProject(input));

const callSetProjectInstance = (input: SetProjectInstanceRpcInput) =>
	callControl(input.projectSlug, (client) => client.SetProjectInstance(input));

const callStartInstance = (input: InstanceMutationRpcInput) =>
	callControl(input.projectSlug, (client) => client.StartInstance(input));

const callStopInstance = (input: InstanceMutationRpcInput) =>
	callControl(input.projectSlug, (client) => client.StopInstance(input));

const callRemoveInstance = (input: InstanceMutationRpcInput) =>
	callControl(input.projectSlug, (client) => client.RemoveInstance(input));

const callRenameInstance = (input: RenameInstanceRpcInput) =>
	callControl(input.projectSlug, (client) => client.RenameInstance(input));

const callAddInstance = (input: AddInstanceRpcInput) =>
	callControl(input.projectSlug, (client) => client.AddInstance(input));

const callUpdateInstance = (input: UpdateInstanceRpcInput) =>
	callControl(input.projectSlug, (client) => client.UpdateInstance(input));

const callScanNow = (input: ScanNowRpcInput) =>
	callControl(input.projectSlug, (client) => client.ScanNow(input));

const callDetectProxy = (input: DetectProxyRpcInput) =>
	callControl(input.projectSlug, (client) => client.DetectProxy(input));

const callListPtys = (input: ListPtysRpcInput) =>
	callControl(input.projectSlug, (client) => client.ListPtys(input));

const callCreatePty = (input: CreatePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.CreatePty(input).pipe(Effect.asVoid),
	);

const callResizePty = (input: ResizePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.ResizePty({
				projectSlug: input.projectSlug,
				ptyId: input.ptyId,
				...(input.originId != null ? { originId: input.originId } : {}),
				...(input.cols != null ? { cols: input.cols } : {}),
				...(input.rows != null ? { rows: input.rows } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callClosePty = (input: ClosePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.ClosePty(input).pipe(Effect.asVoid),
	);

const callCreateSession = (input: CreateSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.CreateSession({
			projectSlug: input.projectSlug,
			originId: input.originId,
			...(input.title != null ? { title: input.title } : {}),
			...(input.requestId != null ? { requestId: input.requestId } : {}),
			...(input.instanceId != null
				? { instanceId: ProviderInstanceIdSchema.make(input.instanceId) }
				: {}),
			...(input.providerId != null ? { providerId: input.providerId } : {}),
		}),
	);

const callViewSession = (input: ViewSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.ViewSession(input).pipe(Effect.asVoid),
	);

const callDeleteSession = (input: DeleteSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.DeleteSession({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				...(input.originId != null ? { originId: input.originId } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callForkSession = (input: ForkSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.ForkSession({
			projectSlug: input.projectSlug,
			originId: input.originId,
			...(input.sessionId != null ? { sessionId: input.sessionId } : {}),
			...(input.messageId != null ? { messageId: input.messageId } : {}),
		}),
	);

const callRespondPermission = (input: RespondPermissionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.RespondPermission({
				projectSlug: input.projectSlug,
				originId: input.originId,
				commandId: input.commandId,
				requestId: input.requestId,
				decision: input.decision,
				...(input.persistScope != null
					? { persistScope: input.persistScope }
					: {}),
				...(input.persistPattern != null
					? { persistPattern: input.persistPattern }
					: {}),
				...(input.permissionDestination != null
					? { permissionDestination: input.permissionDestination }
					: {}),
			})
			.pipe(Effect.asVoid),
	);

const callAnswerQuestion = (input: AnswerQuestionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.AnswerQuestion({
				projectSlug: input.projectSlug,
				originId: input.originId,
				commandId: input.commandId,
				toolId: input.toolId,
				answers: { ...input.answers },
			})
			.pipe(Effect.asVoid),
	);

const callRejectQuestion = (input: RejectQuestionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.RejectQuestion({
				projectSlug: input.projectSlug,
				originId: input.originId,
				commandId: input.commandId,
				toolId: input.toolId,
			})
			.pipe(Effect.asVoid),
	);

const callGetTodo = (input: GetTodoRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetTodo(input));

const callGetFileTree = (input: GetFileTreeRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetFileTree(input));

const callGetFileList = (input: GetFileListRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetFileList(input));

const callGetFileContent = (input: GetFileContentRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetFileContent(input));

const callGetToolContent = (input: GetToolContentRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetToolContent(input));

const callListDirectories = (input: ListDirectoriesRpcInput) =>
	callControl(input.projectSlug, (client) => client.ListDirectories(input));

const callSwitchAgent = (input: SwitchAgentRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.SwitchAgent({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				agentId: input.agentId,
				...(input.originId ? { originId: input.originId } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callSwitchContextWindow = (input: SwitchContextWindowRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SwitchContextWindow({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			contextWindow: input.contextWindow,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchModel = (input: SwitchModelRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SwitchModel({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			modelId: input.modelId,
			providerId: input.providerId,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetDefaultModel = (input: SetDefaultModelRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SetDefaultModel({
			projectSlug: input.projectSlug,
			model: input.model,
			provider: input.provider,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetDefaultPermissionMode = (
	input: SetDefaultPermissionModeRpcInput,
) =>
	callControl(input.projectSlug, (client) =>
		client.SetDefaultPermissionMode({
			projectSlug: input.projectSlug,
			mode: input.mode,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetHiddenEntries = (input: SetHiddenEntriesRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SetHiddenEntries({
			projectSlug: input.projectSlug,
			...(input.hiddenModels ? { hiddenModels: input.hiddenModels } : {}),
			...(input.hiddenAgents ? { hiddenAgents: input.hiddenAgents } : {}),
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callGetClaudeSettings = (input: GetClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) => client.GetClaudeSettings(input));

const callSetClaudeSettings = (input: SetClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SetClaudeSettings({
			projectSlug: input.projectSlug,
			overrides: input.overrides,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callResolveClaudeSettings = (input: ResolveClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.ResolveClaudeSettings(input),
	);

const callReloadProviderSession = (input: ReloadProviderSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.ReloadProviderSession({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			commandId: input.commandId,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callRenameSession = (input: RenameSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.RenameSession({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				title: input.title,
				...(input.originId ? { originId: input.originId } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callSwitchVariant = (input: SwitchVariantRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SwitchVariant({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			variant: input.variant,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchPermissionMode = (input: SwitchPermissionModeRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SwitchPermissionMode({
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			mode: input.mode,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callListSessions = (input: ListSessionsRpcInput) =>
	callControl(input.projectSlug, (client) => client.ListSessions(input));

const callLoadMoreHistory = (input: LoadMoreHistoryRpcInput) =>
	callControl(input.projectSlug, (client) => client.LoadMoreHistory(input));

const callRewindSession = (input: RewindSessionRpcInput) =>
	callControl(input.projectSlug, (client) => client.RewindSession(input));

const callSendMessage = (input: SendMessageRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.SendMessage({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				text: input.text,
				commandId: input.commandId,
				...(input.images ? { images: [...input.images] } : {}),
				...(input.originId ? { originId: input.originId } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callSyncInputDraft = (input: SyncInputDraftRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client
			.SyncInputDraft({
				projectSlug: input.projectSlug,
				sessionId: input.sessionId,
				text: input.text,
				...(input.originId ? { originId: input.originId } : {}),
			})
			.pipe(Effect.asVoid),
	);

const callSetLogLevel = (input: SetLogLevelRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client.SetLogLevel(input).pipe(Effect.asVoid),
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

export async function addInstanceRpc(
	input: AddInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callAddInstance(input));
}

export async function updateInstanceRpc(
	input: UpdateInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callUpdateInstance(input));
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

export async function setDefaultPermissionModeRpc(
	input: SetDefaultPermissionModeRpcInput,
): Promise<SetDefaultPermissionModeResponse> {
	return await runTransportEffect(callSetDefaultPermissionMode(input));
}

export async function setHiddenEntriesRpc(
	input: SetHiddenEntriesRpcInput,
): Promise<SetHiddenEntriesResponse> {
	return await runTransportEffect(callSetHiddenEntries(input));
}

export async function getClaudeSettingsRpc(
	input: GetClaudeSettingsRpcInput,
): Promise<ClaudeSettingsResponse> {
	return await runTransportEffect(callGetClaudeSettings(input));
}

export async function setClaudeSettingsRpc(
	input: SetClaudeSettingsRpcInput,
): Promise<ClaudeSettingsResponse> {
	return await runTransportEffect(callSetClaudeSettings(input));
}

export async function resolveClaudeSettingsRpc(
	input: ResolveClaudeSettingsRpcInput,
): Promise<ResolveClaudeSettingsResponse> {
	return await runTransportEffect(callResolveClaudeSettings(input));
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

export async function switchPermissionModeRpc(
	input: SwitchPermissionModeRpcInput,
): Promise<SwitchPermissionModeResponse> {
	return await runTransportEffect(callSwitchPermissionMode(input));
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
): Promise<RewindSessionResponse> {
	return await runTransportEffect(callRewindSession(input));
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
