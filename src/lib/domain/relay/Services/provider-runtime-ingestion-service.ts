import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import {
	Context,
	Deferred,
	Effect,
	FiberRef,
	Layer,
	Ref,
	Schema,
} from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { makeAppendEventsWithClaudeTurnCosts } from "../../../persistence/effect/claude-event-persist-effect.js";
import {
	type CommitAndSignalProject,
	makeCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import type {
	EventStoreEffectTag,
	EventStoreError,
} from "../../../persistence/effect/event-store-effect.js";
import { readPendingRewindCommit } from "../../../persistence/effect/pending-rewind.js";
import type {
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../persistence/effect/projection-runner-effect.js";
import { isSessionDeleted } from "../../../persistence/effect/session-seeder-effect.js";
import { type CanonicalEvent, EventId } from "../../../persistence/events.js";
import { SESSION_SUBTREE_SQL } from "../../../persistence/projectors/session-handlers.js";
import {
	commitClaudeRunnerOutput,
	createClaudeRunnerPermissionReplies,
	currentClaudeRunnerOutput,
	currentClaudeRunnerPermissionReply,
	ownsClaudeRunnerAttachment,
} from "../../../provider/claude/claude-runner-receipts.js";
import {
	emptyProviderRuntimeDomainMapperState,
	partKey,
	restoreRuntimeToolStart,
	translateProviderRuntimeEventToDomain,
} from "../../../provider/provider-runtime-event-to-domain.js";
import type { TurnSettings } from "../../../provider/turn-settings.js";
import { translateDomainEventToRelay } from "../../../relay/domain-event-to-relay.js";
import type { makeSessionCompactions } from "../../../session/session-compactions.js";
import type { makeSessionRetries } from "../../../session/session-retries.js";
import { tagWithSessionId } from "../../../shared-types.js";
import type { RelayMessage } from "../../../types.js";
import { isRecord } from "../../../utils.js";
import type { UsageService } from "../../daemon/Services/usage.js";
import { ContinuationLive, ContinuationTag } from "./continuation.js";
import { announceBackgroundWork } from "./session-attention.js";
import { sessionPickEvents } from "./session-pick.js";

/** Terminal notifications can update an existing session, but cannot create one. */
export function canSeedSession(event: ProviderRuntimeEvent): boolean {
	switch (event.type) {
		case "session.deleted":
		case "turn.completed":
		case "turn.error":
		case "turn.interrupted":
		case "message.removed":
		case "message.part.removed":
		case "permission.resolved":
		case "question.resolved":
			return false;
		case "session.status":
			return (
				isRecord(event.data) &&
				(event.data["status"] === "busy" || event.data["status"] === "retry")
			);
		case "session.compaction":
			return isRecord(event.data) && event.data["state"] === "started";
		default:
			return true;
	}
}

export type ProviderRuntimeIngestionError =
	| EventStoreError
	| ProjectionRunnerError
	| SqlError;

export interface ProviderRuntimeIngestion {
	readonly ingest: (
		event: ProviderRuntimeEvent,
	) => Effect.Effect<number, ProviderRuntimeIngestionError>;
	readonly ingestBatch: (
		events: readonly ProviderRuntimeEvent[],
		options?: {
			readonly sessionPicks?: ReadonlyMap<string, TurnSettings>;
			readonly publishToBus?: boolean;
			readonly publishToRelay?: boolean;
			readonly beforeCommit?: Effect.Effect<void, SqlError>;
			readonly afterCommit?: Effect.Effect<void>;
		},
	) => Effect.Effect<number, ProviderRuntimeIngestionError>;
	readonly drain: () => Effect.Effect<void>;
}

export class ProviderRuntimeIngestionTag extends Context.Tag(
	"ProviderRuntimeIngestion",
)<ProviderRuntimeIngestionTag, ProviderRuntimeIngestion>() {}

export interface ProviderRuntimeRelayPublisher {
	readonly publish: (message: RelayMessage) => Effect.Effect<void>;
}

export interface ProviderRuntimeIngestionLiveOptions {
	/** Resolve before any permit; the returned writer joins the ingestion receipt commit. */
	readonly workspaceChanged?: (
		event: Extract<ProviderRuntimeEvent, { type: "workspace.changed" }>,
	) => Effect.Effect<
		| ((
				project: CommitAndSignalProject,
		  ) => Effect.Effect<void, EventStoreError>)
		| undefined,
		EventStoreError
	>;
	readonly relayPublisher?: ProviderRuntimeRelayPublisher;
	readonly usage?: Pick<UsageService, "turnEnded">;
	readonly compactions?: Pick<
		ReturnType<typeof makeSessionCompactions>,
		"observe"
	>;
	readonly retries?: Pick<ReturnType<typeof makeSessionRetries>, "observe">;
}

export const makeProviderRuntimeIngestionLive = (
	options: ProviderRuntimeIngestionLiveOptions = {},
): Layer.Layer<
	ProviderRuntimeIngestionTag | ContinuationTag,
	never,
	EventStoreEffectTag | ProjectionRunnerEffectTag | SqlClient.SqlClient
> =>
	Layer.effect(
		ProviderRuntimeIngestionTag,
		Effect.gen(function* () {
			const commitAndSignal = yield* makeCommitAndSignal;
			const appendEvents = yield* makeAppendEventsWithClaudeTurnCosts;
			const sql = yield* SqlClient.SqlClient;
			const continuation = yield* ContinuationTag;
			const services = yield* Effect.context<
				EventStoreEffectTag | ProjectionRunnerEffectTag | SqlClient.SqlClient
			>();
			const mapperStateRef = yield* Ref.make(
				emptyProviderRuntimeDomainMapperState,
			);
			const ingestSemaphore = yield* Effect.makeSemaphore(1);

			const ingestBatch = (
				events: readonly ProviderRuntimeEvent[],
				ingestOptions: {
					readonly sessionPicks?: ReadonlyMap<string, TurnSettings>;
					readonly publishToBus?: boolean;
					readonly publishToRelay?: boolean;
					readonly beforeCommit?: Effect.Effect<void, SqlError>;
					readonly afterCommit?: Effect.Effect<void>;
				} = {},
			): Effect.Effect<number, ProviderRuntimeIngestionError> =>
				Effect.gen(function* () {
					// Slow resolution must hold neither the project commit permit nor the
					// mapper's ingestion permit, so other sessions can keep appending.
					const prepared = yield* Effect.forEach(events, (event) =>
						Effect.gen(function* () {
							if (event.type !== "workspace.changed")
								return { event, record: undefined };
							if (
								yield* isSessionDeleted(event.sessionId).pipe(
									Effect.provideService(SqlClient.SqlClient, sql),
								)
							)
								return { event, record: undefined };
							const path =
								event.data.source === "start"
									? yield* realWorkspacePath(event.data.path).pipe(
											Effect.orElseSucceed(() => event.data.path),
										)
									: event.data.path;
							const normalized = { ...event, data: { ...event.data, path } };
							const record = yield* options.workspaceChanged?.(normalized) ??
								Effect.succeed(undefined);
							return { event: normalized, record };
						}),
					);
					return yield* ingestSemaphore.withPermits(1)(
						Effect.gen(function* () {
							const context = yield* FiberRef.get(currentClaudeRunnerOutput);
							const permissionReply = yield* FiberRef.get(
								currentClaudeRunnerPermissionReply,
							);
							const receipt =
								context && !context.consumed ? context : undefined;
							const currentState = yield* Ref.get(mapperStateRef);
							let nextState = currentState;
							let domainEvents: CanonicalEvent[] = [];
							const seedableSessions = new Set(
								events.filter(canSeedSession).map((event) => event.sessionId),
							);

							for (const { event } of prepared) {
								if (context && event.type === "tool.completed") {
									const data = event.data as { partId?: string };
									const partId =
										data.partId ?? event.providerRefs.providerToolUseId;
									if (
										partId &&
										!nextState.startedToolPartIds.has(partKey(event, partId))
									) {
										const started = yield* sql<{
											message_id: string;
										}>`SELECT p.message_id FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE p.id = ${partId} AND m.session_id = ${event.sessionId} AND p.type = 'tool' LIMIT 1`;
										if (started[0])
											nextState = restoreRuntimeToolStart(
												event,
												nextState,
												partId,
												started[0].message_id,
											);
									}
								}
								const result = translateProviderRuntimeEventToDomain(
									event,
									nextState,
								);
								// The mapper synthesizes a tool.started for an orphan
								// tool.completed so the UI can render something — but an
								// orphan means an upstream translator broke the tool
								// lifecycle (2026-07-15: a phantom "Unknown" tool card).
								// Surface it loudly instead of laundering it silently.
								const synthesized =
									event.type === "tool.completed" &&
									result.events.some(
										(domain) => domain.type === "tool.started",
									);
								if (synthesized) {
									yield* Effect.logWarning(
										"ingress synthesized tool.started for orphan tool.completed — upstream translator emitted completed without started",
									).pipe(
										Effect.annotateLogs({
											providerId: event.providerId,
											sessionId: event.sessionId,
											eventId: event.eventId,
											data: JSON.stringify(event.data),
										}),
									);
								}
								domainEvents.push(...result.events);
								nextState = result.state;
							}

							let appended = true;
							const acceptedLimits: string[] = [];
							const completedAccounts = new Set<string>();
							let skippedLimits = 0;
							const beforeCommit = Effect.gen(function* () {
								yield* ingestOptions.beforeCommit ?? Effect.void;
								if (permissionReply) {
									yield* createClaudeRunnerPermissionReplies(sql);
									yield* sql`INSERT OR REPLACE INTO claude_runner_permission_replies (session_id, request_id, response_json) VALUES (${permissionReply.sessionId}, ${permissionReply.requestId}, ${JSON.stringify(permissionReply.response)})`;
								}
								if (options.usage)
									for (const event of events) {
										if (
											event.providerId !== "claude" ||
											(event.type !== "turn.completed" &&
												event.type !== "turn.error" &&
												event.type !== "turn.interrupted")
										)
											continue;
										// After an auto-switch this reads the new account; the old one's
										// limit is already known and the 5-minute sampler catches up.
										const [session] = yield* sql<{ provider: string }>`
											SELECT provider FROM sessions WHERE id = ${event.sessionId}
										`.pipe(
											Effect.catchAll((error) =>
												Effect.logWarning(
													"Could not refresh usage after turn",
													error,
												).pipe(Effect.as([])),
											),
										);
										if (session?.provider)
											completedAccounts.add(session.provider);
									}
							});
							const afterCommit = Effect.gen(function* () {
								if (appended) {
									yield* Ref.set(mapperStateRef, nextState);
									if (options.usage)
										for (const accountId of completedAccounts)
											yield* options.usage.turnEnded(accountId);
									for (const sessionId of acceptedLimits)
										yield* continuation.queueLimitPolicy(sessionId);
									yield* ingestOptions.afterCommit ?? Effect.void;
								}
								if (receipt) {
									receipt.consumed = true;
									yield* Deferred.succeed(receipt.committed, undefined);
									if (appended) receipt.onCommitted?.();
								}
							});
							const commitOptions = {
								publish: ingestOptions.publishToBus ?? true,
								afterCommit,
							};
							yield* commitAndSignal
								.write(
									(project) =>
										Effect.gen(function* () {
											// Claim inside the append transaction, before event IDs or
											// projections are written. Replayed and fenced frames are no-ops.
											if (context && (receipt || context.attachmentId))
												appended = receipt
													? yield* commitClaudeRunnerOutput(sql, receipt)
													: yield* ownsClaudeRunnerAttachment(sql, context);
											if (!appended) return;
											// Check under the same write permit and transaction as local
											// deletion. Neither seeding nor publication may revive a deletion.
											const sessionIds = new Set(
												domainEvents.map((event) => event.sessionId),
											);
											for (const { event, record } of prepared)
												if (record) sessionIds.add(event.sessionId);
											for (const event of domainEvents)
												if (
													event.type === "session.created" &&
													event.data.parentId
												)
													sessionIds.add(event.data.parentId);
											const deleted = new Set<string>();
											for (const id of sessionIds)
												if (yield* isSessionDeleted(id)) deleted.add(id);
											const ids = JSON.stringify(
												domainEvents.map((event) => event.sessionId),
											);
											const existing = new Set(
												(yield* sql<{ id: string }>`
										SELECT id FROM sessions WHERE id IN (SELECT value FROM json_each(${ids}))`).map(
													(row) => row.id,
												),
											);
											const accepted: CanonicalEvent[] = [];
											const pickedSessions = new Set<string>();
											for (let event of domainEvents) {
												if (deleted.has(event.sessionId)) continue;
												// A committed rewind already removed these messages locally.
												// Ignore OpenCode's later removals and stale content/backfills.
												if (
													"messageId" in event.data &&
													typeof event.data.messageId === "string"
												) {
													const [removed] = yield* sql<{
														message_id: string;
													}>`SELECT message_id
														FROM message_tombstones WHERE session_id = ${event.sessionId}
														AND message_id = ${event.data.messageId}`;
													if (removed) continue;
												}
												if (
													event.type === "session.created" &&
													event.data.parentId &&
													deleted.has(event.data.parentId)
												) {
													// A child discovered after cascading deletion belongs to that
													// deletion too. Keep its tombstone for parentless late events.
													event = {
														...event,
														eventId: Schema.decodeSync(EventId)(
															`evt_parent_deleted_session_${event.sessionId}`,
														),
														type: "session.deleted",
														data: { sessionId: event.sessionId },
													};
												}
												if (
													!existing.has(event.sessionId) &&
													!seedableSessions.has(event.sessionId) &&
													event.type !== "session.deleted"
												)
													continue;
												if (event.type === "session.deleted") {
													deleted.add(event.sessionId);
													const subtree = yield* sql.unsafe<{ id: string }>(
														SESSION_SUBTREE_SQL,
														[event.sessionId],
													);
													for (const row of subtree) deleted.add(row.id);
													for (const previous of accepted)
														if (
															previous.type === "session.created" &&
															previous.data.parentId &&
															deleted.has(previous.data.parentId)
														)
															deleted.add(previous.sessionId);
												}
												accepted.push(event);
												if (
													event.type === "session.created" &&
													!existing.has(event.sessionId) &&
													!pickedSessions.has(event.sessionId)
												) {
													const pick = ingestOptions.sessionPicks?.get(
														event.sessionId,
													);
													if (pick) {
														accepted.push(
															...sessionPickEvents(event.sessionId, pick),
														);
														pickedSessions.add(event.sessionId);
													}
												}
											}
											domainEvents = accepted;
											// Started compactions and retries ride transient shell status;
											// their outcomes persist so they survive reloads.
											const persistentEvents = accepted.filter(
												(event) =>
													!(
														event.type === "session.compaction" &&
														event.data.state === "started"
													) &&
													!(
														event.type === "session.status" &&
														event.data.status === "retry"
													),
											);
											// Content for an unseen session needs a row for FK projection.
											// Explicit creation belongs to the session projector; deletion
											// and terminal-only notifications never need a seed.
											const createdHere = new Set(
												persistentEvents
													.filter((event) => event.type === "session.created")
													.map((event) => event.sessionId),
											);
											const needsSessionRow = new Map<string, string>();
											for (const event of persistentEvents) {
												if (
													event.type !== "session.deleted" &&
													!createdHere.has(event.sessionId)
												)
													needsSessionRow.set(event.sessionId, event.provider);
											}
											for (const [sessionId, provider] of needsSessionRow) {
												const seededAt = Date.now();
												yield* sql`INSERT OR IGNORE INTO sessions
											(id, provider, title, status, created_at, updated_at)
											VALUES (${sessionId}, ${provider}, 'Untitled', 'idle', ${seededAt}, ${seededAt})`;
											}
											for (const { event, record } of prepared)
												if (!deleted.has(event.sessionId))
													yield* record?.(project) ?? Effect.void;
											let pending: CanonicalEvent[] = [];
											const rewoundMessageIds = new Set<string>();
											for (const event of persistentEvents) {
												if (
													"messageId" in event.data &&
													typeof event.data.messageId === "string" &&
													rewoundMessageIds.has(event.data.messageId)
												) {
													domainEvents = domainEvents.filter(
														(candidate) => candidate.eventId !== event.eventId,
													);
													continue;
												}
												if (event.type === "message.removed") {
													// Include prior content in this same batch before computing the
													// cut. Upstream removal means the provider committed its tail.
													if (pending.length > 0) {
														yield* project(yield* appendEvents(pending));
														pending = [];
													}
													const rewind = yield* readPendingRewindCommit(
														sql,
														event.sessionId,
														event.data.messageId,
													);
													if (rewind) {
														const events = rewind.events.map((removal) => {
															if (removal.type !== "message.removed")
																return removal;
															rewoundMessageIds.add(removal.data.messageId);
															return removal.data.messageId ===
																event.data.messageId
																? event
																: removal;
														});
														yield* project(yield* appendEvents(events));
														domainEvents = domainEvents.flatMap((candidate) =>
															candidate.eventId === event.eventId
																? events
																: [candidate],
														);
														continue;
													}
												}
												if (event.type === "session.usage_limited") {
													if (pending.length > 0) {
														yield* project(yield* appendEvents(pending));
														pending = [];
													}
													if (yield* continuation.intakeLimit(event, project))
														acceptedLimits.push(event.sessionId);
													else skippedLimits++;
												} else pending.push(event);
											}
											if (pending.length > 0)
												yield* project(yield* appendEvents(pending));
											yield* beforeCommit;
										}),
									commitOptions,
								)
								.pipe(Effect.provideService(SqlClient.SqlClient, sql));
							if (!appended) return 0;

							// A compaction in progress and a retry live in memory, not the
							// log (C1). Stamp their rows so the shell re-reads them.
							yield* Effect.forEach(
								new Set([
									...(options.compactions?.observe(domainEvents) ?? []),
									...(options.retries?.observe(domainEvents) ?? []),
								]),
								announceBackgroundWork,
								{ discard: true },
							).pipe(
								Effect.provide(services),
								Effect.catchAllCause((cause) =>
									Effect.logWarning(
										"failed to announce transient status",
										cause,
									),
								),
							);

							if (
								options.relayPublisher &&
								ingestOptions.publishToRelay !== false
							) {
								yield* publishRelayMessages(
									domainEvents,
									options.relayPublisher,
								);
							}

							return domainEvents.length - skippedLimits;
						}),
					);
				});

			return {
				ingest: (event) => ingestBatch([event]),
				ingestBatch,
				drain: () => Effect.void,
			} satisfies ProviderRuntimeIngestion;
		}),
	).pipe(
		// Suspended: this module sits on an import cycle back through ContinuationLive, so the eager export below would read it before it is initialised.
		Layer.provideMerge(Layer.suspend(() => ContinuationLive)),
	);

export const ProviderRuntimeIngestionLive = makeProviderRuntimeIngestionLive();

function publishRelayMessages(
	events: readonly CanonicalEvent[],
	publisher: ProviderRuntimeRelayPublisher,
): Effect.Effect<void> {
	return Effect.forEach(
		events,
		(event) => {
			const translated = translateDomainEventToRelay(event);
			if (translated.kind === "silent") return Effect.void;
			return Effect.forEach(
				translated.messages,
				(message) =>
					publisher.publish(tagWithSessionId(message, event.sessionId)),
				{ discard: true },
			);
		},
		{ discard: true },
	);
}
