import { Effect } from "effect";
import { type SetPinRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import type { WsRpcHandlerMap } from "./shared.js";

const daemonRequired = (operation: string) =>
	Effect.fail(new WsRpcError({ message: `${operation} requires daemon mode` }));

export const daemonOnlyHandlers = {
	GetMessageSurfacing: (_request) => daemonRequired("GetMessageSurfacing"),
	UpdateMessageSurfacing: (_request) =>
		daemonRequired("UpdateMessageSurfacing"),
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
	GetCursorAuth: (_request) => daemonRequired("GetCursorAuth"),
	StartCursorLogin: (_request) => daemonRequired("StartCursorLogin"),
	CancelCursorLogin: (_request) => daemonRequired("CancelCursorLogin"),
	LogoutCursor: (_request) => daemonRequired("LogoutCursor"),
	GetInstanceStatus: (_request) => daemonRequired("GetInstanceStatus"),
	OpenCodeUseWorktree: (_request) => daemonRequired("OpenCodeUseWorktree"),
	ResolveSessionMode: (_request) => daemonRequired("ResolveSessionMode"),
	SetDefaultGroupingMode: (_request) =>
		daemonRequired("SetDefaultGroupingMode"),
	GetDefaultGroupingMode: (_request) =>
		daemonRequired("GetDefaultGroupingMode"),
	SetTerminalKeys: (_request) => daemonRequired("SetTerminalKeys"),
	GetTerminalKeys: (_request) => daemonRequired("GetTerminalKeys"),
	GetCategorySet: (_request) => daemonRequired("GetCategorySet"),
	GetSurfacingFeedback: (_request) => daemonRequired("GetSurfacingFeedback"),
	ReplaceCategorySet: (_request) => daemonRequired("ReplaceCategorySet"),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetMessageSurfacing"
	| "UpdateMessageSurfacing"
	| "GetStatus"
	| "SetPin"
	| "SetKeepAwake"
	| "SetKeepAwakeCommand"
	| "SetTailscaleServe"
	| "Shutdown"
	| "SetAgent"
	| "RestartWithConfig"
	| "GetInstances"
	| "GetCursorAuth"
	| "StartCursorLogin"
	| "CancelCursorLogin"
	| "LogoutCursor"
	| "GetInstanceStatus"
	| "OpenCodeUseWorktree"
	| "ResolveSessionMode"
	| "SetDefaultGroupingMode"
	| "GetDefaultGroupingMode"
	| "SetTerminalKeys"
	| "GetTerminalKeys"
	| "GetCategorySet"
	| "GetSurfacingFeedback"
	| "ReplaceCategorySet"
>;
