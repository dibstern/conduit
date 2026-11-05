import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
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
