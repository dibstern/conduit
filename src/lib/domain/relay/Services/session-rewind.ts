import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import {
	FilesRefused,
	SessionBusy,
} from "../../../contracts/limit-recovery.js";
import type { InputRequest } from "../../../contracts/stored-event.js";
import type { HeadLogEntry, MoveIntent } from "../../../contracts/ws-rpc.js";
import { readResumePlan } from "../../../persistence/effect/head-realignment.js";
import {
	pathToRoot,
	readHead,
} from "../../../persistence/effect/history-graph.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { EventPayloadMap } from "../../../persistence/events.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { headMoveFiles } from "../../daemon/Services/folder-timeline.js";
import { planFiles, restoreFiles } from "./head-move-files.js";
import { InputDraftsTag } from "./input-drafts.js";
import { LoggerTag } from "./services.js";
import { admitOrRefuse, startHeadMove } from "./session-command.js";
import { SessionInboxTag } from "./session-inbox.js";

/**
 * RewindSession (82tn.51): a rewind is a head move that lands at once, proposed and confirmed in
 * one call. A cut inside a Run goes back before the Run and returns its typed text to the composer.
 */
export const rewindSessionToMessage = ({
	clientId,
	sessionId,
	messageId,
}: {
	clientId: string;
	sessionId: string;
	messageId: string;
}) =>
	Effect.gen(function* () {
		const intent = { _tag: "rewind" as const, messageId };
		const { moveId } = yield* previewHeadMove(sessionId, intent);
		yield* commitHeadMove({ sessionId, intent, moveId });
		const log = yield* LoggerTag;
		log.info(
			`client=${clientId} session=${sessionId} Rewound to message: ${messageId}`,
		);
	});

/** UndoRewind (82tn.51): undoes the Head Log's newest entry, as a new entry. */
export const undoSessionRewind = ({
	clientId,
	sessionId,
}: {
	clientId: string;
	sessionId: string;
}) =>
	Effect.gen(function* () {
		const [newest] = yield* readHeadLog(sessionId);
		if (!newest) {
			// A busy session says so first, as the undo it replaces did.
			yield* admitOrRefuse(sessionId, { kind: "head_move" });
			return yield* noTarget(sessionId);
		}
		const intent = { _tag: "undo" as const, moveId: newest.moveId };
		const { moveId } = yield* previewHeadMove(sessionId, intent);
		yield* commitHeadMove({ sessionId, intent, moveId });
		const log = yield* LoggerTag;
		log.info(`client=${clientId} session=${sessionId} Undid ${newest.moveId}`);
	});

const noTarget = (sessionId: string) =>
	new SessionBusy({
		sessionId,
		command: "head_move",
		reason: "history_unavailable",
	});

/**
 * What an intent moves the Head to, read now (82tn.51). The id is the session, the Head and the
 * newest Head Log entry it starts from, and the intent: two devices confirming the same proposal
 * share it, and a proposal made before the conversation moved on no longer matches.
 */
