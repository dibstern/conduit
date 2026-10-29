import { Effect, Stream } from "effect";
import {
	SessionDiffError,
	type SessionDiffScope,
} from "../../contracts/session-diff.js";
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

/** The session's folders as this request may read them; an unguarded one reads as missing. */
const sessionFolders = (sessionId: string) =>
	Effect.gen(function* () {
		const { effectiveFolders } = yield* resolveSessionRequestFolders(sessionId);
		const folders = yield* Effect.forEach(effectiveFolders, (folder) =>
			guardWorkspacePath(folder.directory).pipe(
				Effect.as(folder),
				Effect.orElseSucceed(() => ({ ...folder, present: false })),
			),
		);
		return { id: sessionId, folders };
	});

export const subscribeSessionDiff = (request: {
	readonly sessionId: string;
	readonly scope: SessionDiffScope;
}) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			const session = yield* sessionFolders(request.sessionId);
			return diff
				.changes(session, request.scope)
				.pipe(Stream.map((revision) => ({ revision })));
		}).pipe(Effect.catch(mapRpcFailure("SubscribeSessionDiff"))),
	);

export const sessionDiffHandlers = {
	SessionDiffList: (request) =>
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			return yield* diff.list(
				yield* sessionFolders(request.sessionId),
				request.scope,
				request.revision,
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
