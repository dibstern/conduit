import type { Rpc, RpcGroup } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Effect, Either, HashSet } from "effect";
import type { ClaudeSettingsOverrides } from "../../contracts/claude-settings.js";
import type { UsageLimitsSetting } from "../../contracts/limit-recovery.js";
import type { SessionMode } from "../../contracts/project-file.js";
import { AccountIdSchema } from "../../contracts/provider-instance.js";
import type { ToolCallId } from "../../contracts/tool-wire.js";
import type {
	WorktreeCleanup,
	WorktreeCleanupReport,
} from "../../contracts/worktree.js";
import {
	type GetSessionSkillsResponse,
	type GetSkillContentResponse,
	type GoalDetails,
	RpcLogLevelSchema,
	type SaveProjectInput,
	type SetKeepAwakeResponse,
	type WsRpcGroup,
} from "../../contracts/ws-rpc.js";
import type {
	GroupingMode,
	SessionPermissionMode,
} from "../../shared-types.js";
import { getCurrentSlug } from "../stores/router.svelte.js";
import { runTransportEffect } from "./runtime.js";
import { type WsRpcClient, WsRpcClients } from "./shared-client.js";

export type { GoalDetails } from "../../contracts/ws-rpc.js";
export { SetPinRejected } from "../../contracts/ws-rpc.js";
// Keep the public URL helper available to existing callers.
export { makeWsRpcUrl, type WsRpcLocation } from "./shared-client.js";

import type {
	ClaudeSettingsResponse,
	ContinuationHandoffResponse,
	CreateSessionResponse,
	DetectProxyResponse,
	FindFoldersResponse,
	ForkSessionResponse,
	GetAgentsResponse,
	GetCommandsResponse,
	GetFileContentResponse,
	GetFileListResponse,
	GetFileTreeResponse,
	GetModelsResponse,
	GetProjectsResponse,
	GetToolDetailsResponse,
	InboxCommandResponse,
	InstanceListResponse,
	ListDaemonSessionsResponse,
	LoadMoreHistoryResponse,
	PermissionDecision,
	PermissionPersistScope,
	PermissionUpdateDestination,
	PreviewContinuationResponse,
	ProjectMutationResponse,
	QuotaForAccountsResponse,
	ReloadProviderSessionResponse,
	ResolveClaudeSettingsResponse,
	RewindSessionResponse,
	RpcLogLevel,
	SaveProjectResponse,
	ScanNowResponse,
	SetDefaultModelResponse,
	SetDefaultPermissionModeResponse,
	SetHarnessDefaultResponse,
	SetHiddenEntriesResponse,
	SwitchContextWindowResponse,
	SwitchModelResponse,
	SwitchPermissionModeResponse,
	SwitchVariantResponse,
	UndoRewindResponse,
	ViewSessionResponse,
} from "./ws-rpc.js";

type RpcScope =
	| { readonly projectSlug: string; readonly sessionId?: never }
	| { readonly sessionId: string; readonly projectSlug?: never };

type Rpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type UnaryTag = {
	[T in Rpcs["_tag"]]: [Rpc.IsStream<Rpcs, T>] extends [never] ? T : never;
}[Rpcs["_tag"]];
type Payload<T extends UnaryTag> = Rpc.PayloadConstructor<
	Rpc.ExtractTag<Rpcs, T>
>;
type Success<T extends UnaryTag> = Rpc.Success<Rpc.ExtractTag<Rpcs, T>>;
type Declared<T extends UnaryTag> = Rpc.Error<Rpc.ExtractTag<Rpcs, T>>;

/** Call a unary RPC on the shared control socket, sending the payload as given. */
export function rpcEffect<T extends UnaryTag>(
	tag: T,
	payload: Payload<T>,
): Effect.Effect<Success<T>, Declared<T> | RpcClientError, WsRpcClients>;
export function rpcEffect<T extends UnaryTag>(tag: T, payload: Payload<T>) {
	return Effect.gen(function* () {
		const clients = yield* WsRpcClients;
		const { control } = yield* clients.forProject("");
		return yield* control(tag, payload);
	}).pipe(
		Effect.catchAllCause((cause) =>
			Effect.flatMap(Effect.descriptor, (fiber) => {
				if (HashSet.size(fiber.interruptors) > 0)
					return Effect.failCause(cause);
				if (Cause.isFailType(cause)) return Effect.fail(cause.error);
				return Effect.fail(
					new RpcClientError({
						reason: "Unknown",
						message: "RPC call failed",
						cause: Cause.squash(cause),
					}),
				);
			}),
		),
	);
}

