import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
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
		if (!started) return;
		// Test seam: widens the window a send can arrive in while the move is in progress.
		if (process.env["NODE_ENV"] === "test")
			yield* Effect.sleep(
				Number(process.env["CONDUIT_TEST_HEAD_MOVE_DELAY_MS"] ?? 0),
			);
		yield* inbox.withSession(sessionId, finishHeadMove(sessionId, started));
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
		yield* moveHead(sessionId, (row) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const [target] = yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${sessionId} AND id = ${messageId}`;
				if (!target)
					return yield* new RewindTargetNotFound({
						sessionId,
						messageId,
						message: `Rewind target ${messageId} not found in session ${sessionId}`,
					});
				if (row.pending_rewind_message_id === messageId) return undefined;
				return { kind: "rewind" as const, messageId };
			}),
		);
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
