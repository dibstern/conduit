import type { Rpc, RpcGroup } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Effect, Either, HashSet } from "effect";
import type { ClaudeSettingsOverrides } from "../../contracts/claude-settings.js";
import type { UsageLimitsSetting } from "../../contracts/limit-recovery.js";
import type { SessionMode } from "../../contracts/project-file.js";
import type { WorktreeCleanup } from "../../contracts/worktree.js";
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
	DetectProxyResponse,
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	GetProjectsResponse,
	InstanceListResponse,
	PreviewContinuationResponse,
	ProjectMutationResponse,
	QuotaForAccountsResponse,
	ResolveClaudeSettingsResponse,
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
} from "./ws-rpc.js";

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
	readonly instanceId?: string;
}

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

export interface CreatePtyRpcInput {
	readonly projectSlug: string;
	readonly originId: string;
	readonly sessionId?: string;
	readonly accountId?: string;
	readonly root?: string;
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

export interface AttachProjectRpcInput {
	readonly projectSlug?: string;
	readonly sessionId?: string;
	readonly originId: string;
}

export interface GetSkillContentRpcInput {
	readonly projectSlug: string;
	readonly name: string;
	readonly sessionId?: string;
}

export interface GetSessionSkillsRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
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

export interface ResolveClaudeSettingsRpcInput {
	readonly projectSlug: string;
	readonly instanceId: string;
	readonly sessionId?: string;
}

export interface ContinueSessionRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly instanceId: string;
	readonly expectedInstanceId: string;
	readonly at?: number;
	readonly originId?: string;
}

export interface CancelContinuationRpcInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly originId?: string;
}

export interface PreviewContinuationRpcInput {
	readonly projectSlug: string;
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

const callAttachProject = (input: AttachProjectRpcInput) =>
	callControl(input.projectSlug, (client) => client("AttachProject", input));

const callGetSkillContent = (input: GetSkillContentRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetSkillContent", input));

const callGetSessionSkills = (input: GetSessionSkillsRpcInput) =>
	callControl(input.projectSlug, (client) => client("GetSessionSkills", input));

const callSwitchAgent = (input: SwitchAgentRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SwitchAgent", {
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			agentId: input.agentId,
			...(input.originId ? { originId: input.originId } : {}),
		}).pipe(Effect.asVoid),
	);

const callSwitchContextWindow = (input: SwitchContextWindowRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SwitchContextWindow", {
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			contextWindow: input.contextWindow,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchModel = (input: SwitchModelRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SwitchModel", {
			projectSlug: input.projectSlug,
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

const callSwitchVariant = (input: SwitchVariantRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SwitchVariant", {
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			variant: input.variant,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSwitchPermissionMode = (input: SwitchPermissionModeRpcInput) =>
	callControl(input.projectSlug, (client) =>
		client("SwitchPermissionMode", {
			projectSlug: input.projectSlug,
			sessionId: input.sessionId,
			mode: input.mode,
			...(input.originId ? { originId: input.originId } : {}),
		}),
	);

const callSetLogLevel = (input: SetLogLevelRpcInput) =>
	callDaemon((client) => client("SetLogLevel", input).pipe(Effect.asVoid));

const callSetTailscaleServe = (input: SetTailscaleServeRpcInput) =>
	callDaemon((client) =>
		client("SetTailscaleServe", input).pipe(Effect.asVoid),
	);

export async function getModelsRpc(
	input: GetModelsRpcInput,
): Promise<GetModelsResponse> {
	return await runTransportEffect(callGetModels(input));
}

export async function getGoalDetailsRpc(input: {
	readonly projectSlug: string;
	readonly sessionId: string;
}): Promise<GoalDetails> {
	return await runTransportEffect(
		callControl(input.projectSlug, (client) => client("GetGoalDetails", input)),
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

export function attachProjectRpc(input: AttachProjectRpcInput): Promise<{
	readonly projectSlug: string | null;
	readonly sessionSlug: string | null;
}> {
	return runTransportEffect(callAttachProject(input));
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

export async function continueSessionRpc(
	input: ContinueSessionRpcInput,
): Promise<void> {
	const result = await runTransportEffect(
		callControl(input.projectSlug, (client) =>
			client("ContinueSession", input).pipe(Effect.asVoid, Effect.either),
		),
	);
	if (Either.isLeft(result)) throw result.left;
}

export async function cancelContinuationRpc(
	input: CancelContinuationRpcInput,
): Promise<void> {
	await runTransportEffect(
		callControl(input.projectSlug, (client) =>
			client("CancelContinuation", input).pipe(Effect.asVoid),
		),
	);
}

export async function previewContinuationRpc(
	input: PreviewContinuationRpcInput,
): Promise<PreviewContinuationResponse> {
	const result = await runTransportEffect(
		callControl(input.projectSlug, (client) =>
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
		callControl(input.projectSlug, (client) =>
			client("GetContinuationHandoff", input),
		),
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
