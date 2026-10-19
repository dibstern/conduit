import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeProviderStateEffect } from "../../src/lib/persistence/effect/provider-state-effect.js";

export const readNativeThread = (
	filename: string,
	sessionId: string,
	instanceId = "claude",
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [owner] = yield* sql<{
				project_id: string;
			}>`SELECT project_id FROM events WHERE session_id = ${sessionId} LIMIT 1`;
			if (!owner) return undefined;
			const state = yield* makeProviderStateEffect.pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: owner.project_id,
				}),
			);
			return yield* state.nativeThread(sessionId, instanceId);
		}).pipe(
			Effect.provide(
				SqliteClient.layer({ filename, readonly: true, disableWAL: true }),
			),
		),
	);
