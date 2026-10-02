import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import type { WsRpcHandlerMap } from "./shared.js";

const daemonRequired = (operation: string) =>
	Effect.fail(new WsRpcError({ message: `${operation} requires daemon mode` }));

export const daemonOnlyHandlers = {
	GetStatus: (_request) => daemonRequired("GetStatus"),
	SetPin: (_request) => daemonRequired("SetPin"),
	SetKeepAwake: (_request) => daemonRequired("SetKeepAwake"),
	SetKeepAwakeCommand: (_request) => daemonRequired("SetKeepAwakeCommand"),
	Shutdown: (_request) => daemonRequired("Shutdown"),
	SetAgent: (_request) => daemonRequired("SetAgent"),
	RestartWithConfig: (_request) => daemonRequired("RestartWithConfig"),
	GetInstances: (_request) => daemonRequired("GetInstances"),
	GetInstanceStatus: (_request) => daemonRequired("GetInstanceStatus"),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetStatus"
	| "SetPin"
	| "SetKeepAwake"
	| "SetKeepAwakeCommand"
	| "Shutdown"
	| "SetAgent"
	| "RestartWithConfig"
	| "GetInstances"
	| "GetInstanceStatus"
>;
