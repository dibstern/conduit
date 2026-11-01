import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import {
	inputPlacement,
	viewLedger,
} from "../../provider/run-ledger/run-ledger-decider.js";
import { type CanonicalEvent, canonicalEvent } from "../events.js";
import { loadLedger } from "./run-ledger-arm.js";

/**
 * Requeue unplaced handoffs after failure or confirmed loss of a removed runner. The ledger view
 * read in this write places a steer its Run's end left possibly reached (2.1 row 206), and with
 * `cancelFinal` cancels each steer it marks failed after its requeue, in one batch (row 207).
 */
export const requeueFailedSteers = <E>(
	sql: SqlClient.SqlClient,
	persist: {
		readonly persistEvents: (
			events: readonly CanonicalEvent[],
		) => Effect.Effect<void, E>;
	},
	sessionId?: string,
	inputId?: string,
	projectId?: string,
	options?: { readonly cancelFinal?: true },
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			session_id: string;
			input_id: string;
			sent_sequence: number;
			error_code: string | null;
			run_id: string | null;
			text: string;
			images: string | null;
		}>`
			SELECT pending.session_id, pending.input_id, pending.text, pending.images,
				(SELECT MAX(sequence) FROM events WHERE session_id = pending.session_id
					AND type = 'input.sent' AND json_extract(data, '$.inputId') = pending.input_id) AS sent_sequence,
				(SELECT error_code FROM provider_command_outbox
					WHERE command_id = pending.input_id AND session_id = pending.session_id
					AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1) AS error_code,
				(SELECT run_id FROM provider_command_outbox
					WHERE command_id = pending.input_id AND session_id = pending.session_id
					AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1) AS run_id
			FROM pending_inputs pending JOIN sessions session ON session.id = pending.session_id
			WHERE pending.state = 'steering'
				AND (${projectId ?? null} IS NULL OR session.project_id = ${projectId ?? null})
				AND (${sessionId ?? null} IS NULL OR pending.session_id = ${sessionId ?? null})
				AND (${inputId ?? null} IS NULL OR pending.input_id = ${inputId ?? null})
				AND NOT EXISTS (SELECT 1 FROM messages WHERE input_id = pending.input_id)
				AND (SELECT command.status = 'failed' OR (
						command.status = 'cancelled' AND command.error_code = 'project_inactive'
						AND EXISTS (SELECT 1 FROM provider_runs run
							WHERE run.id = command.run_id AND run.session_id = command.session_id AND run.status = 'error'))
					FROM provider_command_outbox command
					WHERE command.command_id = pending.input_id AND command.session_id = pending.session_id
					AND command.effect_type = 'send_turn' ORDER BY command.request_sequence DESC LIMIT 1)
			ORDER BY pending.admitted_at DESC, pending.rowid DESC`;
		if (rows.length === 0) return;
		const events = yield* Effect.forEach(rows, (row) =>
			Effect.gen(function* () {
				const ledger = yield* loadLedger(row.session_id).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				);
				const place =
					ledger && inputPlacement(ledger.state, row.input_id)?.place;
				const requeued = canonicalEvent("input.requeued", row.session_id, {
					sessionId: row.session_id,
					inputId: row.input_id,
					sentSequence: row.sent_sequence,
					reason: row.error_code === "steer-declined" ? "declined" : "failed",
				});
				// Row 206 (CONTRACT.md 217) at any end of its Run (970-972): a steer the view reads possibly
				// reached is placed, never re-sent. While its Run is active main's requeue stays (3.6, gap).
				if (
					ledger &&
					place === "sent" &&
					!viewLedger(ledger.state).active?.inputs.some(
						(input) => input.inputId === row.input_id,
					)
				) {
					const provider = { provider: ledger.provider };
					const meta = {
						...provider,
						...(row.run_id ? { metadata: { runId: row.run_id } } : {}),
					};
					const images = Option.getOrElse(
						Schema.decodeUnknownOption(
							Schema.fromJsonString(Schema.Array(AttachmentRefSchema)),
						)(row.images ?? "[]"),
						() => [],
					);
					// As main's placement (`persistUserMessage`), its message id the input's.
					return [
						canonicalEvent(
							"message.created",
							row.session_id,
							{
								messageId: row.input_id,
								role: "user",
								sessionId: row.session_id,
								inputId: row.input_id,
							},
							meta,
						),
						...(row.text === ""
							? []
							: [
									canonicalEvent(
										"text.delta",
										row.session_id,
										{
											messageId: row.input_id,
											partId: `${row.input_id}-0`,
											text: row.text,
										},
										provider,
									),
								]),
						...images.map((ref, index) =>
							canonicalEvent(
								"file.attached",
								row.session_id,
								{
									messageId: row.input_id,
									partId: `${row.input_id}-attachment-${index}`,
									mime: ref.mime,
									...(ref.name !== undefined ? { filename: ref.name } : {}),
									source: ref,
								},
								provider,
							),
						),
					];
				}
				// Row 207 (CONTRACT.md 218): the requeue and main's Cancel event in the same batch.
				return place === "failed" && options?.cancelFinal
					? [
							requeued,
							canonicalEvent("input.cancelled", row.session_id, {
								sessionId: row.session_id,
								inputId: row.input_id,
							}),
						]
					: [requeued];
			}),
		);
		yield* persist.persistEvents(events.flat());
	});
