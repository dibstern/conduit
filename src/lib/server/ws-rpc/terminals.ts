import { Effect } from "effect";
import { OpenCodeTerminalServiceTag } from "../../domain/relay/Services/terminal-service.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const terminalsHandlers = {
	ListPtys: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			const ptys = yield* terminal.list(request.originId);
			return {
				projectSlug: request.projectSlug,
				ptys,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ListPtys"))),
	CreatePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.create(request.originId);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("CreatePty"))),
	ResizePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.resize(
				request.originId ?? "rpc",
				request.ptyId,
				request.rows ?? 24,
				request.cols ?? 80,
			);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("ResizePty"))),
	ClosePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.close(request.ptyId);
			return { ok: true as const };
		}).pipe(Effect.catchAll(mapRpcFailure("ClosePty"))),
} satisfies Pick<
	WsRpcHandlerMap,
	"ListPtys" | "CreatePty" | "ResizePty" | "ClosePty"
>;
