import { Effect } from "effect";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { PendingQuestionInput } from "./pending-interaction-service.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import { SessionManagerServiceTag } from "./session-manager-service.js";

/** Rebuild answerable Claude questions from the one durable tool snapshot. */
export const restoreClaudeQuestionsFromStore = Effect.gen(function* () {
	const readQuery = yield* ReadQueryEffectTag;
	if (!readQuery.listPendingClaudeQuestionTools) return;

	const rows = yield* readQuery.listPendingClaudeQuestionTools();
	const questions: PendingQuestionInput[] = [];
	for (const row of rows) {
		try {
			const input: unknown = JSON.parse(row.input ?? "null");
			if (!input || typeof input !== "object" || !("questions" in input))
				continue;
			const rawQuestions = input.questions;
			if (
				!Array.isArray(rawQuestions) ||
				!rawQuestions.every(
					(item) =>
						item &&
						typeof item === "object" &&
						typeof item.question === "string",
				)
			)
				continue;
			questions.push({
				requestId: row.call_id ?? row.id,
				sessionId: row.session_id,
				toolCallId: row.call_id ?? row.id,
				partId: row.id,
				messageId: row.message_id,
				providerId: "claude",
				timestamp: row.created_at,
				questions: rawQuestions.map((item) => ({
					question: item.question,
					...(typeof item.header === "string" ? { header: item.header } : {}),
					...(Array.isArray(item.options) ? { options: item.options } : {}),
					...(typeof item.multiSelect === "boolean"
						? { multiSelect: item.multiSelect }
						: {}),
				})),
			});
		} catch {
			yield* Effect.logWarning(
				`Could not recover Claude question tool ${row.id}: invalid input`,
			);
		}
	}
	const pendingInteractions = yield* PendingInteractionServiceTag;
	yield* pendingInteractions.recoverPendingQuestions(questions);
	const counts = new Map<string, number>();
	for (const question of questions) {
		counts.set(question.sessionId, (counts.get(question.sessionId) ?? 0) + 1);
	}
	const sessions = yield* SessionManagerServiceTag;
	yield* sessions.setPendingQuestionCounts(counts);
});
