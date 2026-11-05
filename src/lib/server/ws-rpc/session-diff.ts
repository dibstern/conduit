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
import {
	FolderTimeline,
	headMoveFiles,
	isPruned,
} from "../../domain/daemon/Services/folder-timeline.js";
import {
	SessionDiff,
	type SessionDiffSession,
} from "../../domain/daemon/Services/session-diff.js";
import { WorkingTreeEdits } from "../../domain/daemon/Services/working-tree-edits.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/session-workspace.js";
import { readSessionWorktreeOwnership } from "../../domain/relay/Services/session-worktree-deletion.js";
import { recordedOwnershipForFolder } from "../../persistence/effect/session-worktree-ownership.js";
import { toolFileChanges } from "../../persistence/tool-wire-projection.js";
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

/** A turn's list waits this long for a capture still recording before it answers pending. */
const SETTLE_WAIT_MS = 5_000;

/** The turn's recorded run capture, once its run-end checkpoint has settled, and whether it was
 *  pruned; or, while the capture still records past the wait, its run as pending. */
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
		if (Option.isSome(timeline)) {
			const settled = yield* timeline.value
				.settled(runId)
				.pipe(Effect.timeoutOption(SETTLE_WAIT_MS));
			if (Option.isNone(settled)) return { pending: runId };
		}
		const [row] = yield* sql<{
			data: string;
			sequence: number;
		}>`SELECT data, sequence FROM events
			WHERE session_id = ${sessionId} AND type = 'run.changes_captured'
			AND json_extract(data, '$.runId') = ${runId} LIMIT 1`;
		if (!row) return undefined;
		const capture = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(RunChangesCapturedSchema),
		)(row.data);
		return (yield* isPruned(sessionId, row.sequence))
			? { capture, pruned: true as const }
			: { capture };
	});

const parseJson = (text: string | null): unknown => {
	try {
		return text === null ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * A tool call's Tool File Changes, recorded by its provider or else read from
 * its input, and the turn it ran in. Undefined for an unknown tool.
 */
const toolCallChanges = (sessionId: string, toolId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [part] = yield* sql<{
			input: string | null;
			status: string | null;
			metadata: string | null;
			turn_id: string | null;
		}>`SELECT mp.input, mp.status, mp.metadata, m.turn_id FROM message_parts mp
			JOIN messages m ON m.id = mp.message_id
			WHERE (mp.call_id = ${toolId} OR (mp.call_id IS NULL AND mp.id = ${toolId}))
			AND mp.type = 'tool' AND m.session_id = ${sessionId} LIMIT 1`;
		if (!part) return undefined;
		const metadata = parseJson(part.metadata);
		const recorded = toolFileChanges(
			part.status,
			undefined,
			typeof metadata === "object" &&
				metadata !== null &&
				"fileChanges" in metadata
				? metadata.fileChanges
				: undefined,
		);
		const changes =
			recorded ??
			toolFileChanges(part.status, parseJson(part.input), undefined);
		if (!changes) return undefined;
		return {
			source: recorded ? ("provider" as const) : ("toolInput" as const),
			changes,
			/** The turn whose capture checks a claimed new file, when one is claimed. */
			addedIn: changes.some(({ kind }) => kind === "add") ? part.turn_id : null,
		};
	});

/** A turn scope's capture, or a tool call's changes with its turn's capture when one claims a new file. */
const scopeRecords = (sessionId: string, scope: SessionDiffScope) =>
	Effect.gen(function* () {
		const toolCall =
			scope.kind === "toolCall"
				? yield* toolCallChanges(sessionId, scope.toolId)
				: undefined;
		const turnId = scope.kind === "turn" ? scope.turnId : toolCall?.addedIn;
		const captured:
			| Pick<SessionDiffSession, "capture" | "pruned" | "pending">
			| undefined = turnId ? yield* turnCapture(sessionId, turnId) : undefined;
		return {
			...captured,
			...(toolCall ? { toolCall } : {}),
		};
	});

/** The session's folders as this request may read them; an unguarded one reads as missing.
 *  A branch scope also carries each folder's launch base, a turn scope its run's capture,
 *  and a tool-call scope its changes, with its turn's capture when one claims a new file. */
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
		return {
			id: sessionId,
			folders,
			...(yield* scopeRecords(sessionId, scope)),
		};
	});

/** A scope's revisions as it resolves now, and the run whose capture it still waits on. */
const scopeFeed = (request: {
	readonly sessionId: string;
	readonly scope: SessionDiffScope;
}) =>
	Effect.gen(function* () {
		const diff = yield* sessionDiff;
		const session = yield* sessionFolders(request.sessionId, request.scope);
		return {
			pending: session.pending,
			feed: diff
				.changes(session, request.scope)
				.pipe(Stream.map((revision) => ({ revision }))),
		};
	}).pipe(Effect.catch(mapRpcFailure("SubscribeSessionDiff")));

export const subscribeSessionDiff = (request: {
	readonly sessionId: string;
	readonly scope: SessionDiffScope;
}) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const { pending, feed } = yield* scopeFeed(request);
			const timeline = yield* Effect.serviceOption(FolderTimeline);
			if (pending === undefined || Option.isNone(timeline)) return feed;
			// Once the capture lands or is abandoned the timeline no longer holds
			// the run, so the scope resolves settled and follows that listing.
			return feed.pipe(
				Stream.interruptWhen(timeline.value.settled(pending)),
				Stream.concat(
					Stream.unwrap(
						scopeFeed(request).pipe(Effect.map(({ feed }) => feed)),
					),
				),
			);
		}),
	);

/** An edit of the unstaged scope, against the session's folders as the server resolves them. */
const edit = (
	action: "discard" | "stage",
	{ sessionId, _tag, ...request }: SessionDiffEdit & { readonly _tag: string },
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
	GetHeadMoveFiles: (request) =>
		headMoveFiles(request.sessionId, request.messageId).pipe(
			Effect.map((files) => ({ files })),
			Effect.catch(mapRpcFailure("GetHeadMoveFiles")),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetHeadMoveFiles"
	| "SessionDiffList"
	| "SessionDiffFile"
	| "SessionDiffDiscard"
	| "SessionDiffStage"
>;
