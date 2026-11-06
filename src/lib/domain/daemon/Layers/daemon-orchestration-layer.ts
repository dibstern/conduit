import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
	Context,
	Effect,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { RunChangesCaptured } from "../../../contracts/stored-event.js";
import * as Failure from "../../../effect/failure-classification.js";
import { ENV } from "../../../env.js";
import { createLogger } from "../../../logger.js";
import { makeUnboundClaudeEventPersistEffect } from "../../../persistence/effect/claude-event-persist-effect.js";
import { makeUnboundCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import {
	EventStoreError,
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../../persistence/effect/event-store-effect.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import { canonicalEvent, EventId } from "../../../persistence/events.js";
import { loadClaudeSdkTestModule } from "../../../provider/claude/claude-sdk-module.js";
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../provider/orchestration-read-model.js";
import { makeProviderCallContextResolver } from "../../../provider/orchestration-wiring.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../provider/provider-session-binding-read-model.js";
import { AttachmentStoreTag } from "../../persistence/Services/attachment-store.js";
import {
	DraftPreWarmLive,
	DraftPreWarmTag,
} from "../../relay/Services/draft-prewarm.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../relay/Services/provider-runtime-ingestion-service.js";
import { makeEventSinkFactory } from "../../relay/Services/provider-turn-dispatch.js";
import { LoggerTag } from "../../relay/Services/services.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../Services/daemon-orchestration.js";
import {
	DaemonStoreAvailability,
	onProjectUnavailable,
} from "../Services/daemon-store-availability.js";
import { FolderTimeline } from "../Services/folder-timeline.js";
import { makeProjectGate } from "../Services/project-registry-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../Services/provider-adapters.js";
import {
	SecretAnswers,
	SecretAnswersLive,
} from "../Services/secret-answers.js";
import { SessionDirectory } from "../Services/session-directory.js";
import { WorktreeServiceTag } from "../Services/worktree-service.js";
import { makeOrphanedClaudePermissions } from "./orphaned-permissions-layer.js";

export const DaemonOrchestrationLive = Layer.effect(
	DaemonOrchestration,
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const secretAnswers = Context.get(
			yield* Layer.build(SecretAnswersLive),
			SecretAnswers,
		);
		const store = yield* PersistenceStore;
		const sql = Context.get(store, SqlClient.SqlClient);
		const adapters = yield* ProviderAdapters;
		const directory = yield* SessionDirectory;
		const accounts = yield* AccountDirectory;
		const configRef = yield* DaemonConfigRefTag;
		const sessionWorkspace = yield* SessionWorkspaceTag;
		const projectGate = yield* makeProjectGate((projectId) =>
			Option.isSome(adapters.projectContext(projectId)),
		);
		const projectOfSession = (sessionId: string) =>
			directory.projectOf(sessionId).pipe(
				Effect.flatMap((owner) =>
					Option.isSome(owner)
						? Effect.succeed(owner.value)
						: Effect.fail(
								new ProviderInstanceFailure({
									providerId: "conduit",
									operation: "resolveProject",
									code: "project_inactive",
									cause: `No registered project owns session ${sessionId}`,
								}),
							),
				),
				Effect.mapError((cause) =>
					cause instanceof ProviderInstanceFailure
						? cause
						: new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "resolveProject",
								cause,
							}),
				),
			);
		const projectServices = (
			sessionId: string,
		): Effect.Effect<
			{
				projectId: string;
				context: Context.Context<ProviderAdapterProjectContext>;
			},
			ProviderInstanceFailure
		> =>
			Effect.gen(function* () {
				const projectId = yield* projectOfSession(sessionId);
				const context = adapters.projectContext(projectId);
				if (Option.isNone(context)) {
					if ((yield* projectGate(projectId)) === "removed")
						return yield* Effect.fail(
							new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "executeCommand",
								code: "project_inactive",
								cause: `Project ${projectId} is no longer registered`,
							}),
						);
					// A project not served (H4) keeps the existing claim while waiting
					// for current services, before intake.
					return yield* Effect.sleep("30 millis").pipe(
						Effect.andThen(projectServices(sessionId)),
					);
				}
				return { projectId, context: context.value };
			});
		const storeFailure = (sessionId: string, cause: unknown) =>
			new EventStoreError({
				operation: "routeProviderOutput",
				sessionId,
				cause,
			});
		const ingestion: Pick<ProviderRuntimeIngestion, "ingest" | "ingestBatch"> =
			{
				ingest: (event, onPrompt) =>
					projectServices(event.sessionId).pipe(
						Effect.mapError((cause) => storeFailure(event.sessionId, cause)),
						Effect.flatMap(({ context }) =>
							Effect.gen(function* () {
								const interactions = yield* makeEventSinkFactory.pipe(
									Effect.provide(context),
								);
								interactions(event.sessionId, event.providerId).noteActivity?.(
									event,
								);
								return yield* Context.get(
									context,
									ProviderRuntimeIngestionTag,
								).ingest(event, onPrompt);
							}),
						),
					),
				ingestBatch: (events, options) =>
					Effect.gen(function* () {
						const first = events[0];
						if (!first) return 0;
						const project = yield* projectServices(first.sessionId).pipe(
							Effect.mapError((cause) => storeFailure(first.sessionId, cause)),
						);
						for (const sessionId of new Set(
							events.map((event) => event.sessionId),
						)) {
							const owner = yield* projectOfSession(sessionId).pipe(
								Effect.mapError((cause) => storeFailure(sessionId, cause)),
							);
							if (owner !== project.projectId)
								return yield* Effect.fail(
									storeFailure(
										sessionId,
										"Provider output batch spans projects",
									),
								);
						}
						return yield* Context.get(
							project.context,
							ProviderRuntimeIngestionTag,
						).ingestBatch(events, options);
					}),
			};
		const unbound = yield* makeUnboundEventStoreEffect.pipe(
			Effect.provide(store),
		);
		const write = (yield* makeUnboundCommitAndSignal.pipe(
			Effect.provideService(UnboundEventStoreEffectTag, unbound),
			Effect.provide(store),
		)).write;
		const persist = yield* makeUnboundClaudeEventPersistEffect.pipe(
			Effect.provideService(UnboundEventStoreEffectTag, unbound),
			Effect.provide(store),
		);
		const read = yield* makeReadQueryEffect.pipe(Effect.provide(store));
		const timeline = yield* Effect.serviceOption(FolderTimeline);
		const events = yield* Effect.serviceOption(SessionEventBusTag);
		if (Option.isSome(timeline) && Option.isSome(events)) {
			const folders = timeline.value;
			const scope = yield* Effect.scope;
			const captureId = (runId: string) =>
				Schema.decodeSync(EventId)(`evt_conduit_run_changes_captured_${runId}`);
			const record =
				(provider: string) =>
				(sessionId: string, capture: RunChangesCaptured) =>
					Effect.gen(function* () {
						const projectId = yield* projectOfSession(sessionId);
						yield* persist.persistEvent(
							canonicalEvent("run.changes_captured", sessionId, capture, {
								provider,
								eventId: captureId(capture.runId),
							}),
							{ projectId },
						);
					});
			// The run-end checkpoint, a joined run's release and a deleted session's captures.
			yield* (yield* events.value.subscribe()).pipe(
				Stream.runForEach((event) => {
					const { runId } = event.metadata;
					if (event.runEnded && runId)
						return folders.runEnded(runId, record(event.provider)).pipe(
							// Captures run beside the bus, which drops events a stalled subscriber misses.
							Effect.forkIn(scope),
							Effect.asVoid,
						);
					if (
						event.type === "run.started" &&
						runId &&
						event.data.requestedRunId !== runId
					)
						return folders.runJoined(event.data.requestedRunId);
					if (event.type === "session.deleted")
						return Effect.forEach(
							[event.sessionId, ...(event.data.childSessionIds ?? [])],
							folders.forget,
							{ discard: true },
						).pipe(
							// Forgetting waits for the session's own capture, not other sessions' run ends.
							Effect.forkIn(scope),
							Effect.asVoid,
						);
					return Effect.void;
				}),
				Effect.forkScoped,
			);
			// Captures a restart interrupted. CONTRACT.md 8.3 (2849-2853) names the
			// Run Ledger's liveness readers and not this one; its nearest reading is
			// the ledger's active run: a pinned run it no longer holds has ended.
			yield* folders.recover(
				(sessionId, runId) =>
					Effect.gen(function* () {
						const done = yield* sql`
							SELECT 1 FROM events WHERE event_id = ${captureId(runId)}
							UNION ALL
							SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = 'session.deleted'
							LIMIT 1`;
						if (done.length > 0) return "done" as const;
						const view = yield* loadLedgerView(sessionId);
						if (!view) return "done" as const;
						return view.active?.runId === runId
							? ("running" as const)
							: ("ended" as const);
					}).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.catchCause((cause) =>
							Effect.logWarning("Capture recovery could not read the run", {
								runId,
								cause,
							}).pipe(Effect.as("running" as const)),
						),
					),
				(sessionId, capture) =>
					Effect.gen(function* () {
						const [session] = yield* sql<{ readonly provider: string }>`
							SELECT provider FROM sessions WHERE id = ${sessionId}`;
						if (session) yield* record(session.provider)(sessionId, capture);
					}),
			);
			// Head moves with files a restart cut off mid-apply (82tn.53): a move journalled started
			// keeps its files; any other is rolled back.
			yield* folders.recoverRestores((_sessionId, moveId) =>
				sql`SELECT 1 FROM events WHERE type = 'head.move_started'
					AND json_extract(data, '$.moveId') = ${moveId} LIMIT 1`.pipe(
					Effect.map((rows) => rows.length > 0),
					Effect.catchCause((cause) =>
						Effect.logWarning("Restore recovery could not read the move", {
							moveId,
							cause,
						}).pipe(Effect.as(true)),
					),
				),
			);
		}
		// Worktrees a fork with files made before a restart cut it off (82tn.54): kept when a session's
		// workspace names one, else rolled back. CONTRACT.md 2849-2854 has every liveness reader ask
		// anythingMayAct; nearest reading: a worktree no session's workspace names has no Run that
		// could act in it, so this asks no Run Ledger.
		const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
		if (Option.isSome(worktrees))
			yield* worktrees.value.recoverHeld((created) =>
				sql`SELECT 1 FROM sessions s, json_each(
						CASE WHEN json_valid(s.workspace) THEN s.workspace ELSE '{}' END, '$.worktrees') w
					WHERE w.value IN ${sql.in(Object.values(created.worktrees))} LIMIT 1`.pipe(
					Effect.map((rows) => rows.length > 0),
				),
			);
		const bindings = new SqliteProviderSessionBindingReadModel(sql);
		const resolveCallContext = yield* makeProviderCallContextResolver({
			sessionBindingReadModel: bindings,
			sessionWorkspace,
			shellEnv: () => ({ env: {}, declared: {} }),
		}).pipe(Effect.provideService(ReadQueryEffectTag, read));
		const beforeStopAcceptance = (yield* loadClaudeSdkTestModule.pipe(
			Effect.orDie,
		))?.beforeStopAcceptance;
		const engine = new OrchestrationEngine({
			...(beforeStopAcceptance && {
				beforeStopAcceptance: (input) =>
					Effect.tryPromise({
						try: () => beforeStopAcceptance(input),
						catch: (cause) =>
							new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "acceptStop",
								cause,
							}),
					}),
			}),
			registry: adapters.registry,
			attachmentStore: Context.get(store, AttachmentStoreTag),
			secretAnswers,
			autoSettleAfterDays: Ref.get(configRef).pipe(
				Effect.map((config) => config.autoSettleAfterDays),
			),
			accountDirectory: accounts,
			sessionBindingReadModel: bindings,
			resolveCallContext,
			projectOfSession,
			durableCommands: {
				sql,
				projectContext: adapters.projectContext,
				snapshot: yield* new CommandReadModelRepository(sql)
					.bootstrap()
					.pipe(Effect.orDie),
				now: () => Date.now(),
				generateId: () => `disp_${randomUUID()}`,
				ingestion,
				write,
				projectGate,
				recoverDetachedSession: adapters.recoverDetachedSession,
				makeInteractions: (sessionId, driver) =>
					projectServices(sessionId).pipe(
						Effect.flatMap(({ context }) =>
							makeEventSinkFactory.pipe(Effect.provide(context)),
						),
						Effect.map((make) => make(sessionId, driver)),
					),
				persistUserMessage: persist.persistUserMessage,
				...(adapters.claudeSessionForkSdk && {
					claudeSessionForkSdk: adapters.claudeSessionForkSdk,
				}),
				...(Option.isSome(timeline)
					? { runStarted: timeline.value.runStarted }
					: {}),
			},
		});
		yield* Effect.addFinalizer(() => engine.shutdownEffect());
		const drafts = Context.get(
			yield* Layer.build(DraftPreWarmLive).pipe(
				Effect.provideService(ProviderRegistryTag, adapters.registry),
				Effect.provideService(LoggerTag, createLogger("draft-prewarm")),
			),
			DraftPreWarmTag,
		);
		yield* onProjectUnavailable(
			yield* DaemonStoreAvailability,
			drafts.discardProject,
		);
		const clearOrphanedAsks = yield* makeOrphanedClaudePermissions;
		let started = false;
		return {
			engine,
			drafts,
			start: Effect.gen(function* () {
				yield* adapters.recover;
				if (started) return;
				started = true;
				// Before the outbox drains, as relay start cleared them before its command gate opened.
				yield* clearOrphanedAsks;
				channel("conduit.orchestration.engine").publish({
					event: "drain-started",
					engine,
				});
				yield* engine.drainSideEffects().pipe(
					Effect.catchCause((cause) =>
						Failure.isInterruptedOnly(cause)
							? Effect.interrupt
							: Effect.logError("Provider command outbox drain failed", cause),
					),
					Effect.forkIn(scope),
					Effect.repeat(Schedule.spaced(ENV.outboxDrainIntervalMs)),
					Effect.forkIn(scope),
				);
			}),
		};
	}),
);
