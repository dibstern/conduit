import { Effect, Option } from "effect";
import type { Account } from "../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { OpenCodeTerminalServiceTag } from "../../domain/relay/Services/terminal-service.js";
import { formatErrorDetail } from "../../errors.js";
import {
	mapRpcFailure,
	resolveSessionRequestDirectory,
	type WsRpcHandlerMap,
} from "./shared.js";

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
			const directory = yield* resolveSessionRequestDirectory(
				request,
				"terminal",
			);
			const accounts = yield* AccountDirectory;
			const selected =
				request.accountId === undefined
					? Option.none<Account>()
					: yield* Effect.option(
							accounts.resolve({ _tag: "Id", id: request.accountId }),
						);
			const account =
				Option.isSome(selected) &&
				PROVIDER_DRIVERS[selected.value.driver].accountKind ===
					"config-directory"
					? selected
					: yield* accounts.defaultFor("claude");
			yield* terminal.create(
				request.originId,
				directory,
				Option.getOrUndefined(account),
			);
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
