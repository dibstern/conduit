import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { AccountId } from "../../../contracts/account.js";
import { AccountDirectory } from "./account-directory.js";

/** Resolve current bindings in one read, including sessions in cold projects. */
export const resolveSessionAccountIds = (sessionIds: readonly string[]) =>
	Effect.gen(function* () {
		const ids = new Map<string, AccountId | null>();
		if (sessionIds.length === 0) return ids;
		const sql = yield* SqlClient.SqlClient;
		const accounts = yield* AccountDirectory;
		const bindings = yield* sql<{ id: string; account_ref: string }>`
			SELECT session.id, COALESCE(binding.provider, session.provider) AS account_ref
			FROM sessions AS session
			LEFT JOIN session_providers AS binding ON binding.id = (
				SELECT id FROM session_providers
				WHERE session_id = session.id AND status = 'active'
				ORDER BY activated_at DESC, id DESC LIMIT 1
			)
			WHERE session.id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))`;
		for (const binding of bindings) {
			const id = yield* accounts
				.resolve({ _tag: "Id", id: binding.account_ref })
				.pipe(
					Effect.map((account) => account.id),
					Effect.catchTag("AccountUnroutable", () => Effect.succeed(null)),
				);
			ids.set(binding.id, id);
		}
		return ids;
	});
