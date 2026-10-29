import { type Context, Effect, Option, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import {
	type SessionDiffEdit,
	SessionDiffEditError,
	SessionDiffError,
	type SessionDiffScope,
} from "../../contracts/session-diff.js";
import { RunChangesCapturedSchema } from "../../contracts/stored-event.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { FolderTimeline } from "../../domain/daemon/Services/folder-timeline.js";
import { SessionDiff } from "../../domain/daemon/Services/session-diff.js";
import { WorkingTreeEdits } from "../../domain/daemon/Services/working-tree-edits.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/session-workspace.js";
import { readSessionWorktreeOwnership } from "../../domain/relay/Services/session-worktree-deletion.js";
import { recordedOwnershipForFolder } from "../../persistence/effect/session-worktree-ownership.js";
import { guardWorkspacePath } from "../../session/workspace-directories.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const available = <I, S>(tag: Context.Key<I, S>) =>
	Effect.serviceOption(tag).pipe(
		Effect.flatMap((service) =>
			service._tag === "Some"
				? Effect.succeed(service.value)
				: Effect.fail(
						new WsRpcError({ message: "Session diffs are unavailable" }),
					),
		),
	);
const sessionDiff = available(SessionDiff);

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

/** The session's folders as this request may read them; an unguarded one reads as missing.
 *  A branch scope also carries each folder's launch base, and a turn scope its run's capture. */
const sessionFolders = (sessionId: string, scope: SessionDiffScope) =>
	Effect.gen(function* () {
		const { effectiveFolders } = yield* resolveSessionRequestFolders(sessionId);
		// Unreadable ownership only drops the launch base: the default branch stands in.
		const owned =
			scope.kind === "branch"
				? yield* readSessionWorktreeOwnership(sessionId, false).pipe(
						Effect.orElseSucceed(() => []),
					)
				: [];
		const folders = yield* Effect.forEach(effectiveFolders, (folder) => {
			const launchBase = recordedOwnershipForFolder(
				owned,
				folder.root,
				folder.directory,
			)?.head;
			const listed =
				launchBase === undefined ? folder : { ...folder, launchBase };
			return guardWorkspacePath(folder.directory).pipe(
				Effect.as(listed),
				Effect.orElseSucceed(() => ({ ...listed, present: false })),
			);
		});
		const capture =
			scope.kind === "turn"
				? yield* turnCapture(sessionId, scope.turnId)
				: undefined;
		return { id: sessionId, folders, ...(capture ? { capture } : {}) };
	});

export const subscribeSessionDiff = (request: {
	readonly sessionId: string;
	readonly scope: SessionDiffScope;
}) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			const session = yield* sessionFolders(request.sessionId, request.scope);
			return diff
				.changes(session, request.scope)
				.pipe(Stream.map((revision) => ({ revision })));
		}).pipe(Effect.catch(mapRpcFailure("SubscribeSessionDiff"))),
	);

/** An edit of the unstaged scope, against the session's folders as the server resolves them. */
const edit = (
	action: "discard" | "stage",
	{ sessionId, ...request }: SessionDiffEdit,
) =>
	Effect.gen(function* () {
		const edits = yield* available(WorkingTreeEdits);
		yield* edits[action]({
			...request,
			session: yield* sessionFolders(sessionId, { kind: "unstaged" }),
		});
		return { ok: true as const };
	}).pipe(
		Effect.catch(
			(error): Effect.Effect<never, SessionDiffEditError | WsRpcError> =>
				error instanceof SessionDiffEditError
					? Effect.fail(error)
					: mapRpcFailure(
							action === "discard" ? "SessionDiffDiscard" : "SessionDiffStage",
						)(error),
		),
	);

export const sessionDiffHandlers = {
	SessionDiffList: (request) =>
		Effect.gen(function* () {
			const diff = yield* sessionDiff;
			return yield* diff.list(
				yield* sessionFolders(request.sessionId, request.scope),
				request.scope,
				request.revision,
			);
		}).pipe(Effect.catch(mapRpcFailure("SessionDiffList"))),
	SessionDiffDiscard: (request) => edit("discard", request),
	SessionDiffStage: (request) => edit("stage", request),
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
} satisfies Pick<
	WsRpcHandlerMap,
	| "SessionDiffList"
	| "SessionDiffFile"
	| "SessionDiffDiscard"
	| "SessionDiffStage"
>;
