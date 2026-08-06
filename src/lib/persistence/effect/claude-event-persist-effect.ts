import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect, Schema } from "effect";
import {
	type CanonicalEvent,
	canonicalEvent,
	EventId,
	type StoredEvent,
} from "../events.js";
import { makeCommitAndSignal } from "./commit-and-signal.js";
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

export class ClaudeSessionLifecycleError extends Data.TaggedError(
	"ClaudeSessionLifecycleError",
)<{
	readonly operation:
		| "persistEvent"
		| "persistEvents"
		| "persistUserMessage"
		| "ensureClaudeSubagentSession";
	readonly sessionId: string;
	readonly role: "existing-session" | "subagent-parent" | "subagent-child";
	readonly reason: "missing-session" | "conflicting-subagent-session";
}> {}

export type ClaudeEventPersistFailure =
	| ClaudeEventPersistEffectError
	| ClaudeSessionLifecycleError;

export interface ClaudeEventPersistEffect {
	readonly persistEvent: (
		event: CanonicalEvent,
		options?: { readonly publish?: boolean },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistEvents: (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistUserMessage: (
		sessionId: string,
		text: string,
		options?: { readonly publish?: boolean },
	) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly persistClaudeSubagent: (input: {
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
		readonly events: readonly CanonicalEvent[];
	}) => Effect.Effect<void, ClaudeEventPersistFailure>;

	readonly ensureClaudeSubagentSession: (input: {
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
	}) => Effect.Effect<void, ClaudeEventPersistFailure>;
}

export class ClaudeEventPersistEffectTag extends Context.Tag(
	"ClaudeEventPersistEffect",
)<ClaudeEventPersistEffectTag, ClaudeEventPersistEffect>() {}

type PersistFailure = EventStoreError | ProjectionRunnerError | SqlError;
type ExistingMessagePart = {
	readonly id: string;
	readonly text: string | null;
	readonly status: string | null;
};

/**
 * Terminal events that may act on an existing read-model session without a
 * durable lifecycle root. Keep this list narrow: content events must prove
 * canonical creation or an active provider binding before persistence.
 */
const LIFECYCLE_ROOT_OPTIONAL_EVENT_TYPES: ReadonlySet<CanonicalEvent["type"]> =
	new Set(["session.deleted"]);

function claudeSubagentSessionCreatedEventId(childSessionId: string): EventId {
	return Schema.decodeSync(EventId)(
		`evt_claude_subagent_session_created_${childSessionId}`,
	);
}

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

	const seedClaudeSubagentSession = (input: {
		readonly childSessionId: string;
		readonly parentSessionId: string;
		readonly providerSessionId: string;
		readonly title: string;
	}): Effect.Effect<void, SqlError> => {
		const now = Date.now();
		return sql`
			INSERT OR IGNORE INTO sessions
			(id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
			VALUES (${input.childSessionId}, 'claude', ${input.providerSessionId}, ${input.title}, 'idle', ${input.parentSessionId}, ${now}, ${now})`.pipe(
			Effect.asVoid,
		);
	};

	const requireSession = (
		sessionId: string,
		operation: ClaudeSessionLifecycleError["operation"],
		role: ClaudeSessionLifecycleError["role"],
	): Effect.Effect<void, SqlError | ClaudeSessionLifecycleError> =>
		sql<{ readonly id: string }>`
			SELECT sessions.id
			FROM sessions
			WHERE sessions.id = ${sessionId}
				AND (
					EXISTS (
						SELECT 1
						FROM events
						WHERE events.session_id = sessions.id
							AND events.type = 'session.created'
					)
					OR EXISTS (
						SELECT 1
						FROM session_providers
						WHERE session_providers.session_id = sessions.id
							AND session_providers.status = 'active'
					)
				)
			LIMIT 1
		`.pipe(
			Effect.flatMap((rows) =>
				rows.length > 0
					? Effect.void
					: Effect.fail(
							new ClaudeSessionLifecycleError({
								operation,
								sessionId,
								role,
								reason: "missing-session",
							}),
						),
			),
		);

	const requireReadModelSession = (
		sessionId: string,
		operation: ClaudeSessionLifecycleError["operation"],
		role: ClaudeSessionLifecycleError["role"],
	): Effect.Effect<void, SqlError | ClaudeSessionLifecycleError> =>
		sql<{ readonly id: string }>`
			SELECT id FROM sessions WHERE id = ${sessionId} LIMIT 1
		`.pipe(
			Effect.flatMap((rows) =>
				rows.length > 0
					? Effect.void
					: Effect.fail(
							new ClaudeSessionLifecycleError({
								operation,
								sessionId,
								role,
								reason: "missing-session",
							}),
						),
			),
		);

	const projectEvent = (
		stored: StoredEvent,
	): Effect.Effect<void, ProjectionRunnerError | SqlError> =>
		withSql(projectionRunner.projectEvent(stored));

	const projectBatch = (
		stored: readonly StoredEvent[],
	): Effect.Effect<void, ProjectionRunnerError | SqlError> =>
		withSql(projectionRunner.projectBatch(stored));
	const commitAndSignal = yield* makeCommitAndSignal;

	const mapPersistError =
		(operation: string) =>
		(cause: unknown): ClaudeEventPersistFailure =>
			cause instanceof ClaudeEventPersistEffectError ||
			cause instanceof ClaudeSessionLifecycleError
				? cause
				: new ClaudeEventPersistEffectError({ operation, cause });

	const persistEvent = (
		event: CanonicalEvent,
		options?: { readonly publish?: boolean },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			yield* ensureRecovered();
			yield* LIFECYCLE_ROOT_OPTIONAL_EVENT_TYPES.has(event.type)
				? requireReadModelSession(
						event.sessionId,
						"persistEvent",
						"existing-session",
					)
				: requireSession(event.sessionId, "persistEvent", "existing-session");
			yield* commitAndSignal([event], options);
		}).pipe(Effect.mapError(mapPersistError("persistEvent")));

