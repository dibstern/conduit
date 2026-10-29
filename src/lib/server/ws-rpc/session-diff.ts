import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SessionDiffError } from "../../contracts/session-diff.js";
import { RunChangesCapturedSchema } from "../../contracts/stored-event.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { FolderTimeline } from "../../domain/daemon/Services/folder-timeline.js";
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

/** The turn's recorded run capture, once its run-end checkpoint has settled. */
const turnCapture = (sessionId: string, turnId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [turn] = yield* sql<{
			run_id: string | null;
		}>`SELECT run_id FROM turns
			WHERE session_id = ${sessionId} AND (id = ${turnId} OR user_message_id = ${turnId})`;
		const runId = turn?.run_id;
		if (!runId) return undefined;
		const timeline = yield* Effect.serviceOption(FolderTimeline);
		if (Option.isSome(timeline)) yield* timeline.value.settled(runId);
		const [row] = yield* sql<{ data: string }>`SELECT data FROM events
			WHERE session_id = ${sessionId} AND type = 'run.changes_captured'
			AND json_extract(data, '$.runId') = ${runId} LIMIT 1`;
		return row
			? yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(RunChangesCapturedSchema),
				)(row.data)
			: undefined;
	});

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
			const capture =
				request.scope.kind === "turn"
					? yield* turnCapture(request.sessionId, request.scope.turnId)
					: undefined;
			return yield* diff.list(
				{ id: request.sessionId, folders, ...(capture ? { capture } : {}) },
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
