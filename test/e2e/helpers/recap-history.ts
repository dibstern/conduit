import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ReplayHarness } from "./e2e-harness.js";

export async function seedPagedRecapTurn(harness: ReplayHarness) {
	const sessionId = harness.projectUrl.split("/").at(-1);
	if (!sessionId) throw new Error("Missing replay session");
	const turnId = "recap-paged-user";
	// Keep the history sentinel above the viewport so automatic paging cannot
	// restore the older prompt before the recap subscription is observed.
	const followUpText = Array.from(
		{ length: 40 },
		(_, index) => `Follow-up detail ${index + 1}.`,
	).join("\n\n");
	// Seed only the isolated replay store. The real detail subscription applies
	// its normal 50-message page. A newer prompt anchors that page, leaving the
	// preceding long turn's prompt above the window.
	await harness.stack.effectRuntime.runtime.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE sessions SET history_complete = 1 WHERE id = ${sessionId}`;
			yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
				VALUES (${turnId}, ${sessionId}, 'completed', ${turnId}, 1)`;
			yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at)
				VALUES (${turnId}, ${sessionId}, ${turnId}, 'user', 'Review the long turn', 1, 1)`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				VALUES ('recap-paged-user-text', ${turnId}, 'text', 'Review the long turn', 0, 1, 1)`;
			for (let i = 0; i < 51; i++) {
				const messageId = `recap-assistant-${String(i).padStart(2, "0")}`;
				yield* sql`INSERT INTO messages (id, session_id, turn_id, role, created_at, updated_at, completed_at)
					VALUES (${messageId}, ${sessionId}, ${turnId}, 'assistant', ${i + 2}, ${i + 2}, ${i + 2})`;
				yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
					VALUES (${`${messageId}-thinking`}, ${messageId}, 'thinking', 'Checking the next step', 0, ${i + 2}, ${i + 2}),
					(${`${messageId}-text`}, ${messageId}, 'text', 'Reviewed the next step', 1, ${i + 2}, ${i + 2})`;
			}
			yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
				VALUES ('recap-next-user', ${sessionId}, 'completed', 'recap-next-user', 100)`;
			yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at)
				VALUES ('recap-next-user', ${sessionId}, 'recap-next-user', 'user', 'Next question', 100, 100)`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				VALUES ('recap-next-user-text', 'recap-next-user', 'text', 'Next question', 0, 100, 100)`;
			yield* sql`INSERT INTO messages (id, session_id, turn_id, role, created_at, updated_at, completed_at)
				VALUES ('recap-next-assistant', ${sessionId}, 'recap-next-user', 'assistant', 101, 102, 102)`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				VALUES ('recap-next-assistant-text', 'recap-next-assistant', 'text', ${followUpText}, 0, 101, 102)`;
		}),
	);
	return { sessionId, turnId };
}