const planHeadMove = (sessionId: string, intent: MoveIntent) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const head = yield* readHead(sessionId);
		const [last] = yield* sql<{ id: string }>`
			SELECT json_extract(data, '$.moveId') AS id FROM events
			WHERE session_id = ${sessionId} AND type = 'head.move_started'
			ORDER BY sequence DESC LIMIT 1`;
		const nodeRows = (node: string | null) =>
			sql<{ id: string; role: string; text: string }>`
				SELECT id, role, text FROM messages
				WHERE session_id = ${sessionId} AND history_node_id IS ${node}
				ORDER BY ordinal, created_at, id`;
		const target = yield* Effect.gen(function* () {
			switch (intent._tag) {
				case "rewind": {
					const [row] = yield* sql<{
						node: string | null;
						parent: string | null;
					}>`
						SELECT m.history_node_id AS node, n.parent_id AS parent FROM messages m
						JOIN history_nodes n ON n.session_id = m.session_id AND n.id = m.history_node_id
						WHERE m.session_id = ${sessionId} AND m.id = ${intent.messageId}`;
					if (!row) return yield* noTarget(sessionId);
					// 82tn.50: a node is one Run. A rewind to a row inside it (a steer, a reply) goes
					// back before the Run, and the Run's typed inputs return to the composer.
					const rows = yield* nodeRows(row.node);
					const cut = rows[0]?.id ?? intent.messageId;
					const inputs =
						cut === intent.messageId || intent.resend !== undefined
							? []
							: rows.flatMap(({ role, text }) =>
									role === "user" && text !== "" ? [text] : [],
								);
					return {
						kind: "rewind" as const,
						to: row.parent,
						messageId: cut,
						filesAt: cut,
						inputs,
					};
				}
				case "undo": {
					const [entry] = yield* sql<{ data: string }>`SELECT data FROM events
						WHERE session_id = ${sessionId} AND type = 'head.move_started'
						AND json_extract(data, '$.moveId') = ${intent.moveId}`;
					const undone: { from?: string | null; files?: readonly string[] } =
						entry ? JSON.parse(entry.data) : {};
					if (undone.from === undefined) return yield* noTarget(sessionId);
					return {
						kind: "undo" as const,
						to: undone.from,
						inputs: [],
						// ADR-0015: undo puts the files back as the move found them, so undoing a move
						// that restored files restores them unless the intent says conversation only.
						withFiles: intent.withFiles ?? (undone.files ?? []).length > 0,
					};
				}
				case "switch":
					return { kind: "switch" as const, to: intent.nodeId, inputs: [] };
			}
		});
		// The target must exist, and every node joining the Head must still hold its rows.
		const onHead = new Set(yield* pathToRoot(sessionId, head));
		const joining = (yield* pathToRoot(sessionId, target.to)).filter(
			(id) => !onHead.has(id),
		);
		const missing =
			target.to !== null &&
			(yield* sql<{ id: string }>`SELECT id FROM history_nodes
				WHERE session_id = ${sessionId} AND id = ${target.to}`).length === 0;
		const [lost] =
			joining.length === 0
				? []
				: yield* sql<{ id: string }>`SELECT id FROM history_nodes
					WHERE session_id = ${sessionId} AND id IN ${sql.in(joining)} AND available = 0`;
		if (missing || lost) return yield* noTarget(sessionId);
		// 82tn.52: a native revert (Codex, OpenCode) only drops turns from the path it holds.
		if ((yield* readSessionResumePlan(sessionId, target.to)) === "refused")
			return yield* new SessionBusy({
				sessionId,
				command: "head_move",
				reason: "branch_unsupported",
			});
		const [tip] =
			target.to === null
				? []
				: yield* sql<{ id: string }>`
					SELECT id FROM messages WHERE session_id = ${sessionId} AND history_node_id = ${target.to}
					UNION ALL SELECT row_key FROM history_off_head
					WHERE session_id = ${sessionId} AND node_id = ${target.to} AND source_table = 'messages'
					LIMIT 1`;
		const filesAt = "filesAt" in target ? target.filesAt : tip?.id;
		const files =
			filesAt === undefined
				? ("available" as const)
				: yield* headMoveFiles(sessionId, filesAt);
		// 82tn.53: a move with files needs them kept at the target, and plans each folder it restores.
		const withFiles =
			"withFiles" in target ? target.withFiles : intent.withFiles;
		if (withFiles && files !== "available")
			return yield* new FilesRefused({ sessionId, reason: files });
		const folders = withFiles
			? yield* planFiles(
					sessionId,
					head,
					target.to,
					intent._tag === "undo" ? intent.moveId : undefined,
				)
			: undefined;
		// A folder's plan joins the id, so a proposal the folder moved past no longer matches.
		const moveId = createHash("sha256")
			.update(
				JSON.stringify([
					sessionId,
					head,
					last?.id ?? null,
					intent,
					...(folders
						? [folders.map(({ directory, to, key }) => [directory, to, key])]
						: []),
				]),
			)
			.digest("hex")
			.slice(0, 32);
		return { moveId, head, target, files, folders };
	});

