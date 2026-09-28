import { Socket } from "@effect/platform";
import {
	type Rpc,
	RpcClient,
	type RpcClientError,
	type RpcGroup,
	RpcSerialization,
} from "@effect/rpc";
import { Effect, Either, type Schema } from "effect";
import { ProviderInstanceIdSchema } from "../../contracts/provider-instance.js";
import type { GetSkillContentResponse } from "../../contracts/ws-rpc.js";
import { runTransportEffect } from "./runtime.js";
import {
	type ClaudeSettingsResponse,
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
	type ListDaemonSessionsResponse,
	type ListDirectoriesResponse,
	type ListSessionsResponse,
	type LoadMoreHistoryResponse,
	type ProjectMutationResponse,
	type PtyListResponse,
	type ReloadProviderSessionResponse,
	type ResolveClaudeSettingsResponse,
	type ScanNowResponse,
	type SetDefaultModelResponse,
	type SetDefaultPermissionModeResponse,
	type SetHiddenEntriesResponse,
	type SwitchContextWindowResponse,
	type SwitchModelResponse,
	type SwitchPermissionModeResponse,
	type SwitchVariantResponse,
	WsRpcGroup,
} from "./ws-rpc.js";

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
type WsRpcMethod = WsRpc["_tag"];
type WsRpcInput<Method extends WsRpcMethod> = Rpc.PayloadConstructor<
	Rpc.ExtractTag<WsRpc, Method>
>;
type WsRpcEncodedInput<Method extends WsRpcMethod> = Omit<
	Schema.Schema.Encoded<Rpc.ExtractTag<WsRpc, Method>["payloadSchema"]>,
	"_tag"
>;
type WsRpcOutput<Method extends WsRpcMethod> = Rpc.Success<
	Rpc.ExtractTag<WsRpc, Method>
>;
type WsRpcError<Method extends WsRpcMethod> =
	| Rpc.Error<Rpc.ExtractTag<WsRpc, Method>>
	| RpcClientError.RpcClientError;

export type CancelSessionRpcInput = WsRpcInput<"CancelSession">;
export type GetModelsRpcInput = WsRpcInput<"GetModels">;
export type GetAgentsRpcInput = WsRpcInput<"GetAgents">;
export type GetCommandsRpcInput = WsRpcInput<"GetCommands">;
export type GetProjectsRpcInput = WsRpcInput<"GetProjects">;
export type AddProjectRpcInput = WsRpcInput<"AddProject">;
export type RemoveProjectRpcInput = WsRpcInput<"RemoveProject">;
export type RenameProjectRpcInput = WsRpcInput<"RenameProject">;
export type SetProjectInstanceRpcInput = WsRpcInput<"SetProjectInstance">;
export type InstanceMutationRpcInput = Omit<
	WsRpcInput<"RemoveInstance">,
	"_tag"
>;
export type RenameInstanceRpcInput = WsRpcInput<"RenameInstance">;
export type AddInstanceRpcInput = WsRpcInput<"AddInstance">;
export type UpdateInstanceRpcInput = WsRpcInput<"UpdateInstance">;
export type ScanNowRpcInput = WsRpcInput<"ScanNow">;
export type DetectProxyRpcInput = WsRpcInput<"DetectProxy">;
export type ListPtysRpcInput = WsRpcInput<"ListPtys">;
export type CreatePtyRpcInput = WsRpcInput<"CreatePty">;
export type ResizePtyRpcInput = WsRpcInput<"ResizePty">;
export type ClosePtyRpcInput = WsRpcInput<"ClosePty">;
export type CreateSessionRpcInput = WsRpcEncodedInput<"CreateSession">;
export type AttachProjectRpcInput = WsRpcInput<"AttachProject">;
export type ViewSessionRpcInput = WsRpcInput<"ViewSession">;
export type DeleteSessionRpcInput = WsRpcInput<"DeleteSession">;
export type ForkSessionRpcInput = WsRpcInput<"ForkSession">;
export type RespondPermissionRpcInput = WsRpcInput<"RespondPermission">;
export type AnswerQuestionRpcInput = WsRpcInput<"AnswerQuestion">;
export type RejectQuestionRpcInput = WsRpcInput<"RejectQuestion">;
export type GetTodoRpcInput = WsRpcInput<"GetTodo">;
export type GetFileTreeRpcInput = WsRpcInput<"GetFileTree">;
export type GetFileListRpcInput = WsRpcInput<"GetFileList">;
export type GetFileContentRpcInput = WsRpcInput<"GetFileContent">;
export type GetToolContentRpcInput = WsRpcInput<"GetToolContent">;
export type GetSkillContentRpcInput = WsRpcInput<"GetSkillContent">;
export type ListDirectoriesRpcInput = WsRpcInput<"ListDirectories">;
export type SwitchAgentRpcInput = WsRpcInput<"SwitchAgent">;
export type SwitchContextWindowRpcInput = WsRpcInput<"SwitchContextWindow">;
export type SwitchModelRpcInput = WsRpcInput<"SwitchModel">;
export type SetDefaultModelRpcInput = WsRpcInput<"SetDefaultModel">;
export type SetDefaultPermissionModeRpcInput =
	WsRpcInput<"SetDefaultPermissionMode">;
