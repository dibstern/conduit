import { Effect } from "effect";
import { type SetPinRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import type { WsRpcHandlerMap } from "./shared.js";

const daemonRequired = (operation: string) =>
	Effect.fail(new WsRpcError({ message: `${operation} requires daemon mode` }));

export const daemonOnlyHandlers = {
	GetStatus: (_request) => daemonRequired("GetStatus"),
	SetPin: (_request): Effect.Effect<never, WsRpcError | SetPinRejected> =>
		daemonRequired("SetPin"),
	SetKeepAwake: (_request) => daemonRequired("SetKeepAwake"),
	SetKeepAwakeCommand: (_request) => daemonRequired("SetKeepAwakeCommand"),
	SetTailscaleServe: (_request) => daemonRequired("SetTailscaleServe"),
	Shutdown: (_request) => daemonRequired("Shutdown"),
	SetAgent: (_request) => daemonRequired("SetAgent"),
	RestartWithConfig: (_request) => daemonRequired("RestartWithConfig"),
	GetInstances: (_request) => daemonRequired("GetInstances"),
	GetInstanceStatus: (_request) => daemonRequired("GetInstanceStatus"),
	OpenCodeUseWorktree: (_request) => daemonRequired("OpenCodeUseWorktree"),
	ResolveSessionMode: (_request) => daemonRequired("ResolveSessionMode"),
	SetDefaultGroupingMode: (_request) =>
		daemonRequired("SetDefaultGroupingMode"),
	GetDefaultGroupingMode: (_request) =>
		daemonRequired("GetDefaultGroupingMode"),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetStatus"
	| "SetPin"
	| "SetKeepAwake"
	| "SetKeepAwakeCommand"
	| "SetTailscaleServe"
	| "Shutdown"
	| "SetAgent"
	| "RestartWithConfig"
	| "GetInstances"
	| "GetInstanceStatus"
	| "OpenCodeUseWorktree"
	| "ResolveSessionMode"
	| "SetDefaultGroupingMode"
	| "GetDefaultGroupingMode"
>;
