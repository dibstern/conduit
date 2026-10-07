import { Effect } from "effect";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { historicalMessageText } from "./prepare-turn.js";
import type { ClaudeThreadReadInput, ClaudeThreadReadResult } from "./types.js";

export const makeClaudeThreadRead = Effect.gen(function* () {
	const read = yield* ReadQueryEffectTag;
	return (
		sessionId: string,
		input: ClaudeThreadReadInput,
	): Effect.Effect<ClaudeThreadReadResult> =>
		Effect.gen(function* () {
			if (!(yield* read.getSession(sessionId)))
				return {
					code: "SessionGone",
					message: "This Conduit session no longer exists.",
				};
			const offset = input.textOffset ?? 0;
			if (!Number.isSafeInteger(offset) || offset < 0)
				return {
					code: "InvalidOffset",
					message: "Text offset must be a non-negative integer.",
				};
			const limit = Number.isFinite(input.limit)
				? Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)))
				: 50;
			const page = yield* read.readSessionTranscriptPage(sessionId, {
				limit: limit + 1,
				forward: input.cursor === undefined ? {} : { from: input.cursor },
			});
			const first = page.messages[0];
			if (offset > (first ? historicalMessageText(first).length : 0))
				return {
					code: "InvalidOffset",
					message: "Text offset is beyond this message's text.",
				};
			const items: Extract<
				ClaudeThreadReadResult,
				{ items: unknown }
			>["items"][number][] = [];
			// One budget per reply keeps a full page inside the SDK's tool-output cap.
			let budget = 20_000;
			for (const [index, message] of page.messages.slice(0, limit).entries()) {
				if (budget === 0) return { items, nextCursor: message.id };
				const text = historicalMessageText(message);
				const start = index === 0 ? offset : 0;
				let end = Math.min(text.length, start + budget);
				// Keep a Unicode surrogate pair together at the page boundary.
				if (
					end < text.length &&
					/[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
					/[\uDC00-\uDFFF]/.test(text[end] ?? "")
				)
					end--;
				budget -= end - start;
				items.push({
					id: message.id,
					role: message.role,
					text: text.slice(start, end),
					textOffset: start,
					interrupted: message.finish === "interrupted",
				});
				if (end < text.length)
					return { items, nextCursor: message.id, nextTextOffset: end };
			}
			const nextCursor = page.messages[limit]?.id;
			return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.succeed<ClaudeThreadReadResult>(
					error._tag === "TranscriptPageCursorNotFoundError"
						? {
								code: "BadCursor",
								message: "The message cursor does not belong to this session.",
							}
						: {
								code: "ServerUnavailable",
								message: "Conduit could not read this session's history.",
							},
				),
			),
		);
});