export type SetHiddenEntriesRpcInput = WsRpcInput<"SetHiddenEntries">;
export type GetClaudeSettingsRpcInput = WsRpcInput<"GetClaudeSettings">;
export type SetClaudeSettingsRpcInput = WsRpcInput<"SetClaudeSettings">;
export type ResolveClaudeSettingsRpcInput = WsRpcInput<"ResolveClaudeSettings">;
export type ReloadProviderSessionRpcInput = WsRpcInput<"ReloadProviderSession">;
export type RenameSessionRpcInput = WsRpcInput<"RenameSession">;
export type SetSessionSettledRpcInput = WsRpcInput<"SetSessionSettled">;
export type MarkSessionReadRpcInput = Omit<
	WsRpcInput<"MarkSessionRead">,
	"_tag"
>;
export type SetSessionPinnedRpcInput = WsRpcInput<"SetSessionPinned">;
export type SetSessionAutoSettleRpcInput = WsRpcInput<"SetSessionAutoSettle">;
export type SnoozeSessionRpcInput = WsRpcInput<"SnoozeSession">;
export type UnsnoozeSessionRpcInput = WsRpcInput<"UnsnoozeSession">;
export type SwitchVariantRpcInput = WsRpcInput<"SwitchVariant">;
export type SwitchPermissionModeRpcInput = WsRpcInput<"SwitchPermissionMode">;
export type ListSessionsRpcInput = WsRpcInput<"ListSessions">;
export type ResolveSessionRpcInput = WsRpcInput<"ResolveSession">;
export type ListDaemonSessionsRpcInput = WsRpcInput<"ListDaemonSessions">;
export type LoadMoreHistoryRpcInput = WsRpcInput<"LoadMoreHistory">;
export type RewindSessionRpcInput = WsRpcInput<"RewindSession">;
export type SendMessageRpcInput = WsRpcInput<"SendMessage">;
export type SyncInputDraftRpcInput = WsRpcInput<"SyncInputDraft">;
export type SetLogLevelRpcInput = WsRpcInput<"SetLogLevel">;

export interface WsRpcLocation {
	readonly protocol: string;
	readonly host: string;
}