/** The next send's resume plan on the session's provider (82tn.52), at the Head or at `head`. */
export const readSessionResumePlan = (
	sessionId: string,
	head?: string | null,
) =>
	Effect.gen(function* () {
		const session = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
		if (!session) return "current" as const;
		const account = yield* (yield* AccountDirectory)
			.resolve({ _tag: "Id", id: session.provider })
			.pipe(Effect.option);
		return yield* readResumePlan(
			yield* SqlClient.SqlClient,
			sessionId,
			session.provider,
			Option.match(account, {
				onNone: () => session.provider,
				onSome: ({ driver }) => driver,
			}),
			head,
		);
	});

/** A proposal for an intent: its id and whether the files there are kept (82tn.51). */
export const previewHeadMove = (sessionId: string, intent: MoveIntent) =>
	Effect.gen(function* () {
		// A busy session says so first: a running Run has no History Node yet, so planning a
		// target inside it would read as history no longer kept.
		yield* admitOrRefuse(sessionId, { kind: "head_move" });
		const plan = yield* planHeadMove(sessionId, intent);
		return {
			moveId: plan.moveId,
			files: plan.files,
			...("messageId" in plan.target ? { before: plan.target.messageId } : {}),
			...(plan.folders
				? {
						restore: {
							folders: plan.folders.map(({ directory, changes }) => ({
								directory,
								changes,
							})),
						},
					}
				: {}),
		};
	});

/**
 * Confirms a proposal (82tn.51). The same id again returns the same receipt, however many
 * devices confirm it; a proposal the conversation moved past is refused. The move is journalled
 * started under the inbox's permit, then lands and admits its resend under it again.
 */
export const commitHeadMove = ({
	sessionId,
	intent,
	moveId,
	resend,
}: {
	sessionId: string;
	intent: MoveIntent;
	moveId: string;
	/** The resend's request, built from the session's composer settings. */
	resend?: InputRequest;
}) =>
	Effect.gen(function* () {
		const inbox = yield* SessionInboxTag;
		const sql = yield* SqlClient.SqlClient;
		const started = yield* inbox.withSession(
			sessionId,
			Effect.gen(function* () {
				const [journalled] = yield* sql<{
					data: string;
				}>`SELECT data FROM events
					WHERE session_id = ${sessionId} AND type = 'head.move_started'
					AND json_extract(data, '$.moveId') = ${moveId} LIMIT 1`;
				// A second confirmation joins the landing, so its receipt follows the move's.
				if (journalled)
					return {
						move: JSON.parse(
							journalled.data,
						) as EventPayloadMap["head.move_started"],
						inputs: [],
					};
				const row = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
				if (!row) return yield* noTarget(sessionId);
				const plan = yield* planHeadMove(sessionId, intent);
				if (plan.moveId !== moveId)
					return yield* new SessionBusy({
						sessionId,
						command: "head_move",
						reason: "head_move_stale",
					});
				yield* admitOrRefuse(sessionId, { kind: "head_move" });
				const { target, folders = [] } = plan;
				const start = startHeadMove(sessionId, row.provider, {
					moveId,
					kind: target.kind,
					from: plan.head,
					to: target.to,
					...("messageId" in target ? { messageId: target.messageId } : {}),
					...(intent._tag === "undo" ? { undoes: intent.moveId } : {}),
					...(resend ? { resend } : {}),
					...(folders.length > 0
						? { files: folders.map(({ directory }) => directory) }
						: {}),
				});
				// 82tn.53: the files are restored before the move is journalled started, so a move
				// in the log always has its files; a crash before that rolls them back at startup.
				const move =
					folders.length > 0
						? yield* restoreFiles(sessionId, moveId, folders, start)
						: yield* start;
				return { move, inputs: target.inputs };
			}),
		);
		// Test seam: widens the window a send or a crash can arrive in while the move is in progress.
		if (process.env["NODE_ENV"] === "test")
			yield* Effect.sleep(
				Number(process.env["CONDUIT_TEST_HEAD_MOVE_DELAY_MS"] ?? 0),
			);
		yield* inbox.landHeadMove(sessionId, started.move);
		if (started.inputs.length > 0) {
			const restore = (yield* InputDraftsTag).restoreChange(
				{ session: sessionId },
				`rewind:${moveId}`,
				[],
				started.inputs.join("\n\n"),
			);
			yield* restore.write;
			yield* restore.publish;
		}
		return { moveId };
	});

