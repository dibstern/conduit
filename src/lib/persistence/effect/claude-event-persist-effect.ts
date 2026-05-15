import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../events.js";
import type { EventStoreError } from "./event-store-effect.js";
import { EventStoreEffectTag } from "./event-store-effect.js";
import type { ProjectionRunnerError } from "./projection-runner-effect.js";
import { ProjectionRunnerEffectTag } from "./projection-runner-effect.js";

export class ClaudeEventPersistEffectError extends Data.TaggedError(
	"ClaudeEventPersistEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ClaudeEventPersistEffect {
	readonly persistEvent: (
		event: CanonicalEvent,
	) => Effect.Effect<void, ClaudeEventPersistEffectError>;

	readonly persistUserMessage: (
		sessionId: string,
		text: string,
	) => Effect.Effect<void, ClaudeEventPersistEffectError>;

	readonly persistClaudeSubagent: (input: {
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
		readonly events: readonly CanonicalEvent[];
	}) => Effect.Effect<void, ClaudeEventPersistEffectError>;
}

export class ClaudeEventPersistEffectTag extends Context.Tag(
	"ClaudeEventPersistEffect",
)<ClaudeEventPersistEffectTag, ClaudeEventPersistEffect>() {}

type PersistFailure = EventStoreError | ProjectionRunnerError | SqlError;

export const makeClaudeEventPersistEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const eventStore = yield* EventStoreEffectTag;
	const projectionRunner = yield* ProjectionRunnerEffectTag;

	const withSql = <A, E>(
		effect: Effect.Effect<A, E, SqlClient.SqlClient>,
	): Effect.Effect<A, E> =>
		effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

	const ensureRecovered = (): Effect.Effect<void, PersistFailure> =>
		Effect.gen(function* () {
			const recovered = yield* projectionRunner.isRecovered();
			if (!recovered) {
				yield* withSql(projectionRunner.recover()).pipe(Effect.asVoid);
			}
		});

	const ensureSession = (
		sessionId: string,
		provider: string,
		opts?: { parentId?: string; providerSessionId?: string },
	): Effect.Effect<void, SqlError> => {
		const now = Date.now();
		return sql`
			INSERT OR IGNORE INTO sessions
			(id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
			VALUES (${sessionId}, ${provider}, ${opts?.providerSessionId ?? null}, 'Untitled', 'idle', ${opts?.parentId ?? null}, ${now}, ${now})`.pipe(
			Effect.asVoid,
		);
	};

	const projectEvent = (
		stored: StoredEvent,
	): Effect.Effect<void, ProjectionRunnerError | SqlError> =>
		withSql(projectionRunner.projectEvent(stored));

	const projectBatch = (
		stored: readonly StoredEvent[],
	): Effect.Effect<void, ProjectionRunnerError | SqlError> =>
		withSql(projectionRunner.projectBatch(stored));

	const mapPersistError =
		(operation: string) =>
		(cause: unknown): ClaudeEventPersistEffectError =>
			cause instanceof ClaudeEventPersistEffectError
				? cause
				: new ClaudeEventPersistEffectError({ operation, cause });

	const persistEvent = (
		event: CanonicalEvent,
	): Effect.Effect<void, ClaudeEventPersistEffectError> =>
		Effect.gen(function* () {
			yield* ensureRecovered();
			yield* ensureSession(event.sessionId, "claude");
			const stored = yield* eventStore.append(event);
			yield* projectEvent(stored);
		}).pipe(Effect.mapError(mapPersistError("persistEvent")));

	const persistUserMessage = (
		sessionId: string,
		text: string,
	): Effect.Effect<void, ClaudeEventPersistEffectError> =>
		Effect.gen(function* () {
			yield* ensureRecovered();
			yield* ensureSession(sessionId, "claude");

			const now = Date.now();
			const userMsgId = crypto.randomUUID();
			const stored = yield* eventStore.appendBatch([
				canonicalEvent(
					"session.created",
					sessionId,
					{
						sessionId,
						title: "Claude Session",
						provider: "claude",
					},
					{ provider: "claude", createdAt: now },
				),
				canonicalEvent(
					"message.created",
					sessionId,
					{
						messageId: userMsgId,
						role: "user",
						sessionId,
					},
					{ provider: "claude", createdAt: now },
				),
				canonicalEvent(
					"text.delta",
					sessionId,
					{
						messageId: userMsgId,
						partId: `${userMsgId}-0`,
						text,
					},
					{ provider: "claude", createdAt: now },
				),
			]);
			yield* projectBatch(stored);
		}).pipe(Effect.mapError(mapPersistError("persistUserMessage")));

	const persistClaudeSubagent: ClaudeEventPersistEffect["persistClaudeSubagent"] =
		(input) =>
			Effect.gen(function* () {
				yield* ensureRecovered();
				yield* ensureSession(input.parentSessionId, "claude");
				yield* ensureSession(input.childSessionId, "claude", {
					parentId: input.parentSessionId,
					providerSessionId: input.providerSessionId,
				});

				const existingRows = yield* sql<{ id: string }>`
					SELECT id FROM messages WHERE session_id = ${input.childSessionId}`;
				const existingMessageIds = new Set(existingRows.map((row) => row.id));
				const events = input.events.filter((event) => {
					const data = event.data as { readonly messageId?: string };
					return (
						data.messageId == null || !existingMessageIds.has(data.messageId)
					);
				});
				const stored = yield* eventStore.appendBatch([
					canonicalEvent(
						"session.created",
						input.childSessionId,
						{
							sessionId: input.childSessionId,
							title: input.title,
							provider: "claude",
							parentId: input.parentSessionId,
							providerSessionId: input.providerSessionId,
						},
						{ provider: "claude" },
					),
					...events,
				]);
				yield* projectBatch(stored);
			}).pipe(Effect.mapError(mapPersistError("persistClaudeSubagent")));

	return {
		persistEvent,
		persistUserMessage,
		persistClaudeSubagent,
	} satisfies ClaudeEventPersistEffect;
});
