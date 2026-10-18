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
	GetCategorySet: (_request) => daemonRequired("GetCategorySet"),
	GetSurfacingFeedback: (_request) => daemonRequired("GetSurfacingFeedback"),
	GetSurfacingLedger: (_request) => daemonRequired("GetSurfacingLedger"),
	ScoreCategorySet: (_request) => daemonRequired("ScoreCategorySet"),
	ProposeCategoryTuning: (_request) => daemonRequired("ProposeCategoryTuning"),
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
	| "GetCategorySet"
	| "GetSurfacingFeedback"
	| "GetSurfacingLedger"
	| "ScoreCategorySet"
	| "ProposeCategoryTuning"
	| "ReplaceCategorySet"
>;
