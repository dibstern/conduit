import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/provider-turn-dispatch.js";
import { OpenCodeTerminalServiceTag } from "../../domain/relay/Services/terminal-service.js";
import { formatErrorDetail } from "../../errors.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const terminalsHandlers = {
	ListPtys: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			const ptys = yield* terminal.list();
			return {
				projectSlug: request.projectSlug,
				ptys,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ListPtys"))),
	CreatePty: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			const { workspaceRoot } = yield* resolveSessionRequestFolders(
				request.sessionId,
			);
			yield* terminal.create(request.originId, workspaceRoot);
			return { ok: true as const };
		}).pipe(
			Effect.mapError(
				(error) =>
					new WsRpcError({
						message: `Failed to create terminal: ${formatErrorDetail(error)}`,
					}),
			),
		),
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
	PtyInput: (request) =>
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			yield* terminal.sendInput(request.ptyId, request.data);
			return { ok: true as const };
		}).pipe(
			Effect.mapError(
				() =>
					new WsRpcError({
						message:
							"Terminal is unavailable; reconnect or create a new terminal",
					}),
			),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	"ListPtys" | "CreatePty" | "ResizePty" | "ClosePty" | "PtyInput"
>;