export async function rpc<T extends UnaryTag>(
	tag: T,
	payload: Payload<T>,
): Promise<Success<T>> {
	const result = await runTransportEffect(
		Effect.either(rpcEffect(tag, payload)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export interface CancelSessionRpcInput {
	readonly sessionId: string;
	readonly commandId: string;
}

export interface StopBackgroundTaskRpcInput {
	readonly sessionId: string;
	readonly taskId: string;
}

export type GetModelsRpcInput = RpcScope & { readonly instanceId?: string };

export type GetAgentsRpcInput = RpcScope & { readonly instanceId?: string };

export type GetCommandsRpcInput = RpcScope & { readonly instanceId?: string };

export interface GetProjectsRpcInput {
	readonly projectSlug: string;
}

export interface SaveProjectRpcInput extends SaveProjectInput {
	readonly projectSlug?: string;
}

export interface RemoveProjectRpcInput {
	readonly projectSlug: string;
	readonly slug: string;
}

export interface InstanceMutationRpcInput {
	readonly projectSlug?: string;
	readonly instanceId: string;
}

export interface RenameInstanceRpcInput {
	readonly projectSlug?: string;
	readonly instanceId: string;
	readonly name: string;
}

export interface AddInstanceRpcInput {
	readonly projectSlug?: string;
	readonly name: string;
	readonly driver?: string;
	readonly managed?: boolean;
	readonly port?: number;
	readonly url?: string;
	readonly env?: Record<string, string>;
	readonly configDir?: string;
}

export interface UpdateInstanceRpcInput {
	readonly projectSlug?: string;
	readonly instanceId: string;
	readonly name?: string;
	readonly port?: number;
	readonly env?: Record<string, string>;
	readonly configDir?: string;
}

export interface ScanNowRpcInput {
	readonly projectSlug?: string;
}

export interface PtyInputRpcInput {
	readonly projectSlug: string;
	readonly ptyId: string;
	readonly data: string;
}

export type CreatePtyRpcInput = RpcScope & {
	readonly originId: string;
	readonly accountId?: string;
	readonly root?: string;
};

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
	readonly draftId?: string;
	readonly title?: string;
	/** Harness instance to bind the session to (preferred over providerId). */
	readonly instanceId?: string;
	readonly providerId?: string;
	readonly worktreePath?: string;
	readonly newWorktree?: boolean;
	readonly worktreeBase?: string;
	readonly permissionMode: SessionPermissionMode;
	/** The draft composer's displayed pick, including an untouched default. */
	readonly model?: {
		readonly modelId: string;
		readonly providerId: string;
		readonly variant?: string;
		readonly contextWindow?: string;
	};
}

export interface ViewSessionRpcInput {
	readonly sessionId: string;
	readonly originId: string;
}

export interface PreWarmSessionRpcInput {
	readonly sessionId: string;
}

export type PreWarmDraftRpcInput = Omit<
	CreateSessionRpcInput,
	"title" | "newWorktree" | "draftId"
> & { readonly draftId: string };

export type AttachProjectRpcInput = (
	| { readonly projectSlug?: string; readonly sessionId?: never }
	| { readonly sessionId: string; readonly projectSlug?: never }
) & { readonly originId: string };

export interface DeleteSessionRpcInput {
	readonly sessionId: string;
	readonly originId?: string;
	readonly removeWorktrees?: boolean;
}

export type ForkSessionRpcInput = RpcScope & {
	readonly originId: string;
	readonly messageId?: string;
};

export interface StartSideThreadRpcInput {
	readonly sessionId: string;
	readonly title: string;
	readonly inputId: string;
	readonly text: string;
	readonly images?: readonly string[];
	readonly originId?: string;
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

export type GetFileTreeRpcInput = RpcScope;

export type GetFileListRpcInput = RpcScope & {
	readonly root?: string;
	readonly path?: string;
};

export type GetFileContentRpcInput = RpcScope & {
	readonly root?: string;
	readonly path: string;
};

export interface GetToolDetailsRpcInput {
	readonly sessionId: string;
	readonly toolIds: readonly [ToolCallId, ...ToolCallId[]];
}

export type GetSkillContentRpcInput = RpcScope & { readonly name: string };

export interface GetSessionSkillsRpcInput {
	readonly sessionId: string;
}

export interface FindFoldersRpcInput {
	readonly projectSlug?: string;
	readonly query: string;
}

export interface SwitchAgentRpcInput {
	readonly sessionId: string;
	readonly agentId: string;
	readonly originId?: string;
}

export interface SwitchContextWindowRpcInput {
	readonly sessionId: string;
	readonly contextWindow: string;
	readonly originId?: string;
}

export interface SwitchModelRpcInput {
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

export interface SetHarnessDefaultRpcInput {
	readonly projectSlug: string;
	readonly harness: "claude" | "opencode";
	readonly providerId: string;
	readonly modelId: string;
	readonly effort?: string;
	readonly contextWindow: string;
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

export type ResolveClaudeSettingsRpcInput = RpcScope & {
	readonly instanceId: string;
};

export interface ReloadProviderSessionRpcInput {
	readonly sessionId: string;
	readonly commandId: string;
	readonly originId?: string;
}

export interface RenameSessionRpcInput {
	readonly sessionId: string;
	readonly title: string;
	readonly originId?: string;
}

export interface MarkSessionReadRpcInput {
	readonly sessionId: string;
	readonly originId?: string;
}

export interface MarkSessionSeenRpcInput extends MarkSessionReadRpcInput {
	readonly upTo: number;
}

export interface SetSessionSettledRpcInput {
	readonly sessionId: string;
	readonly settled: boolean;
	readonly originId?: string;
}

export interface SetSessionPinnedRpcInput {
	readonly sessionId: string;
	readonly pinned: boolean;
	readonly originId?: string;
}

export interface SetSessionAutoSettleRpcInput {
	readonly sessionId: string;
	readonly disabled: boolean;
	readonly originId?: string;
}

export interface SnoozeSessionRpcInput {
	readonly sessionId: string;
	readonly until: number | null;
	readonly originId?: string;
}

export interface UnsnoozeSessionRpcInput {
	readonly sessionId: string;
	readonly originId?: string;
}

export interface DismissCutOffRpcInput {
	readonly sessionId: string;
	readonly originId?: string;
}

export interface ContinueSessionRpcInput {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly expectedInstanceId: string;
	readonly at?: number;
	readonly originId?: string;
}

export interface CancelContinuationRpcInput {
	readonly sessionId: string;
	readonly originId?: string;
}

export interface PreviewContinuationRpcInput {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly originId?: string;
}

export interface QuotaForAccountsRpcInput {
	readonly projectSlug: string;
	readonly originId?: string;
}

export interface GetContinuationHandoffRpcInput
	extends PreviewContinuationRpcInput {
	readonly at: number;
}

export interface SwitchVariantRpcInput {
	readonly sessionId: string;
	readonly variant: string;
	readonly originId?: string;
}

export interface SwitchPermissionModeRpcInput {
	readonly sessionId: string;
	readonly mode: SessionPermissionMode;
	readonly originId?: string;
}

export interface ListDaemonSessionsRpcInput {
	readonly projectSlug: string;
	readonly limit?: number;
	readonly roots?: boolean;
	readonly search?: string;
	readonly cursor?: {
		readonly updatedAt: number;
		readonly id: string;
	};
	readonly scope?: string;
	readonly exclude?: string;
}

export interface LoadMoreHistoryRpcInput {
	readonly sessionId: string;
	readonly before?: string;
}

export interface RewindSessionRpcInput {
	readonly sessionId: string;
	readonly messageId: string;
}

export interface UndoRewindRpcInput {
	readonly sessionId: string;
}

export interface SyncInputDraftRpcInput {
	readonly sessionId: string;
	readonly text: string;
	readonly originId?: string;
}

export const LOG_LEVELS = RpcLogLevelSchema.literals;

export interface SetLogLevelRpcInput {
	readonly projectSlug?: string;
	readonly level: RpcLogLevel;
}

export interface SetTailscaleServeRpcInput {
	readonly enabled: boolean;
}

const callControl = <A, E>(
	projectSlug: string | undefined,
	call: (client: WsRpcClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, WsRpcClients> =>
	Effect.gen(function* () {
		const clients = yield* WsRpcClients;
		const { control } = yield* clients.forProject(
			projectSlug ?? getCurrentSlug() ?? "",
		);
		return yield* call(control);
	});

/** Use the runtime's shared control socket without binding a project. */
const callDaemon = <A, E>(
	call: (client: WsRpcClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, WsRpcClients> => callControl("", call);

export const getServerStatusRpc = () =>
	runTransportEffect(callDaemon((client) => client("GetStatus", {})));

export const restartServerRpc = () =>
	runTransportEffect(callDaemon((client) => client("RestartWithConfig", {})));

export const shutdownServerRpc = () =>
	runTransportEffect(callDaemon((client) => client("Shutdown", {})));

export async function setKeepAwakeRpc(input: {
	readonly enabled: boolean;
}): Promise<SetKeepAwakeResponse> {
	return await runTransportEffect(
		callDaemon((client) => client("SetKeepAwake", input)),
	);
}

export async function setKeepAwakeCommandRpc(input: {
	readonly command: string;
	readonly args?: readonly string[];
}): Promise<{ readonly ok: true }> {
	return await runTransportEffect(
		callDaemon((client) => client("SetKeepAwakeCommand", input)),
	);
}

export async function setPinRpc(input: {
	readonly pin: string | null;
	readonly currentPin?: string;
}): Promise<{ readonly ok: true }> {
	const result = await runTransportEffect(
		Effect.either(callDaemon((client) => client("SetPin", input))),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function listBranchesRpc(projectSlug: string) {
	return runTransportEffect(
		callControl(projectSlug, (client) =>
			client("ListBranches", { projectSlug }),
		),
	);
}

export async function resolveSessionModeRpc(projectSlug: string) {
	return runTransportEffect(
		callDaemon((client) => client("ResolveSessionMode", { projectSlug })),
	);
}

export async function setDefaultSessionModeRpc(input: {
	readonly projectSlug: string;
	readonly mode: SessionMode;
}) {
	return runTransportEffect(
		callControl(input.projectSlug, (client) =>
			client("SetDefaultSessionMode", input),
		),
	);
}

export async function inspectSessionWorktreesRpc(input: {
	readonly sessionId: string;
}) {
	return runTransportEffect(
		callControl(undefined, (client) =>
			client("InspectSessionWorktrees", input),
		),
	);
}

export async function moveSessionWorkspaceRpc(input: {
	readonly sessionId: string;
	readonly path: string;
}): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(
			callControl(undefined, (client) => client("MoveSessionWorkspace", input)),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function renameSessionBranchRpc(input: {
	readonly sessionId: string;
	readonly branchName: string;
}): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(
			callControl(undefined, (client) => client("RenameSessionBranch", input)),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function recreateSessionWorktreeRpc(input: {
	readonly sessionId: string;
}): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(
			callControl(undefined, (client) =>
				client("RecreateSessionWorktree", input),
			),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function continueSessionInMainFolderRpc(input: {
	readonly sessionId: string;
}): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(
			callControl(undefined, (client) =>
				client("ContinueSessionInMainFolder", input),
			),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function dismissWorkspaceHintRpc(input: {
	readonly sessionId: string;
	readonly path: string;
}): Promise<void> {
	const result = await runTransportEffect(
		Effect.either(
			callControl(undefined, (client) => client("DismissWorkspaceHint", input)),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

const callCancelSession = (input: CancelSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("CancelSession", input).pipe(Effect.asVoid),
	);

export async function stopBackgroundTaskRpc(
	input: StopBackgroundTaskRpcInput,
): Promise<void> {
	await runTransportEffect(
		callControl(undefined, (client) =>
			client("StopBackgroundTask", input).pipe(Effect.asVoid),
		),
	);
}

const callGetModels = (input: GetModelsRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetModels", input));

const callGetAgents = (input: GetAgentsRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetAgents", input));

const callGetCommands = (input: GetCommandsRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetCommands", input));

const callGetProjects = (input: GetProjectsRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetProjects", input));

const callSaveProject = (input: SaveProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client("SaveProject", input));

const callRemoveProject = (input: RemoveProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client("RemoveProject", input));

const callStartInstance = (input: InstanceMutationRpcInput) =>
	callDaemon((client) => client("StartInstance", input));

const callStopInstance = (input: InstanceMutationRpcInput) =>
	callDaemon((client) => client("StopInstance", input));

const callRemoveInstance = (input: InstanceMutationRpcInput) =>
	callDaemon((client) => client("RemoveInstance", input));

const callRenameInstance = (input: RenameInstanceRpcInput) =>
	callDaemon((client) => client("RenameInstance", input));

const callAddInstance = (input: AddInstanceRpcInput) =>
	callDaemon((client) => client("AddInstance", input));

const callUpdateInstance = (input: UpdateInstanceRpcInput) =>
	callDaemon((client) => client("UpdateInstance", input));

const callSetDefault = (input: { readonly instanceId: string }) =>
	callDaemon((client) => client("SetDefault", input));

const callScanNow = (input: ScanNowRpcInput) =>
	callDaemon((client) => client("ScanNow", input));

const callDetectProxy = () => callDaemon((client) => client("DetectProxy", {}));

const callPtyInput = (input: PtyInputRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("PtyInput", input).pipe(Effect.asVoid),
	);

const callCreatePty = (input: CreatePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("CreatePty", input).pipe(Effect.asVoid),
	);

const callResizePty = (input: ResizePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("ResizePty", {
			projectSlug: input.projectSlug,
			ptyId: input.ptyId,
			...(input.originId != null ? { originId: input.originId } : {}),
			...(input.cols != null ? { cols: input.cols } : {}),
			...(input.rows != null ? { rows: input.rows } : {}),
		}).pipe(Effect.asVoid),
	);

const callClosePty = (input: ClosePtyRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("ClosePty", input).pipe(Effect.asVoid),
	);

const callCreateSession = (input: CreateSessionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("CreateSession", {
			projectSlug: input.projectSlug,
			originId: input.originId,
			...(input.draftId != null ? { draftId: input.draftId } : {}),
			...(input.title != null ? { title: input.title } : {}),
			...(input.instanceId != null
				? { instanceId: AccountIdSchema.make(input.instanceId) }
				: {}),
			...(input.providerId != null ? { providerId: input.providerId } : {}),
			...(input.model != null ? { model: input.model } : {}),
			permissionMode: input.permissionMode,
			...(input.worktreePath != null
				? { worktreePath: input.worktreePath }
				: {}),
			...(input.newWorktree ? { newWorktree: true } : {}),
			...(input.worktreeBase != null
				? { worktreeBase: input.worktreeBase }
				: {}),
		}),
	);

const callViewSession = (input: ViewSessionRpcInput) =>
	callControl(undefined, (client) => client("ViewSession", input));

const callPreWarmSession = (input: PreWarmSessionRpcInput) =>
	callControl(undefined, (client) => client("PreWarmSession", input));

const callPreWarmDraft = (input: PreWarmDraftRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("PreWarmDraft", {
			projectSlug: input.projectSlug,
			originId: input.originId,
			draftId: input.draftId,
			...(input.instanceId != null
				? { instanceId: AccountIdSchema.make(input.instanceId) }
				: {}),
			...(input.providerId != null ? { providerId: input.providerId } : {}),
			...(input.model != null ? { model: input.model } : {}),
			permissionMode: input.permissionMode,
			...(input.worktreePath != null
				? { worktreePath: input.worktreePath }
				: {}),
			...(input.worktreeBase != null
				? { worktreeBase: input.worktreeBase }
				: {}),
		}),
	);

const callAttachProject = (input: AttachProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client("AttachProject", input));

const callDeleteSession = (input: DeleteSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("DeleteSession", {
			sessionId: input.sessionId,
			...(input.originId != null ? { originId: input.originId } : {}),
			...(input.removeWorktrees === undefined
				? {}
				: { removeWorktrees: input.removeWorktrees }),
		}),
	);

const callForkSession = (input: ForkSessionRpcInput) =>
	callControl(input.projectSlug, (client) => client("ForkSession", input));

const callStartSideThread = (input: StartSideThreadRpcInput) =>
	callControl(undefined, (client) => client("StartSideThread", input));

const callRespondPermission = (input: RespondPermissionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("RespondPermission", {
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
		}).pipe(Effect.asVoid),
	);

const callAnswerQuestion = (input: AnswerQuestionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("AnswerQuestion", {
			projectSlug: input.projectSlug,
			originId: input.originId,
			commandId: input.commandId,
			toolId: input.toolId,
			answers: { ...input.answers },
		}).pipe(Effect.asVoid),
	);

const callRejectQuestion = (input: RejectQuestionRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("RejectQuestion", {
			projectSlug: input.projectSlug,
			originId: input.originId,
			commandId: input.commandId,
			toolId: input.toolId,
		}).pipe(Effect.asVoid),
	);

const callGetFileTree = (input: GetFileTreeRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetFileTree", input));

const callGetFileList = (input: GetFileListRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetFileList", input));

const callGetFileContent = (input: GetFileContentRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetFileContent", input));

const callGetToolDetails = (input: GetToolDetailsRpcInput) =>
	callControl(undefined, (client) => client("GetToolDetails", input));

const callGetSkillContent = (input: GetSkillContentRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetSkillContent", input));

const callGetSessionSkills = (input: GetSessionSkillsRpcInput) =>
	callControl(undefined, (client) => client("GetSessionSkills", input));

const callFindFolders = (input: FindFoldersRpcInput) =>
	callControl(input.projectSlug, (client) => client("FindFolders", input));

const callSwitchAgent = (input: SwitchAgentRpcInput) =>
	callControl(undefined, (client) =>
		client("SwitchAgent", {
			sessionId: input.sessionId,
			agentId: input.agentId,
			...(input.originId ? { originId: input.originId } : {}),
		}).pipe(Effect.asVoid),
	);

const callSwitchContextWindow = (input: SwitchContextWindowRpcInput) =>
	callControl(undefined, (client) =>
		client("SwitchContextWindow", {
			sessionId: input.sessionId,
			contextWindow: input.contextWindow,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchModel = (input: SwitchModelRpcInput) =>
	callControl(undefined, (client) =>
		client("SwitchModel", {
			sessionId: input.sessionId,
			modelId: input.modelId,
			providerId: input.providerId,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetDefaultModel = (input: SetDefaultModelRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SetDefaultModel", {
			projectSlug: input.projectSlug,
			model: input.model,
			provider: input.provider,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetHarnessDefault = (input: SetHarnessDefaultRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SetHarnessDefault", input),
	);

const callSetDefaultPermissionMode = (
	input: SetDefaultPermissionModeRpcInput,
) =>
	callControl(input.projectSlug, (client) =>
		client("SetDefaultPermissionMode", {
			projectSlug: input.projectSlug,
			mode: input.mode,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetHiddenEntries = (input: SetHiddenEntriesRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SetHiddenEntries", {
			projectSlug: input.projectSlug,
			...(input.hiddenModels ? { hiddenModels: input.hiddenModels } : {}),
			...(input.hiddenAgents ? { hiddenAgents: input.hiddenAgents } : {}),
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callGetClaudeSettings = (input: GetClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("GetClaudeSettings", input),
	);

const callSetClaudeSettings = (input: SetClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SetClaudeSettings", {
			projectSlug: input.projectSlug,
			overrides: input.overrides,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callResolveClaudeSettings = (input: ResolveClaudeSettingsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("ResolveClaudeSettings", input),
	);

const callReloadProviderSession = (input: ReloadProviderSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("ReloadProviderSession", {
			sessionId: input.sessionId,
			commandId: input.commandId,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callRenameSession = (input: RenameSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("RenameSession", {
			sessionId: input.sessionId,
			title: input.title,
			...(input.originId ? { originId: input.originId } : {}),
		}).pipe(Effect.asVoid),
	);

const callSetSessionSettled = (input: SetSessionSettledRpcInput) =>
	callControl(undefined, (client) =>
		client("SetSessionSettled", input).pipe(Effect.asVoid),
	);

const callMarkSessionUnread = (input: MarkSessionReadRpcInput) =>
	callControl(undefined, (client) =>
		client("MarkSessionUnread", input).pipe(Effect.asVoid),
	);

const callMarkSessionRead = (input: MarkSessionReadRpcInput) =>
	callControl(undefined, (client) =>
		client("MarkSessionRead", input).pipe(Effect.asVoid),
	);

const callMarkSessionSeen = (input: MarkSessionSeenRpcInput) =>
	callControl(undefined, (client) =>
		client("MarkSessionSeen", input).pipe(Effect.asVoid),
	);

const callSetSessionPinned = (input: SetSessionPinnedRpcInput) =>
	callControl(undefined, (client) =>
		client("SetSessionPinned", input).pipe(Effect.asVoid),
	);

const callSetSessionAutoSettle = (input: SetSessionAutoSettleRpcInput) =>
	callControl(undefined, (client) =>
		client("SetSessionAutoSettle", input).pipe(Effect.asVoid),
	);

const callSnoozeSession = (input: SnoozeSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("SnoozeSession", input).pipe(Effect.asVoid),
	);

const callUnsnoozeSession = (input: UnsnoozeSessionRpcInput) =>
	callControl(undefined, (client) =>
		client("UnsnoozeSession", input).pipe(Effect.asVoid),
	);

const callSwitchVariant = (input: SwitchVariantRpcInput) =>
	callControl(undefined, (client) =>
		client("SwitchVariant", {
			sessionId: input.sessionId,
			variant: input.variant,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchPermissionMode = (input: SwitchPermissionModeRpcInput) =>
	callControl(undefined, (client) =>
		client("SwitchPermissionMode", {
			sessionId: input.sessionId,
			mode: input.mode,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callListDaemonSessions = (input: ListDaemonSessionsRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("ListDaemonSessions", input),
	);

const callLoadMoreHistory = (input: LoadMoreHistoryRpcInput) =>
	callControl(undefined, (client) => client("LoadMoreHistory", input));

const callRewindSession = (input: RewindSessionRpcInput) =>
	callControl(undefined, (client) => client("RewindSession", input));

const callUndoRewind = (input: UndoRewindRpcInput) =>
	callControl(undefined, (client) => client("UndoRewind", input));

const callSyncInputDraft = (input: SyncInputDraftRpcInput) =>
	callControl(undefined, (client) =>
		client("SyncInputDraft", {
			sessionId: input.sessionId,
			text: input.text,
			...(input.originId ? { originId: input.originId } : {}),
		}).pipe(Effect.asVoid),
	);

const callSetLogLevel = (input: SetLogLevelRpcInput) =>
	callDaemon((client) => client("SetLogLevel", input).pipe(Effect.asVoid));

const callSetTailscaleServe = (input: SetTailscaleServeRpcInput) =>
	callDaemon((client) =>
		client("SetTailscaleServe", input).pipe(Effect.asVoid),
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

export async function getGoalDetailsRpc(input: {
	readonly sessionId: string;
}): Promise<GoalDetails> {
	return await runTransportEffect(
		callControl(undefined, (client) => client("GetGoalDetails", input)),
	);
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

export async function saveProjectRpc(
	input: SaveProjectRpcInput,
): Promise<SaveProjectResponse> {
	const result = await runTransportEffect(
		Effect.either(callSaveProject(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function removeProjectRpc(
	input: RemoveProjectRpcInput,
): Promise<ProjectMutationResponse> {
	return await runTransportEffect(callRemoveProject(input));
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
	const result = await runTransportEffect(
		Effect.either(callRemoveInstance(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function renameInstanceRpc(
	input: RenameInstanceRpcInput,
): Promise<InstanceListResponse> {
	const result = await runTransportEffect(
		Effect.either(callRenameInstance(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function addInstanceRpc(
	input: AddInstanceRpcInput,
): Promise<InstanceListResponse> {
	const result = await runTransportEffect(
		Effect.either(callAddInstance(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function updateInstanceRpc(
	input: UpdateInstanceRpcInput,
): Promise<InstanceListResponse> {
	const result = await runTransportEffect(
		Effect.either(callUpdateInstance(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function setDefaultRpc(input: {
	readonly instanceId: string;
}): Promise<InstanceListResponse> {
	const result = await runTransportEffect(Effect.either(callSetDefault(input)));
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function scanNowRpc(
	input: ScanNowRpcInput = {},
): Promise<ScanNowResponse> {
	return await runTransportEffect(callScanNow(input));
}

export async function detectProxyRpc(): Promise<DetectProxyResponse> {
	return await runTransportEffect(callDetectProxy());
}

export async function ptyInputRpc(input: PtyInputRpcInput): Promise<void> {
	await runTransportEffect(callPtyInput(input));
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
	const result = await runTransportEffect(
		Effect.either(callCreateSession(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function viewSessionRpc(
	input: ViewSessionRpcInput,
): Promise<ViewSessionResponse> {
	return await runTransportEffect(callViewSession(input));
}

export async function preWarmSessionRpc(
	input: PreWarmSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callPreWarmSession(input));
}

export async function preWarmDraftRpc(
	input: PreWarmDraftRpcInput,
): Promise<void> {
	await runTransportEffect(callPreWarmDraft(input));
}

export function attachProjectRpc(input: AttachProjectRpcInput): Promise<{
	readonly projectSlug: string | null;
	readonly sessionSlug: string | null;
}> {
	return runTransportEffect(callAttachProject(input));
}

export async function deleteSessionRpc(input: DeleteSessionRpcInput) {
	return runTransportEffect(callDeleteSession(input));
}

export async function forkSessionRpc(
	input: ForkSessionRpcInput,
): Promise<ForkSessionResponse> {
	return await runTransportEffect(callForkSession(input));
}

export async function startSideThreadRpc(
	input: StartSideThreadRpcInput,
): Promise<{ readonly sessionId: string }> {
	const result = await runTransportEffect(
		Effect.either(callStartSideThread(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
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

export async function getToolDetailsRpc(
	input: GetToolDetailsRpcInput,
): Promise<GetToolDetailsResponse> {
	return await runTransportEffect(callGetToolDetails(input));
}

export async function getSkillContentRpc(
	input: GetSkillContentRpcInput,
): Promise<GetSkillContentResponse> {
	return await runTransportEffect(callGetSkillContent(input));
}

export async function getSessionSkillsRpc(
	input: GetSessionSkillsRpcInput,
): Promise<GetSessionSkillsResponse> {
	return await runTransportEffect(callGetSessionSkills(input));
}

export async function findFoldersRpc(
	input: FindFoldersRpcInput,
): Promise<FindFoldersResponse> {
	// Keep the typed failure so the dialog can show permission issues by the field.
	const result = await runTransportEffect(
		Effect.either(callFindFolders(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
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

export async function setHarnessDefaultRpc(
	input: SetHarnessDefaultRpcInput,
): Promise<SetHarnessDefaultResponse> {
	return await runTransportEffect(callSetHarnessDefault(input));
}

export async function setDefaultPermissionModeRpc(
	input: SetDefaultPermissionModeRpcInput,
): Promise<SetDefaultPermissionModeResponse> {
	return await runTransportEffect(callSetDefaultPermissionMode(input));
}

export async function getDefaultGroupingModeRpc(): Promise<GroupingMode> {
	const response = await runTransportEffect(
		callControl("", (client) => client("GetDefaultGroupingMode", {})),
	);
	return response.mode;
}

export async function setDefaultGroupingModeRpc(
	mode: GroupingMode,
): Promise<GroupingMode> {
	const response = await runTransportEffect(
		callControl("", (client) => client("SetDefaultGroupingMode", { mode })),
	);
	return response.mode;
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

export async function setSessionSettledRpc(
	input: SetSessionSettledRpcInput,
): Promise<void> {
	await runTransportEffect(callSetSessionSettled(input));
}

export async function markSessionUnreadRpc(
	input: MarkSessionReadRpcInput,
): Promise<void> {
	await runTransportEffect(callMarkSessionUnread(input));
}

export async function markSessionReadRpc(
	input: MarkSessionReadRpcInput,
): Promise<void> {
	await runTransportEffect(callMarkSessionRead(input));
}

/**
 * Resolves "disconnected" when the report never reached the server (socket
 * down or dropped mid-flight), so the caller can hold it for reconnect. A
 * server-side failure still rejects.
 */
export function markSessionSeenRpc(
	input: MarkSessionSeenRpcInput,
): Promise<"saved" | "disconnected"> {
	return runTransportEffect(
		callMarkSessionSeen(input).pipe(
			Effect.as("saved" as const),
			Effect.catchTag("RpcClientError", () =>
				Effect.succeed("disconnected" as const),
			),
		),
	);
}

export async function setSessionPinnedRpc(
	input: SetSessionPinnedRpcInput,
): Promise<void> {
	await runTransportEffect(callSetSessionPinned(input));
}

export async function setSessionAutoSettleRpc(
	input: SetSessionAutoSettleRpcInput,
): Promise<void> {
	await runTransportEffect(callSetSessionAutoSettle(input));
}

export async function getAutoSettleSettingRpc(): Promise<number | null> {
	const result = await runTransportEffect(
		callControl(undefined, (client) => client("GetAutoSettleSetting", {})),
	);
	return result.autoSettleAfterDays;
}

export async function getWorktreeCleanupSettingRpc(): Promise<WorktreeCleanup> {
	const result = await runTransportEffect(
		callControl(undefined, (client) => client("GetWorktreeCleanupSetting", {})),
	);
	return result.worktreeCleanup;
}

export async function setWorktreeCleanupSettingRpc(
	worktreeCleanup: WorktreeCleanup,
): Promise<WorktreeCleanup> {
	const result = await runTransportEffect(
		callControl(undefined, (client) =>
			client("SetWorktreeCleanupSetting", { worktreeCleanup }),
		),
	);
	return result.worktreeCleanup;
}

export async function cleanUpWorktreesNowRpc(
	projectSlug?: string,
): Promise<WorktreeCleanupReport> {
	return runTransportEffect(
		callControl(undefined, (client) =>
			client("CleanUpWorktreesNow", {
				...(projectSlug !== undefined && { projectSlug }),
			}),
		),
	);
}

export async function setAutoSettleSettingRpc(
	days: number | null,
): Promise<number | null> {
	const result = await runTransportEffect(
		callControl(undefined, (client) =>
			client("SetAutoSettleSetting", { autoSettleAfterDays: days }),
		),
	);
	return result.autoSettleAfterDays;
}

// Saves stay ordered across Settings tab mounts, and loads wait for their flush.
let usageLimitsSaves: Promise<void> = Promise.resolve();

export async function getUsageLimitsSettingRpc(): Promise<UsageLimitsSetting> {
	await usageLimitsSaves;
	const result = await runTransportEffect(
		callControl(undefined, (client) => client("GetUsageLimitsSetting", {})),
	);
	return result.usageLimits;
}

export async function setUsageLimitsSettingRpc(
	usageLimits: UsageLimitsSetting,
): Promise<UsageLimitsSetting> {
	const request = usageLimitsSaves.then(() =>
		runTransportEffect(
			callControl(undefined, (client) =>
				client("SetUsageLimitsSetting", { usageLimits }),
			),
		),
	);
	usageLimitsSaves = request.then(
		() => undefined,
		() => undefined,
	);
	const result = await request;
	return result.usageLimits;
}

export async function snoozeSessionRpc(
	input: SnoozeSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callSnoozeSession(input));
}

export async function unsnoozeSessionRpc(
	input: UnsnoozeSessionRpcInput,
): Promise<void> {
	await runTransportEffect(callUnsnoozeSession(input));
}

export async function dismissCutOffRpc(
	input: DismissCutOffRpcInput,
): Promise<void> {
	await runTransportEffect(
		callControl(undefined, (client) =>
			client("DismissCutOff", input).pipe(Effect.asVoid),
		),
	);
}

export async function continueSessionRpc(
	input: ContinueSessionRpcInput,
): Promise<void> {
	const result = await runTransportEffect(
		callControl(undefined, (client) =>
			client("ContinueSession", input).pipe(Effect.asVoid, Effect.either),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function cancelContinuationRpc(
	input: CancelContinuationRpcInput,
): Promise<void> {
	await runTransportEffect(
		callControl(undefined, (client) =>
			client("CancelContinuation", input).pipe(Effect.asVoid),
		),
	);
}

export async function previewContinuationRpc(
	input: PreviewContinuationRpcInput,
): Promise<PreviewContinuationResponse> {
	const result = await runTransportEffect(
		callControl(undefined, (client) =>
			client("PreviewContinuation", input).pipe(Effect.either),
		),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}

export async function quotaForAccountsRpc(
	input: QuotaForAccountsRpcInput,
): Promise<QuotaForAccountsResponse> {
	return await runTransportEffect(
		callControl(input.projectSlug, (client) =>
			client("QuotaForAccounts", input),
		),
	);
}

export async function getContinuationHandoffRpc(
	input: GetContinuationHandoffRpcInput,
): Promise<ContinuationHandoffResponse> {
	return await runTransportEffect(
		callControl(undefined, (client) => client("GetContinuationHandoff", input)),
	);
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

export interface ResolveSessionRpcInput {
	readonly sessionId: string;
}

export async function resolveSessionRpc(
	input: ResolveSessionRpcInput,
): Promise<{ readonly projectSlug: string | null }> {
	return await runTransportEffect(
		callControl(undefined, (client) => client("ResolveSession", input)),
	);
}

export async function listDaemonSessionsRpc(
	input: ListDaemonSessionsRpcInput,
): Promise<ListDaemonSessionsResponse> {
	return await runTransportEffect(callListDaemonSessions(input));
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

export async function undoRewindRpc(
	input: UndoRewindRpcInput,
): Promise<UndoRewindResponse> {
	return await runTransportEffect(callUndoRewind(input));
}

export interface InboxCommandRpcInput {
	readonly sessionId: string;
	readonly inputId: string;
}

/** Remove a queued input; rejected once it has started. */
export async function cancelInputRpc(
	input: InboxCommandRpcInput,
): Promise<InboxCommandResponse> {
	return await runTransportEffect(
		callControl(undefined, (client) => client("input.cancel", input)),
	);
}

/** Send a queued input now: a steer on a busy session (refused, it stays
 *  queued); on an idle session this resumes the queue. */
export async function sendInputNowRpc(
	input: InboxCommandRpcInput,
): Promise<InboxCommandResponse> {
	return await runTransportEffect(
		callControl(undefined, (client) => client("input.sendNow", input)),
	);
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

export async function setTailscaleServeRpc(
	input: SetTailscaleServeRpcInput,
): Promise<void> {
	await runTransportEffect(callSetTailscaleServe(input));
}