	const persistEvents = (
		events: readonly CanonicalEvent[],
		options?: { readonly publish?: boolean },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			if (events.length === 0) return;
			yield* ensureRecovered();
			for (const sessionId of new Set(events.map((event) => event.sessionId))) {
				yield* requireSession(sessionId, "persistEvents", "existing-session");
			}
			yield* commitAndSignal(events, options);
		}).pipe(Effect.mapError(mapPersistError("persistEvents")));

	const persistUserMessage = (
		sessionId: string,
		text: string,
		options?: { readonly publish?: boolean },
	): Effect.Effect<void, ClaudeEventPersistFailure> =>
		Effect.gen(function* () {
			yield* ensureRecovered();
			yield* requireSession(
				sessionId,
				"persistUserMessage",
				"existing-session",
			);

			const now = Date.now();
			const userMsgId = crypto.randomUUID();
			yield* commitAndSignal(
				[
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
				],
				options,
			);
		}).pipe(Effect.mapError(mapPersistError("persistUserMessage")));

	const ensureClaudeSubagentSession: ClaudeEventPersistEffect["ensureClaudeSubagentSession"] =
		(input) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						yield* ensureRecovered();
						yield* requireSession(
							input.parentSessionId,
							"ensureClaudeSubagentSession",
							"subagent-parent",
						);
						const existingChildRows = yield* sql<{
							provider: string;
							parent_id: string | null;
							provider_sid: string | null;
						}>`
							SELECT provider, parent_id, provider_sid
							FROM sessions
							WHERE id = ${input.childSessionId}
							LIMIT 1`;
						const existingChild = existingChildRows[0];
						if (!existingChild) {
							yield* seedClaudeSubagentSession(input);
						} else if (
							existingChild.provider !== "claude" ||
							existingChild.parent_id !== input.parentSessionId ||
							existingChild.provider_sid !== input.providerSessionId
						) {
							return yield* Effect.fail(
								new ClaudeSessionLifecycleError({
									operation: "ensureClaudeSubagentSession",
									sessionId: input.childSessionId,
									role: "subagent-child",
									reason: "conflicting-subagent-session",
								}),
							);
						}

						const event = canonicalEvent(
							"session.created",
							input.childSessionId,
							{
								sessionId: input.childSessionId,
								title: input.title,
								provider: "claude",
								parentId: input.parentSessionId,
								providerSessionId: input.providerSessionId,
							},
							{
								eventId: claudeSubagentSessionCreatedEventId(
									input.childSessionId,
								),
								provider: "claude",
							},
						);
						const dataJson = JSON.stringify(event.data);
						const metadataJson = JSON.stringify(event.metadata);

						const rows = yield* sql<{
							sequence: number;
							stream_version: number;
						}>`
					INSERT OR IGNORE INTO events (
						event_id, session_id, stream_version, type, data, metadata, provider, created_at
					)
					SELECT
						${event.eventId},
						${event.sessionId},
						COALESCE(MAX(stream_version) + 1, 0),
						${event.type},
						${dataJson},
						${metadataJson},
						${event.provider},
						${event.createdAt}
					FROM events
					WHERE session_id = ${event.sessionId}
					RETURNING sequence, stream_version`;

						const row = rows[0];
						if (!row) return;

						const stored: StoredEvent = {
							...event,
							sequence: row.sequence,
							streamVersion: row.stream_version,
						};
						yield* projectEvent(stored);
					}),
				)
				.pipe(Effect.mapError(mapPersistError("ensureClaudeSubagentSession")));

	const persistClaudeSubagent: ClaudeEventPersistEffect["persistClaudeSubagent"] =
		(input) =>
			Effect.gen(function* () {
				yield* ensureClaudeSubagentSession(input);

				const existingRows = yield* sql<{ id: string }>`
					SELECT id FROM messages WHERE session_id = ${input.childSessionId}`;
				const existingMessageIds = new Set(existingRows.map((row) => row.id));
				const existingPartRows = yield* sql<ExistingMessagePart>`
					SELECT id, text, status FROM message_parts
					WHERE message_id IN (
						SELECT id FROM messages WHERE session_id = ${input.childSessionId}
					)`;
				const existingParts = new Map(
					existingPartRows.map((row) => [row.id, row]),
				);
				const events = filterExistingSubagentEvents(
					input.events,
					existingMessageIds,
					existingParts,
				);
				const stored = yield* eventStore.appendBatch(events);
				yield* projectBatch(stored);
			}).pipe(Effect.mapError(mapPersistError("persistClaudeSubagent")));

	return {
		persistEvent,
		persistEvents,
		persistUserMessage,
		ensureClaudeSubagentSession,
		persistClaudeSubagent,
	} satisfies ClaudeEventPersistEffect;
});

