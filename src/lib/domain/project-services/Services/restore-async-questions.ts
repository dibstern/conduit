import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { QuestionAskedDetailsSchema } from "../../../contracts/stored-event.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { QuestionApprovalSchema } from "../../../shared-types.js";
import {
	PendingInteractionServiceTag,
	type PendingQuestionInput,
} from "./pending-interaction-service.js";

/** Async questions belong to the session, independent of the provider process. */
export const restoreAsyncQuestionsFromStore = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* EventStoreEffectTag;
	const pending = yield* PendingInteractionServiceTag;
	const rows = yield* sql<{
		id: string;
		session_id: string;
		input: string;
		details: string;
		provider_process_id: string | null;
		provider_request_id: string | null;
		created_at: number;
	}>`SELECT pa.id, pa.session_id, pa.input, pa.details,
		pa.provider_process_id, pa.provider_request_id, pa.created_at
		FROM pending_approvals pa JOIN sessions s ON s.id = pa.session_id
		WHERE s.project_id = ${projectId} AND pa.type = 'question' AND pa.status = 'pending'
		AND json_extract(pa.details, '$.delivery') = 'async'`;
	const questions: PendingQuestionInput[] = [];
	for (const row of rows) {
		const decoded = yield* Effect.try(() => ({
			questions: Schema.decodeUnknownSync(
				Schema.fromJsonString(QuestionApprovalSchema.fields.questions),
			)(row.input),
			details: Schema.decodeUnknownSync(
				Schema.fromJsonString(QuestionAskedDetailsSchema),
			)(row.details),
		})).pipe(Effect.result);
		if (decoded._tag === "Failure") {
			yield* Effect.logWarning(
				`Could not recover async question ${row.id}: invalid question data`,
			);
			continue;
		}
		const { details } = decoded.success;
		questions.push({
			requestId: row.id,
			sessionId: row.session_id,
			delivery: "async",
			questions: decoded.success.questions,
			...(row.provider_process_id
				? { providerProcessId: row.provider_process_id }
				: {}),
			...(row.provider_request_id
				? { providerRequestId: row.provider_request_id }
				: {}),
			...(details.providerId ? { providerId: details.providerId } : {}),
			...(details.toolUseId ? { toolCallId: details.toolUseId } : {}),
			...(details.messageId ? { messageId: details.messageId } : {}),
			...(details.partId ? { partId: details.partId } : {}),
			timestamp: row.created_at,
		});
	}
	yield* pending.recoverPendingQuestions(questions);
});
