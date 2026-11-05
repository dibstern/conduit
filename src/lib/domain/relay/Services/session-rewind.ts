import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SessionBusy } from "../../../contracts/limit-recovery.js";
import type { InputRequest } from "../../../contracts/stored-event.js";
import type { HeadLogEntry, MoveIntent } from "../../../contracts/ws-rpc.js";
import {
	pathToRoot,
	readHead,
} from "../../../persistence/effect/history-graph.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { EventPayloadMap } from "../../../persistence/events.js";
import { headMoveFiles } from "../../daemon/Services/folder-timeline.js";
import { InputDraftsTag } from "./input-drafts.js";
import { LoggerTag } from "./services.js";
import {
	admitOrRefuse,
	finishHeadMove,
	startHeadMove,
} from "./session-command.js";
import { SessionInboxTag } from "./session-inbox.js";

export class RewindTargetNotFound extends Data.TaggedError(
	"RewindTargetNotFound",
)<{
	readonly sessionId: string;
	readonly messageId: string;
	readonly message: string;
}> {}

export class RewindUnavailable extends Data.TaggedError("RewindUnavailable")<{
	readonly sessionId: string;
	readonly message: string;
}> {}

/**
 * A head move (82tn.49, ADR-0014): admitted from the ledger's facts and journalled under the
 * inbox's permit, then landed under it again. Between the two, the inbox's admit reads the move
 * in progress, so a send queues behind it instead of being handed off.
 */
const moveHead = <E>(
	sessionId: string,
	start: (row: {
		provider: string;
		pending_rewind_message_id: string | null;
	}) => Effect.Effect<
		Parameters<typeof startHeadMove>[2] | undefined,
		E,
		SqlClient.SqlClient
	>,
) =>
	Effect.gen(function* () {
		const inbox = yield* SessionInboxTag;
		const started = yield* inbox.withSession(
			sessionId,
			Effect.gen(function* () {
				const row = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
				if (!row)
					return yield* new RewindUnavailable({
						sessionId,
						message: "Session not found",
					});
				yield* admitOrRefuse(sessionId, { kind: "head_move" });
				const move = yield* start({
					provider: row.provider,
					pending_rewind_message_id: row.pending_rewind_message_id ?? null,
				});
				return move && (yield* startHeadMove(sessionId, row.provider, move));
			}),
		);
		if (!started) return false;
		// Test seam: widens the window a send can arrive in while the move is in progress.
		if (process.env["NODE_ENV"] === "test")
			yield* Effect.sleep(
				Number(process.env["CONDUIT_TEST_HEAD_MOVE_DELAY_MS"] ?? 0),
			);
		yield* inbox.withSession(sessionId, finishHeadMove(sessionId, started));
		return true;
	});

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
		let inputs: readonly string[] = [];
		const moved = yield* moveHead(sessionId, (row) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const [target] = yield* sql<{ node: string | null; role: string }>`
					SELECT history_node_id AS node, role FROM messages
					WHERE session_id = ${sessionId} AND id = ${messageId}`;
				if (!target)
					return yield* new RewindTargetNotFound({
						sessionId,
						messageId,
						message: `Rewind target ${messageId} not found in session ${sessionId}`,
					});
				// 82tn.50: a steer is one Run with the input before it, so a rewind to a steer moves
				// to its Run's first row: the Head lands on the Run's parent, and the Run's typed
				// inputs return to the composer. Any other target cuts where it did before.
				const rows = yield* sql<{ id: string; role: string; text: string }>`
					SELECT id, role, text FROM messages
					WHERE session_id = ${sessionId} AND history_node_id = ${target.node}
					ORDER BY ordinal, created_at, id`;
				const first = rows[0]?.id;
				const steer =
					target.role === "user" && first !== undefined && first !== messageId;
				const cut = steer ? first : messageId;
				if (row.pending_rewind_message_id === cut) return undefined;
				inputs = steer
					? rows.flatMap(({ role, text }) =>
							role === "user" && text !== "" ? [text] : [],
						)
					: [];
				return { kind: "rewind" as const, messageId: cut };
			}),
		);
		if (moved && inputs.length > 0) {
			const restore = (yield* InputDraftsTag).restoreChange(
				{ session: sessionId },
				`rewind:${messageId}`,
				[],
				inputs.join("\n\n"),
			);
			yield* restore.write;
			yield* restore.publish;
		}
		const log = yield* LoggerTag;
		log.info(
			`client=${clientId} session=${sessionId} Rewound to message: ${messageId}`,
		);
	});

export const undoSessionRewind = ({
	clientId,
	sessionId,
}: {
	clientId: string;
	sessionId: string;
}) =>
	Effect.gen(function* () {
		yield* moveHead(sessionId, (row) =>
			row.pending_rewind_message_id
				? Effect.succeed({ kind: "undo" as const })
				: Effect.fail(
						new RewindUnavailable({
							sessionId,
							message: "There is no pending rewind to undo",
						}),
					),
		);
		const log = yield* LoggerTag;
		log.info(`client=${clientId} session=${sessionId} Undid rewind`);
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
		const moveId = createHash("sha256")
			.update(JSON.stringify([sessionId, head, last?.id ?? null, intent]))
			.digest("hex")
			.slice(0, 32);
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
					const undone = entry
						? (JSON.parse(entry.data) as { from?: string | null })
						: {};
					if (undone.from === undefined) return yield* noTarget(sessionId);
					return { kind: "undo" as const, to: undone.from, inputs: [] };
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
		const [tip] =
			target.to === null
				? []
				: yield* sql<{ id: string }>`
					SELECT id FROM messages WHERE session_id = ${sessionId} AND history_node_id = ${target.to}
					UNION ALL SELECT row_key FROM history_off_head
					WHERE session_id = ${sessionId} AND node_id = ${target.to} AND source_table = 'messages'
					LIMIT 1`;
		const filesAt = "filesAt" in target ? target.filesAt : tip?.id;
		return {
			moveId,
			head,
			target,
			files:
				filesAt === undefined
					? ("available" as const)
					: yield* headMoveFiles(sessionId, filesAt),
		};
	});

/** A proposal for an intent: its id and whether the files there are kept (82tn.51). */
export const previewHeadMove = (sessionId: string, intent: MoveIntent) =>
	Effect.gen(function* () {
		const plan = yield* planHeadMove(sessionId, intent);
		yield* admitOrRefuse(sessionId, { kind: "head_move" });
		return { moveId: plan.moveId, files: plan.files };
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
				const [journalled] = yield* sql<{ n: number }>`SELECT 1 AS n FROM events
					WHERE session_id = ${sessionId} AND type = 'head.move_started'
					AND json_extract(data, '$.moveId') = ${moveId} LIMIT 1`;
				if (journalled) return undefined;
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
				if (row.pending_rewind_message_id != null)
					return yield* new SessionBusy({
						sessionId,
						command: "head_move",
						reason: "rewind_pending",
					});
				const { target } = plan;
				const move = yield* startHeadMove(sessionId, row.provider, {
					moveId,
					kind: target.kind,
					from: plan.head,
					to: target.to,
					...("messageId" in target ? { messageId: target.messageId } : {}),
					...(intent._tag === "undo" ? { undoes: intent.moveId } : {}),
					...(resend ? { resend } : {}),
				});
				return { move, inputs: target.inputs };
			}),
		);
		if (!started) return { moveId };
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