export const makeWsRpcUrl = (
	location: WsRpcLocation = window.location,
): string => {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/rpc`;
};

const callRpc = <Method extends WsRpcMethod>(
	method: Method,
	input: WsRpcInput<Method>,
): Effect.Effect<WsRpcOutput<Method>, WsRpcError<Method>> =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup, { flatten: true });
			return yield* client(method, input) as unknown as Effect.Effect<
				WsRpcOutput<Method>,
				WsRpcError<Method>
			>;
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl())),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

export async function resolveSessionRpc(
	input: ResolveSessionRpcInput,
): Promise<{ readonly projectSlug: string | null }> {
	return await runTransportEffect(callRpc("ResolveSession", input));
}

export async function cancelSessionRpc(
	input: CancelSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("CancelSession", input));
}

export async function getModelsRpc(
	input: GetModelsRpcInput,
): Promise<GetModelsResponse> {
	return await runTransportEffect(callRpc("GetModels", input));
}

export async function getAgentsRpc(
	input: GetAgentsRpcInput,
): Promise<GetAgentsResponse> {
	return await runTransportEffect(callRpc("GetAgents", input));
}

export async function getCommandsRpc(
	input: GetCommandsRpcInput,
): Promise<GetCommandsResponse> {
	return await runTransportEffect(callRpc("GetCommands", input));
}

export async function getProjectsRpc(
	input: GetProjectsRpcInput,
): Promise<GetProjectsResponse> {
	return await runTransportEffect(callRpc("GetProjects", input));
}

export async function addProjectRpc(
	input: AddProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRpc("AddProject", input));
}

export async function removeProjectRpc(
	input: RemoveProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRpc("RemoveProject", input));
}

export async function renameProjectRpc(
	input: RenameProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRpc("RenameProject", input));
}

export async function setProjectInstanceRpc(
	input: SetProjectInstanceRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRpc("SetProjectInstance", input));
}

export async function startInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("StartInstance", input));
}

export async function stopInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("StopInstance", input));
}

export async function removeInstanceRpc(
	input: InstanceMutationRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("RemoveInstance", input));
}

export async function renameInstanceRpc(
	input: RenameInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("RenameInstance", input));
}

export async function addInstanceRpc(
	input: AddInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("AddInstance", input));
}

export async function updateInstanceRpc(
	input: UpdateInstanceRpcInput,
): Promise<InstanceListResponse> {
	return await runTransportEffect(callRpc("UpdateInstance", input));
}

export async function scanNowRpc(
	input: ScanNowRpcInput,
): Promise<ScanNowResponse> {
	return await runTransportEffect(callRpc("ScanNow", input));
}

export async function detectProxyRpc(
	input: DetectProxyRpcInput,
): Promise<DetectProxyResponse> {
	return await runTransportEffect(callRpc("DetectProxy", input));
}

export async function listPtysRpc(
	input: ListPtysRpcInput,
): Promise<PtyListResponse> {
	return await runTransportEffect(callRpc("ListPtys", input));
}

export async function createPtyRpc(input: CreatePtyRpcInput): Promise<void> {
	await runTransportEffect(callRpc("CreatePty", input));
}

export async function resizePtyRpc(input: ResizePtyRpcInput): Promise<void> {
	await runTransportEffect(callRpc("ResizePty", input));
}

export async function closePtyRpc(input: ClosePtyRpcInput): Promise<void> {
	await runTransportEffect(callRpc("ClosePty", input));
}

export async function createSessionRpc(
	input: CreateSessionRpcInput,
): Promise<CreateSessionResponse> {
	return await runTransportEffect(
		callRpc("CreateSession", {
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
}

export async function viewSessionRpc(
	input: ViewSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("ViewSession", input));
}

export async function attachProjectRpc(
	input: AttachProjectRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("AttachProject", input));
}

export async function deleteSessionRpc(
	input: DeleteSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("DeleteSession", input));
}

export async function forkSessionRpc(
	input: ForkSessionRpcInput,
): Promise<ForkSessionResponse> {
	return await runTransportEffect(callRpc("ForkSession", input));
}

export async function respondPermissionRpc(
	input: RespondPermissionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("RespondPermission", input));
}

export async function answerQuestionRpc(
	input: AnswerQuestionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("AnswerQuestion", input));
}

export async function rejectQuestionRpc(
	input: RejectQuestionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("RejectQuestion", input));
}

export async function getTodoRpc(
	input: GetTodoRpcInput,
): Promise<GetTodoResponse> {
	return await runTransportEffect(callRpc("GetTodo", input));
}

export async function getFileTreeRpc(
	input: GetFileTreeRpcInput,
): Promise<GetFileTreeResponse> {
	return await runTransportEffect(callRpc("GetFileTree", input));
}

export async function getFileListRpc(
	input: GetFileListRpcInput,
): Promise<GetFileListResponse> {
	return await runTransportEffect(callRpc("GetFileList", input));
}

export async function getFileContentRpc(
	input: GetFileContentRpcInput,
): Promise<GetFileContentResponse> {
	return await runTransportEffect(callRpc("GetFileContent", input));
}

export async function getToolContentRpc(
	input: GetToolContentRpcInput,
): Promise<GetToolContentResponse> {
	return await runTransportEffect(callRpc("GetToolContent", input));
}

export async function getSkillContentRpc(
	input: GetSkillContentRpcInput,
): Promise<GetSkillContentResponse> {
	return await runTransportEffect(callRpc("GetSkillContent", input));
}

export async function listDirectoriesRpc(
	input: ListDirectoriesRpcInput,
): Promise<ListDirectoriesResponse> {
	return await runTransportEffect(callRpc("ListDirectories", input));
}

export async function switchAgentRpc(
	input: SwitchAgentRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SwitchAgent", input));
}

export async function switchContextWindowRpc(
	input: SwitchContextWindowRpcInput,
): Promise<SwitchContextWindowResponse> {
	return await runTransportEffect(callRpc("SwitchContextWindow", input));
}

export async function switchModelRpc(
	input: SwitchModelRpcInput,
): Promise<SwitchModelResponse> {
	return await runTransportEffect(callRpc("SwitchModel", input));
}

export async function setDefaultModelRpc(
	input: SetDefaultModelRpcInput,
): Promise<SetDefaultModelResponse> {
	return await runTransportEffect(callRpc("SetDefaultModel", input));
}

export async function setDefaultPermissionModeRpc(
	input: SetDefaultPermissionModeRpcInput,
): Promise<SetDefaultPermissionModeResponse> {
	return await runTransportEffect(callRpc("SetDefaultPermissionMode", input));
}

export async function setHiddenEntriesRpc(
	input: SetHiddenEntriesRpcInput,
): Promise<SetHiddenEntriesResponse> {
	return await runTransportEffect(callRpc("SetHiddenEntries", input));
}

export async function getClaudeSettingsRpc(
	input: GetClaudeSettingsRpcInput,
): Promise<ClaudeSettingsResponse> {
	return await runTransportEffect(callRpc("GetClaudeSettings", input));
}

export async function setClaudeSettingsRpc(
	input: SetClaudeSettingsRpcInput,
): Promise<ClaudeSettingsResponse> {
	return await runTransportEffect(callRpc("SetClaudeSettings", input));
}

export async function resolveClaudeSettingsRpc(
	input: ResolveClaudeSettingsRpcInput,
): Promise<ResolveClaudeSettingsResponse> {
	return await runTransportEffect(callRpc("ResolveClaudeSettings", input));
}

export async function reloadProviderSessionRpc(
	input: ReloadProviderSessionRpcInput,
): Promise<ReloadProviderSessionResponse> {
	return await runTransportEffect(callRpc("ReloadProviderSession", input));
}

export async function renameSessionRpc(
	input: RenameSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("RenameSession", input));
}

export async function setSessionSettledRpc(
	input: SetSessionSettledRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SetSessionSettled", input));
}

export async function markSessionUnreadRpc(
	input: MarkSessionReadRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("MarkSessionUnread", input));
}

export async function markSessionReadRpc(
	input: MarkSessionReadRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("MarkSessionRead", input));
}

export async function setSessionPinnedRpc(
	input: SetSessionPinnedRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SetSessionPinned", input));
}

export async function setSessionAutoSettleRpc(
	input: SetSessionAutoSettleRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SetSessionAutoSettle", input));
}

export async function getAutoSettleSettingRpc(): Promise<number | null> {
	return await runTransportEffect(
		Effect.map(
			callRpc("GetAutoSettleSetting", {}),
			(response) => response.autoSettleAfterDays,
		),
	);
}

export async function setAutoSettleSettingRpc(
	days: number | null,
): Promise<number | null> {
	return await runTransportEffect(
		Effect.map(
			callRpc("SetAutoSettleSetting", { autoSettleAfterDays: days }),
			(response) => response.autoSettleAfterDays,
		),
	);
}

export async function snoozeSessionRpc(
	input: SnoozeSessionRpcInput,
): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(callRpc("SnoozeSession", input)),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function unsnoozeSessionRpc(
	input: UnsnoozeSessionRpcInput,
): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(callRpc("UnsnoozeSession", input)),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function switchVariantRpc(
	input: SwitchVariantRpcInput,
): Promise<SwitchVariantResponse> {
	return await runTransportEffect(callRpc("SwitchVariant", input));
}

export async function switchPermissionModeRpc(
	input: SwitchPermissionModeRpcInput,
): Promise<SwitchPermissionModeResponse> {
	return await runTransportEffect(callRpc("SwitchPermissionMode", input));
}

export async function listSessionsRpc(
	input: ListSessionsRpcInput,
): Promise<ListSessionsResponse> {
	return await runTransportEffect(callRpc("ListSessions", input));
}

export async function listDaemonSessionsRpc(
	input: ListDaemonSessionsRpcInput,
): Promise<ListDaemonSessionsResponse> {
	return await runTransportEffect(callRpc("ListDaemonSessions", input));
}

export async function loadMoreHistoryRpc(
	input: LoadMoreHistoryRpcInput,
): Promise<LoadMoreHistoryResponse> {
	return await runTransportEffect(callRpc("LoadMoreHistory", input));
}

export async function rewindSessionRpc(
	input: RewindSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("RewindSession", input));
}

export async function sendMessageRpc(
	input: SendMessageRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SendMessage", input));
}

export async function syncInputDraftRpc(
	input: SyncInputDraftRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SyncInputDraft", input));
}

export async function setLogLevelRpc(
	input: SetLogLevelRpcInput,
): Promise<void> {
	await runTransportEffect(callRpc("SetLogLevel", input));
}
