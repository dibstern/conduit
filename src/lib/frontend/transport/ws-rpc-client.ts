import type { Rpc, RpcGroup } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Effect, Either, HashSet } from "effect";
import type { SaveProjectInput, WsRpcGroup } from "../../contracts/ws-rpc.js";
import { getCurrentSlug } from "../stores/router.svelte.js";
import { runTransportEffect } from "./runtime.js";
import { type WsRpcClient, WsRpcClients } from "./shared-client.js";

export type { GoalDetails } from "../../contracts/ws-rpc.js";
// Keep the public URL helper available to existing callers.
export { makeWsRpcUrl, type WsRpcLocation } from "./shared-client.js";

import type {
	DetectProxyResponse,
	GetProjectsResponse,
	InstanceListResponse,
	ProjectMutationResponse,
	SaveProjectResponse,
	ScanNowResponse,
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

export type AttachProjectRpcInput = (
	| { readonly projectSlug?: string; readonly sessionId?: never }
	| { readonly sessionId: string; readonly projectSlug?: never }
) & { readonly originId: string };

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

export async function attachProjectRpc(input: AttachProjectRpcInput): Promise<{
	readonly projectSlug: string | null;
	readonly sessionSlug: string | null;
}> {
	// Reject with the WsRpcError itself so callers can read its code.
	const result = await runTransportEffect(
		Effect.either(callAttachProject(input)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}