/** The session's Head Log, newest first: every move, each undoable (82tn.51). */
export const readHeadLog = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ data: string; at: number; landed: number }>`
			SELECT started.data, started.created_at AS at,
				EXISTS (SELECT 1 FROM events moved WHERE moved.session_id = started.session_id
					AND moved.type = 'head.moved'
					AND json_extract(moved.data, '$.moveId') = json_extract(started.data, '$.moveId')) AS landed
			FROM events started
			WHERE started.session_id = ${sessionId} AND started.type = 'head.move_started'
				AND json_type(started.data, '$.to') IS NOT NULL
			ORDER BY started.sequence DESC`;
		return rows.map(({ data, at, landed }): HeadLogEntry => {
			const move = JSON.parse(data) as EventPayloadMap["head.move_started"];
			return {
				moveId: move.moveId,
				kind: move.kind,
				at,
				...(move.messageId === undefined ? {} : { messageId: move.messageId }),
				...(move.undoes === undefined ? {} : { undoes: move.undoes }),
				...(move.resend === undefined ? {} : { resend: move.resend.text }),
				landed: landed === 1,
			};
		});
	});

/**
 * Where the Head's path branched (82tn.51), root first. A branch's tip is its newest descendant, so a
 * switch returns to where that branch was left. A branch's text is its first user message, read from
 * the kept rows when it is off the Head.
 */
export const readHeadBranches = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const nodes = yield* sql<{
			id: string;
			parent: string | null;
			available: number;
		}>`SELECT id, parent_id AS parent, available FROM history_nodes
			WHERE session_id = ${sessionId} ORDER BY created_at, id`;
		const firsts = yield* sql<{ node: string; id: string; text: string }>`
			SELECT node, id, text FROM (
				SELECT history_node_id AS node, id, text, role, ordinal, created_at FROM messages
				WHERE session_id = ${sessionId} AND history_node_id IS NOT NULL
				UNION ALL
				SELECT node_id, row_key, json_extract(row_json, '$.text'), json_extract(row_json, '$.role'),
					json_extract(row_json, '$.ordinal'), json_extract(row_json, '$.created_at')
				FROM history_off_head WHERE session_id = ${sessionId} AND source_table = 'messages'
			) WHERE role = 'user' ORDER BY ordinal DESC, created_at DESC, id DESC`;
		// Ordered newest first, so the last write per node is its first user message.
		const first = new Map(firsts.map((row) => [row.node, row]));
		const children = (id: string | null) =>
			nodes.filter(({ parent }) => parent === id);
		const tip = (id: string): string => {
			const newest = children(id).at(-1);
			return newest === undefined ? id : tip(newest.id);
		};
		const path = (yield* pathToRoot(
			sessionId,
			yield* readHead(sessionId),
		)).reverse();
		return path.flatMap((node) => {
			const parent = nodes.find(({ id }) => id === node)?.parent ?? null;
			const siblings = children(parent);
			const at = first.get(node)?.id;
			return siblings.length > 1 && at !== undefined
				? [
						{
							messageId: at,
							branches: siblings.map((sibling) => ({
								tip: tip(sibling.id),
								text: first.get(sibling.id)?.text ?? "",
								onHead: sibling.id === node,
								available: sibling.available === 1,
							})),
						},
					]
				: [];
		});
	});
