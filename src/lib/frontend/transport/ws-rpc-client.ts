import type { Rpc, RpcGroup } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Effect, Either, HashSet } from "effect";
import type { ClaudeSettingsOverrides } from "../../contracts/claude-settings.js";
import type { UsageLimitsSetting } from "../../contracts/limit-recovery.js";
import type { WorktreeCleanup } from "../../contracts/worktree.js";
import {
	RpcLogLevelSchema,
	type SetKeepAwakeResponse,
	type WsRpcGroup,
} from "../../contracts/ws-rpc.js";
import type { GroupingMode } from "../../shared-types.js";
import { getCurrentSlug } from "../stores/router.svelte.js";
import { runTransportEffect } from "./runtime.js";
import { type WsRpcClient, WsRpcClients } from "./shared-client.js";

export type { GoalDetails } from "../../contracts/ws-rpc.js";
export { SetPinRejected } from "../../contracts/ws-rpc.js";
// Keep the public URL helper available to existing callers.
export { makeWsRpcUrl, type WsRpcLocation } from "./shared-client.js";

import type {
	ClaudeSettingsResponse,
	ResolveClaudeSettingsResponse,
	RpcLogLevel,
	SetHiddenEntriesResponse,
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

const callSetLogLevel = (input: SetLogLevelRpcInput) =>
	callDaemon((client) => client("SetLogLevel", input).pipe(Effect.asVoid));

const callSetTailscaleServe = (input: SetTailscaleServeRpcInput) =>
	callDaemon((client) =>
		client("SetTailscaleServe", input).pipe(Effect.asVoid),
	);

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
