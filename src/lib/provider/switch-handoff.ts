import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { HandoffSummary } from "../contracts/limit-recovery.js";
import type { ReadQueryEffect } from "../persistence/effect/read-query-effect.js";
import type { MessageWithParts } from "../persistence/read-model-types.js";
import { buildContextHandoff } from "./context-handoff.js";

/** Every kept message, oldest first: the store is the handoff's only source (ad4c). */
export const readKeptHistory = (read: ReadQueryEffect, sessionId: string) =>
	Effect.gen(function* () {
		const messages: MessageWithParts[] = [];
		let before: string | undefined;
		for (;;) {
			const page = yield* read.readSessionTranscriptPage(sessionId, {
				limit: 50,
				...(before ? { before } : {}),
			});
			messages.unshift(...page.messages);
			if (!page.hasMore) break;
			before = page.messages[0]?.id;
		}
		return messages;
	});

/** The last event a handoff for this input covers: everything before the input itself. */
export const handoffThrough = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	inputId: string | undefined,
) =>
	Effect.map(
		sql<{ through: number }>`SELECT COALESCE(MAX(sequence), 0) AS through
			FROM events WHERE session_id = ${sessionId}
			AND sequence < COALESCE((SELECT MIN(sequence) FROM events
				WHERE session_id = ${sessionId} AND type = 'message.created'
				AND json_extract(data, '$.messageId') = ${inputId ?? null}), 9223372036854775807)`,
		([row]) => row?.through ?? 0,
	);

/** What a fresh full handoff would carry now: the switch confirmation's preview. */
export const previewFreshHandoff = (read: ReadQueryEffect, sessionId: string) =>
	Effect.map(readKeptHistory(read, sessionId), (messages) => {
		const built = buildContextHandoff({ sessionId, messages, prompt: "" });
		return {
			included: built instanceof Error ? 0 : built.included,
			omitted: built instanceof Error ? messages.length : built.omitted,
			firstMessageIncluded:
				built instanceof Error ? false : built.firstUserIncluded,
			tokens: built instanceof Error ? 0 : built.tokens,
			strategy: "fresh",
		} satisfies HandoffSummary;
	});

/**
 * A target that cannot resume a native thread across a switch (Cursor) owes a
 * fresh full handoff once per switch into its account: the latest switch to it
 * that no handoff record has answered yet. Derived from the store alone, so a
 * crash between the switch and the first turn still owes it.
 */
export const planSwitchHandoff = (input: {
	readonly read: ReadQueryEffect;
	readonly sessionId: string;
	readonly instanceId: string;
	readonly inputId: string;
	readonly prompt: string;
}) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const { sessionId, instanceId } = input;
		const [owed] = yield* sql<{
			switched: number | null;
			delivered: number | null;
		}>`SELECT
			(SELECT MAX(sequence) FROM events WHERE session_id = ${sessionId}
				AND type = 'session.provider_changed'
				AND json_extract(data, '$.newProvider') = ${instanceId}
				AND json_extract(data, '$.oldProvider') <> ${instanceId}) AS switched,
			(SELECT MAX(sequence) FROM events WHERE session_id = ${sessionId}
				AND type = 'session.handoff_delivered'
				AND json_extract(data, '$.instanceId') = ${instanceId}) AS delivered`;
		const switchSequence = owed?.switched;
		if (switchSequence == null || (owed?.delivered ?? 0) > switchSequence)
			return undefined;
		const history = yield* readKeptHistory(input.read, sessionId);
		const current = history.findIndex(({ id }) => id === input.inputId);
		const messages = current < 0 ? history : history.slice(0, current);
		const built = buildContextHandoff({
			sessionId,
			messages,
			prompt: input.prompt,
		});
		if (built instanceof Error) return yield* built;
		return {
			switchSequence,
			text: built.text,
			summary: {
				included: built.included,
				omitted: built.omitted,
				firstMessageIncluded: built.firstUserIncluded,
				tokens: built.tokens,
				strategy: "fresh" as const,
				afterSequence: 0,
				throughSequence: yield* handoffThrough(sql, sessionId, input.inputId),
				instanceId,
			},
		};
	});
