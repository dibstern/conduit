import { Effect } from "effect";
import { SessionDiffError } from "../../contracts/session-diff.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { SessionDiff } from "../../domain/daemon/Services/session-diff.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/session-workspace.js";
import { guardWorkspacePath } from "../../session/workspace-directories.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const sessionDiff = Effect.serviceOption(SessionDiff).pipe(
	Effect.flatMap((service) =>
		service._tag === "Some"
			? Effect.succeed(service.value)
			: Effect.fail(
					new WsRpcError({ message: "Session diffs are unavailable" }),
				),
	),
);

export const sessionDiffHandlers = {
	SessionDiffList: (request) =>
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			const { effectiveFolders } = yield* resolveSessionRequestFolders(
				request.sessionId,
			);
			const folders = yield* Effect.forEach(effectiveFolders, (folder) =>
				guardWorkspacePath(folder.directory).pipe(
					Effect.as(folder),
					Effect.orElseSucceed(() => ({ ...folder, present: false })),
				),
			);
			return yield* diff.list(
				{ id: request.sessionId, folders },
				request.scope,
			);
		}).pipe(Effect.catch(mapRpcFailure("SessionDiffList"))),
	SessionDiffFile: (request) =>
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			return yield* diff.file(request);
		}).pipe(
			Effect.catch(
				(error): Effect.Effect<never, SessionDiffError | WsRpcError> =>
					error instanceof SessionDiffError
						? Effect.fail(error)
						: mapRpcFailure("SessionDiffFile")(error),
			),
		),
} satisfies Pick<WsRpcHandlerMap, "SessionDiffList" | "SessionDiffFile">;
