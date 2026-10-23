import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type {
	CommitAndSignal,
	CommitAndSignalProject,
} from "../persistence/effect/commit-and-signal.js";
import { isRecord } from "../utils.js";
import { DurableCommandCommitRepository } from "./orchestration-command-commit.js";
import {
	DURABLE_COMMAND_FINGERPRINT_VERSION,
	ProviderControlPayloadSchema,
} from "./orchestration-command-contracts.js";
import { controlFingerprintHash } from "./orchestration-command-fingerprint.js";

/** Give retained, already committed answers the same executor as new controls. */
export const backfillLegacyControlAnswers = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly projectId?: string;
	readonly write: CommitAndSignal["write"];
}) =>
	options.write((project) =>
		enqueueCommittedControlAnswers({ ...options, project }),
	);

/** Enqueue retained resolutions inside the transaction that owns their commit. */
export const enqueueCommittedControlAnswers = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly projectId?: string;
	readonly project: CommitAndSignalProject;
	readonly requestIds?: readonly string[];
}) =>
	Effect.gen(function* () {
		const { sql, projectId, project } = options;
		const rows = yield* sql<{
			project_key: string;
			event_id: string;
			type: "permission.resolved" | "question.resolved";
			data: string;
			command_id: string;
			session_id: string;
			provider_id: string;
			provider_process_id: string;
			provider_request_id: string | null;
			request_id: string;
			created_at: number;
		}>`SELECT s.project_id AS project_key, e.event_id, e.type, e.data, e.session_id, e.created_at,
				COALESCE(NULLIF(s.provider, ''), e.provider) AS provider_id,
				CASE WHEN json_type(e.metadata, '$.commandId') = 'text' AND json_extract(e.metadata, '$.commandId') <> ''
					THEN json_extract(e.metadata, '$.commandId') ELSE 'legacy-answer:' || e.event_id END AS command_id,
				pa.id AS request_id, pa.provider_process_id, pa.provider_request_id
				FROM events e JOIN sessions s ON s.id = e.session_id
				JOIN pending_approvals pa ON pa.session_id = e.session_id AND pa.id = json_extract(e.data, '$.id')
					AND pa.type = CASE e.type WHEN 'permission.resolved' THEN 'permission' ELSE 'question' END
				WHERE (${projectId ?? null} IS NULL OR s.project_id = ${projectId ?? null})
					AND e.type IN ('permission.resolved', 'question.resolved')
					AND pa.provider_process_id IS NOT NULL
					AND (${options.requestIds?.length ?? null} IS NULL OR ${sql.in("pa.id", options.requestIds ?? [])})
					AND json_extract(e.metadata, '$.source') IS NOT 'provider-process-expired'
					AND json_extract(e.metadata, '$.source') IS NOT 'conduit.control-outbox'
					AND e.sequence = (SELECT MAX(later.sequence) FROM events later WHERE later.session_id = e.session_id
						AND later.type = e.type AND json_extract(later.data, '$.id') = pa.id)
				ORDER BY e.sequence`;
		const repliesTable =
			yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claude_runner_permission_replies'`;
		const repository = new DurableCommandCommitRepository(sql, projectId);
		let count = 0;
		for (const row of rows) {
			const existing =
				yield* sql`SELECT command_id FROM command_receipts WHERE command_id = ${row.command_id}
					UNION ALL SELECT command_id FROM provider_command_outbox WHERE command_id = ${row.command_id}
						OR (session_id = ${row.session_id} AND effect_type = ${row.type === "permission.resolved" ? "resolve_permission" : "resolve_question"}
							AND json_extract(payload_json, '$.requestId') = ${row.request_id}) LIMIT 1`;
			if (existing.length > 0) continue;
			const replies =
				row.type === "permission.resolved" && repliesTable.length > 0
					? yield* sql<{
							response_json: string;
						}>`SELECT response_json FROM claude_runner_permission_replies
							WHERE session_id = ${row.session_id} AND request_id = ${row.request_id}`
					: [];
			const payload = yield* Effect.try({
				try: () => {
					const data = Schema.decodeUnknownSync(
						Schema.Record(Schema.String, Schema.Unknown),
					)(JSON.parse(row.data));
					const response: unknown = replies[0]
						? JSON.parse(replies[0].response_json)
						: undefined;
					const target = {
						sessionId: row.session_id,
						providerProcessId: row.provider_process_id,
						requestId: row.request_id,
						...(row.provider_request_id !== null
							? { nativeRequestId: row.provider_request_id }
							: {}),
					};
					return Schema.decodeUnknownSync(ProviderControlPayloadSchema)(
						row.type === "permission.resolved"
							? {
									...target,
									type: "resolve_permission",
									decision: data["decision"],
									...(response !== undefined ? { response } : {}),
								}
							: {
									...target,
									type: "resolve_question",
									answers: data["answers"],
									operation:
										data["operation"] === "reject" ||
										(data["operation"] !== "reply" &&
											isRecord(data["answers"]) &&
											Object.keys(data["answers"]).length === 0)
											? "reject"
											: "reply",
								},
					);
				},
				catch: (cause) =>
					new Error(`Cannot backfill legacy answer ${row.event_id}`, {
						cause,
					}),
			});
			const [last] = yield* sql<{
				sequence: number;
			}>`SELECT COALESCE(MAX(request_sequence), 0) AS sequence FROM provider_command_outbox`;
			const requestSequence = (last?.sequence ?? 0) + 1;
			yield* project(
				yield* repository.commit(
					{
						immutable: true,
						events: [],
						receipt: {
							commandId: row.command_id,
							commandType: payload.type,
							sessionId: row.session_id,
							status: "side_effect_requested",
							fingerprintHash: controlFingerprintHash(payload),
							fingerprintVersion: DURABLE_COMMAND_FINGERPRINT_VERSION,
							acceptedSequence: requestSequence,
							sideEffectSequence: requestSequence,
							createdAt: row.created_at,
							updatedAt: row.created_at,
						},
						outboxRequests: [
							{
								requestSequence,
								commandId: row.command_id,
								sessionId: row.session_id,
								providerId: row.provider_id,
								providerProcessId: row.provider_process_id,
								effectType: payload.type,
								payloadJson: JSON.stringify(payload),
							},
						],
						readModelRows: ["provider_command_meta"],
					},
					row.project_key,
				),
			);
			count += 1;
		}
		return count;
	});
