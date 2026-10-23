import { Effect, Option, Schema } from "effect";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import { AttachmentStoreTag } from "../../domain/persistence/Services/attachment-store.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { historicalMessageText } from "../historical-message-text.js";
import type { ClaudeThreadReadInput, ClaudeThreadReadResult } from "./types.js";

export const makeClaudeThreadRead = Effect.gen(function* () {
	const read = yield* ReadQueryEffectTag;
	const attachmentStore = yield* AttachmentStoreTag;
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
			const messages = page.messages.slice(0, limit);
			const hashes = new Set<string>();
			for (const message of messages) {
				if (message.role !== "user") continue;
				for (const part of message.parts) {
					if (part.type !== "file") continue;
					const attachment = Schema.decodeUnknownOption(
						Schema.fromJsonString(
							Schema.Struct({ source: AttachmentRefSchema }),
						),
					)(part.rest_payload ?? part.metadata);
					if (Option.isSome(attachment))
						hashes.add(attachment.value.source.attachmentHash);
				}
			}
			const attachments = new Map<string, Uint8Array>();
			for (const hash of hashes) {
				const blob = yield* attachmentStore
					.get(hash)
					.pipe(
						Effect.catchTag("AttachmentMissing", () =>
							Effect.succeed(undefined),
						),
					);
				if (blob) attachments.set(hash, blob.bytes);
			}
			const first = messages[0];
			if (
				offset >
				(first ? historicalMessageText(first, { attachments }).length : 0)
			)
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
			for (const [index, message] of messages.entries()) {
				if (budget === 0) return { items, nextCursor: message.id };
				const text = historicalMessageText(message, { attachments });
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
			Effect.catch((error) =>
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