function filterExistingSubagentEvents(
	events: readonly CanonicalEvent[],
	existingMessageIds: ReadonlySet<string>,
	existingParts: ReadonlyMap<string, ExistingMessagePart>,
): CanonicalEvent[] {
	const filtered: CanonicalEvent[] = [];
	for (const event of events) {
		const next = filterExistingSubagentEvent(
			event,
			existingMessageIds,
			existingParts,
		);
		if (next) filtered.push(next);
	}
	return filtered;
}

function filterExistingSubagentEvent(
	event: CanonicalEvent,
	existingMessageIds: ReadonlySet<string>,
	existingParts: ReadonlyMap<string, ExistingMessagePart>,
): CanonicalEvent | undefined {
	if (
		event.type === "message.created" &&
		existingMessageIds.has(event.data.messageId)
	) {
		return undefined;
	}

	if (event.type === "text.delta" || event.type === "thinking.delta") {
		const existingText = existingParts.get(event.data.partId)?.text ?? "";
		if (existingText.length === 0) return event;
		if (!event.data.text.startsWith(existingText)) return undefined;
		const suffix = event.data.text.slice(existingText.length);
		if (suffix.length === 0) return undefined;
		return {
			...event,
			data: {
				...event.data,
				text: suffix,
			},
		} as CanonicalEvent;
	}

	if (
		(event.type === "thinking.start" || event.type === "tool.started") &&
		existingParts.has(event.data.partId)
	) {
		return undefined;
	}

	if (
		event.type === "tool.completed" &&
		existingParts.get(event.data.partId)?.status === "completed"
	) {
		return undefined;
	}

	return event;
}
