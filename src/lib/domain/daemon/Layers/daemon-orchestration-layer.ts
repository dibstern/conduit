import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { Context, Effect, HashMap, Layer, Option, Ref, Schedule } from "effect";
import { SqlClient } from "effect/sql";
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
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../provider/orchestration-read-model.js";
import { makeProviderCallContextResolver } from "../../../provider/orchestration-wiring.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../provider/provider-session-binding-read-model.js";
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
import { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../Services/daemon-orchestration.js";
import {
	DaemonStoreAvailability,
	onProjectUnavailable,
} from "../Services/daemon-store-availability.js";
import {
	ProjectRegistryTag,
	ProjectSaveLockTag,
} from "../Services/project-registry-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../Services/provider-adapters.js";
import { SessionDirectory } from "../Services/session-directory.js";

export const DaemonOrchestrationLive = Layer.effect(
	DaemonOrchestration,
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const store = yield* PersistenceStore;
		const sql = Context.get(store, SqlClient.SqlClient);
		const adapters = yield* ProviderAdapters;
		const directory = yield* SessionDirectory;
		const accounts = yield* AccountDirectory;
		const configRef = yield* DaemonConfigRefTag;
		const sessionWorkspace = yield* SessionWorkspaceTag;
		const projects = yield* ProjectRegistryTag;
		const projectSaveLock = yield* ProjectSaveLockTag;
		const unavailable = yield* DaemonStoreAvailability;
		const isProjectReady = (projectId: string) =>
			Effect.gen(function* () {
				// EndSession retains its admitted project after session.deleted.
				const entry = HashMap.get(yield* Ref.get(projects), projectId);
				if (Option.isNone(entry)) {
					// Import commits before SaveProject publishes registration. A
					// busy save lock leaves that owner's new rows pending meanwhile.
					const settled = yield* projectSaveLock.withPermitsIfAvailable(1)(
						Ref.get(projects),
					);
					if (Option.isNone(settled) || HashMap.has(settled.value, projectId))
						return false;
				}
				const registered = Option.isSome(entry);
				if (
					!registered ||
					unavailable.has(projectId) ||
					entry.value._tag === "Error"
				)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: "conduit",
							operation: "executeCommand",
							code: registered ? "project_unavailable" : "project_inactive",
							cause: registered
								? `Project ${projectId} is unavailable`
								: `Project ${projectId} is no longer registered`,
						}),
					);
				return Option.isSome(adapters.projectContext(projectId));
			});
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
					yield* isProjectReady(projectId);
					// A relay can detach after the command's readiness check. Keep
					// the existing claim while waiting for current services, before intake.
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
		const bindings = new SqliteProviderSessionBindingReadModel(sql);
		const resolveCallContext = yield* makeProviderCallContextResolver({
			sessionBindingReadModel: bindings,
			sessionWorkspace,
			shellEnv: () => ({}),
		}).pipe(Effect.provideService(ReadQueryEffectTag, read));
		const engine = new OrchestrationEngine({
			registry: adapters.registry,
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
				isProjectReady,
				recoverDetachedSession: adapters.recoverDetachedSession,
				makeInteractions: (sessionId, driver) =>
					projectServices(sessionId).pipe(
						Effect.flatMap(({ context }) =>
							makeEventSinkFactory.pipe(Effect.provide(context)),
						),
						Effect.map((make) => make(sessionId, driver)),
					),
				persistUserMessage: persist.persistUserMessage,
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
		yield* onProjectUnavailable(unavailable, drafts.discardProject);
		let started = false;
		return {
			engine,
			drafts,
			start: Effect.gen(function* () {
				yield* adapters.recover;
				if (started) return;
				started = true;
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
