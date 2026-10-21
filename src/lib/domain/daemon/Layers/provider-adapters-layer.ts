import { existsSync } from "node:fs";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../../contracts/provider-instance.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectError,
	ClaudeEventPersistEffectTag,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	type ProviderStateEffect,
	ProviderStateEffectError,
	ProviderStateEffectTag,
} from "../../../persistence/effect/provider-state-effect.js";
import { makeReadQueryEffect } from "../../../persistence/effect/read-query-effect.js";
import { makeRetireReplacedProcessPrompts } from "../../../persistence/effect/retire-pending-prompts.js";
import { ClaudeDriver } from "../../../provider/claude/claude-provider-instance.js";
import { makeClaudeThreadRead } from "../../../provider/claude/claude-thread-read.js";
import type { ClaudeThreadReadResult } from "../../../provider/claude/types.js";
import { makeCursorProviderRuntime } from "../../../provider/cursor/cursor-provider-runtime.js";
import { OpenCodeDriver } from "../../../provider/opencode-provider-instance.js";
import type { ProviderCallRequest } from "../../../provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../../../provider/provider-session-binding-read-model.js";
import {
	RunnerProviderInstance,
	type RunnerRecoveryDependencies,
} from "../../../provider/runner/runner-provider-instance.js";
import { discoverRunners } from "../../../provider/runner/runner-registry.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import type { ProjectRelayConfig } from "../../../types.js";
import { PendingInteractionServiceTag } from "../../relay/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "../../relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../../relay/Services/services.js";
import { makeProcessingTimeoutHooks } from "../../relay/Services/session-overrides-state.js";
import { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { hasProviderRecoveryCandidate } from "../Services/daemon-session-reader.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapterRecoveryError,
	ProviderAdapters,
} from "../Services/provider-adapters.js";
import { SessionActivityTag } from "../Services/session-activity.js";

/** Adapter lifetime belongs to the daemon; project services are scoped borrows. */
export const makeProviderAdaptersLive = (configDir: string) =>
	Layer.effect(
		ProviderAdapters,
		Effect.gen(function* () {
			const scope = yield* Effect.scope;
			const store = yield* PersistenceStore;
			const sql = Context.get(store, SqlClient.SqlClient);
			const projects = yield* ProjectRegistryTag;
			const unavailable = yield* DaemonStoreAvailability;
			const accounts = yield* AccountDirectory;
			const instances = yield* OpenCodeInstancesTag;
			const activity = yield* SessionActivityTag;
			const registry = new ProviderRegistry();
			// Registering a replacement must wait for the old borrow's detach.
			const projectBorrows = yield* Semaphore.make(1);
			let recovered = false;
			const bindings = new SqliteProviderSessionBindingReadModel(sql);
			const borrowed = new Map<
				string,
				{
					readonly context: Context.Context<ProviderAdapterProjectContext>;
					readonly onBackgroundWorkChanged?: (sessionId: string) => void;
				}
			>();
			const sessionProject = (sessionId: string) =>
				sql<{
					readonly project_id: string;
				}>`SELECT project_id FROM sessions WHERE id = ${sessionId} LIMIT 1`.pipe(
					Effect.map((rows) => rows[0]?.project_id),
				);
			const projectContext = (sessionId: string) =>
				Effect.gen(function* () {
					const projectId = yield* sessionProject(sessionId);
					if (projectId === undefined || unavailable.has(projectId))
						return undefined;
					const current = yield* Ref.get(projects);
					if (!HashMap.has(current, projectId)) return undefined;
					const project = borrowed.get(projectId);
					return project ? { ...project, projectId } : undefined;
				});
			const recoveryForSession = (
				sessionId: string,
			): Effect.Effect<RunnerRecoveryDependencies | undefined> =>
				projectContext(sessionId).pipe(
					Effect.flatMap((project) =>
						Effect.gen(function* () {
							if (!project) return undefined;
							const retire = yield* makeRetireReplacedProcessPrompts.pipe(
								Effect.provide(project.context),
							);
							const engine = Context.get(
								project.context,
								OrchestrationEngineTag,
							);
							const pending = Context.get(
								project.context,
								PendingInteractionServiceTag,
							);
							return {
								projectId: project.projectId,
								ingestion: Context.get(
									project.context,
									ProviderRuntimeIngestionTag,
								),
								pending,
								persist: Context.get(
									project.context,
									ClaudeEventPersistEffectTag,
								),
								timeoutHooks: makeProcessingTimeoutHooks(
									project.context,
									sessionId,
								),
								retirePrompts: (currentProcessId: string | null) =>
									retire(currentProcessId, { sessionId }).pipe(
										Effect.provideService(
											PendingInteractionServiceTag,
											pending,
										),
									),
								resolveCallContext: (request: ProviderCallRequest) =>
									engine.resolveCallContextEffect(request),
							};
						}),
					),
					Effect.catch((cause) =>
						Effect.logError(
							"Could not resolve runner's project services",
							cause,
						).pipe(Effect.as(undefined)),
					),
				);
			const projectRootForSession = (sessionId: string, projectId?: string) =>
				Effect.gen(function* () {
					const owner = projectId ?? (yield* sessionProject(sessionId));
					if (owner === undefined || unavailable.has(owner)) return undefined;
					const current = yield* Ref.get(projects);
					const project = HashMap.get(current, owner);
					return Option.isSome(project)
						? project.value.project.folders[0]
						: undefined;
				}).pipe(
					Effect.catch((cause) =>
						Effect.logError(
							"Could not resolve runner's project root",
							cause,
						).pipe(Effect.as(undefined)),
					),
				);
			const persistForSession = (sessionId: string, operation: string) =>
				projectContext(sessionId).pipe(
					Effect.flatMap((project) =>
						project
							? Effect.succeed(
									Context.get(project.context, ClaudeEventPersistEffectTag),
								)
							: Effect.fail(
									new ClaudeEventPersistEffectError({
										operation,
										cause: `Project services unavailable for session ${sessionId}`,
									}),
								),
					),
					Effect.mapError((cause) =>
						cause instanceof ClaudeEventPersistEffectError
							? cause
							: new ClaudeEventPersistEffectError({ operation, cause }),
					),
				);
			const persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"] =
				(sessionId, text, options) =>
					Effect.flatMap(
						persistForSession(sessionId, "persistUserMessage"),
						(persist) => persist.persistUserMessage(sessionId, text, options),
					);
			const stateForSession = (sessionId: string, operation: string) =>
				projectContext(sessionId).pipe(
					Effect.flatMap((project) =>
						project
							? Effect.succeed(
									Context.get(project.context, ProviderStateEffectTag),
								)
							: Effect.fail(
									new ProviderStateEffectError({
										operation,
										cause: `Project services unavailable for session ${sessionId}`,
									}),
								),
					),
					Effect.mapError((cause) =>
						cause instanceof ProviderStateEffectError
							? cause
							: new ProviderStateEffectError({ operation, cause }),
					),
				);
			const state: Omit<ProviderStateEffect, "projectId"> = {
				nativeThread: (sessionId, accountId) =>
					Effect.flatMap(stateForSession(sessionId, "nativeThread"), (owner) =>
						owner.nativeThread(sessionId, accountId),
					),
				getState: (sessionId) =>
					Effect.flatMap(stateForSession(sessionId, "getState"), (owner) =>
						owner.getState(sessionId),
					),
				saveUpdates: (sessionId, updates) =>
					Effect.flatMap(stateForSession(sessionId, "saveUpdates"), (owner) =>
						owner.saveUpdates(sessionId, updates),
					),
				clearState: (sessionId) =>
					Effect.flatMap(stateForSession(sessionId, "clearState"), (owner) =>
						owner.clearState(sessionId),
					),
			};
			const read = yield* makeReadQueryEffect.pipe(Effect.provide(store));
			const readThread: NonNullable<
				Parameters<typeof ClaudeDriver.create>[0]["readThread"]
			> = (sessionId, input) =>
				projectContext(sessionId).pipe(
					Effect.flatMap((project) =>
						project
							? makeClaudeThreadRead.pipe(
									Effect.provide(project.context),
									Effect.flatMap((read) => read(sessionId, input)),
								)
							: Effect.succeed<ClaudeThreadReadResult>({
									code: "ServerUnavailable",
									message: "This Conduit session's project is unavailable.",
								}),
					),
					Effect.catch(() =>
						Effect.succeed<ClaudeThreadReadResult>({
							code: "ServerUnavailable",
							message: "Conduit could not find this session's project.",
						}),
					),
				);
			const runBackground = Effect.runForkWith(Context.empty());
			const onBackgroundTask: NonNullable<
				Parameters<typeof ClaudeDriver.create>[0]["onBackgroundTask"]
			> = (transition) => {
				if (!activity.background.record(transition)) return;
				runBackground(
					projectContext(transition.sessionId).pipe(
						Effect.tap((project) =>
							Effect.sync(() =>
								project?.onBackgroundWorkChanged?.(transition.sessionId),
							),
						),
						Effect.catch((cause) =>
							Effect.logWarning("Could not announce background work", cause),
						),
					),
				);
			};
			let testSdk: ProjectRelayConfig["claudeSdk"];
			const testModule = process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"];
			if (process.env["NODE_ENV"] === "test" && process.send && testModule) {
				const imported: {
					readonly claudeSdk?: ProjectRelayConfig["claudeSdk"];
				} = yield* Effect.tryPromise({
					try: () => import(testModule),
					catch: (cause) =>
						new ProviderAdapterRecoveryError({
							operation: "loadTestSdk",
							cause,
						}),
				});
				testSdk = imported.claudeSdk;
				if (
					typeof testSdk?.query !== "function" ||
					typeof testSdk.titleQuery !== "function" ||
					typeof testSdk.fork?.readTranscript !== "function" ||
					typeof testSdk.fork?.forkSession !== "function"
				)
					return yield* new ProviderAdapterRecoveryError({
						operation: "loadTestSdk",
						cause:
							"Process test module must export Claude query, title and fork SDK functions",
					});
			}
			// Explicit ProviderCall values carry directories and accounts. The empty
			// compatibility root is never selected for a daemon-routed session.
			registry.registerInstance(
				yield* ClaudeDriver.create({
					workspaceRoot: "",
					daemonConfigDir: configDir,
					projectRootForSession,
					recoveryForSession,
					onBackgroundTask,
					persistUserMessage,
					readThread,
					claudeSettingsOverrides: () =>
						loadRelaySettings(configDir).claudeSettings,
					...(testSdk
						? {
								queryFactory: testSdk.query,
								generateTextQueryFactory: testSdk.titleQuery,
								sessionForkSdk: testSdk.fork,
								...(testSdk.subagentSdk
									? { subagentSdk: testSdk.subagentSdk }
									: {}),
							}
						: {}),
				}),
			);
			registry.registerInstance(
				yield* OpenCodeDriver.create({
					configDir,
					clientForAccount: (account, directory) =>
						instances.use(account.id, directory),
					instanceIdForSession: (sessionId) =>
						bindings.getProviderForSession(sessionId),
					clientForSession: (sessionId) =>
						Effect.gen(function* () {
							const instanceId =
								yield* bindings.getProviderForSession(sessionId);
							const account = yield* accounts.resolve(
								instanceId === undefined
									? { _tag: "DriverDefault", driver: "opencode" }
									: { _tag: "Id", id: instanceId },
							);
							if (!PROVIDER_DRIVERS[account.driver].runsOpenCodeServer)
								return yield* Effect.fail(
									new Error("OpenCode session requires an OpenCode account"),
								);
							const project = yield* projectContext(sessionId);
							if (!project)
								return yield* Effect.fail(
									new Error(
										`Project services unavailable for session ${sessionId}`,
									),
								);
							const directory = yield* Context.get(
								project.context,
								SessionWorkspaceTag,
							).get(sessionId);
							return yield* instances.use(account.id, directory);
						}).pipe(
							Effect.mapError((cause) =>
								cause instanceof Error ? cause : new Error(String(cause)),
							),
						),
					hasWorktreeToolForSession: (sessionId, account) =>
						Effect.gen(function* () {
							const instanceId =
								account?.id ??
								(yield* bindings.getProviderForSession(sessionId)) ??
								MANAGED_OPENCODE_ACCOUNT_ID;
							const snapshot = yield* accounts.snapshot;
							return snapshot.accounts.some(
								(configured) =>
									configured.id === instanceId &&
									configured.driver === "opencode" &&
									configured.managed === true,
							);
						}),
				}),
			);
			registry.registerInstance(
				yield* makeCursorProviderRuntime(
					{
						workspaceRoot: "",
						daemonConfigDir: configDir,
						accounts: accounts.snapshot,
						projectRootForSession,
						recoveryForSession,
						persistUserMessage,
					},
					{ read, state },
				),
			);
			yield* Effect.addFinalizer(() => registry.shutdownAllEffect());
			const configuredAccounts = yield* accounts.snapshot;
			// A crash can leave admitted work without a runner registration, even
			// after its account was removed. Those projects also lend recovery state.
			const recoveryProviderIds = [
				...new Set([
					"claude",
					"cursor",
					MANAGED_OPENCODE_ACCOUNT_ID,
					...configuredAccounts.accounts.map((account) => account.id),
					...configuredAccounts.deleted.map((account) => account.id),
				]),
			];
			const recoveryProjects: string[] = [];
			for (const [projectId, entry] of HashMap.entries(
				yield* Ref.get(projects),
			)) {
				if (unavailable.has(projectId) || !existsSync(entry.project.folders[0]))
					continue;
				const needsRecovery = yield* Effect.gen(function* () {
					const runners = yield* Effect.try(() =>
						discoverRunners(entry.project.folders[0], configDir),
					);
					return (
						runners.length > 0 ||
						(yield* hasProviderRecoveryCandidate(
							entry.project,
							recoveryProviderIds,
						).pipe(Effect.provideService(PersistenceStore, store)))
					);
				}).pipe(
					Effect.mapError(
						(cause) =>
							new ProviderAdapterRecoveryError({
								operation: "discoverProjects",
								cause,
							}),
					),
				);
				if (needsRecovery) recoveryProjects.push(projectId);
			}
			const waiting = new Set(recoveryProjects);
			const ready = yield* Deferred.make<void>();
			const projectFailed = (projectId: string) =>
				Effect.gen(function* () {
					waiting.delete(projectId);
					if (waiting.size === 0) yield* Deferred.succeed(ready, undefined);
				});
			if (waiting.size === 0) yield* Deferred.succeed(ready, undefined);
			const recovery = yield* Effect.gen(function* () {
				yield* Deferred.await(ready);
				for (const providerId of registry.listProviders()) {
					const adapter = registry.getInstance(providerId);
					if (adapter instanceof RunnerProviderInstance)
						yield* adapter
							.recoverProjectContextsEffect(recoveryForSession)
							.pipe(Effect.provideService(SqlClient.SqlClient, sql));
				}
				recovered = true;
			}).pipe(
				Effect.mapError(
					(cause) =>
						new ProviderAdapterRecoveryError({ operation: "recover", cause }),
				),
				Effect.forkIn(scope),
			);
			return {
				registry,
				recoveryProjects,
				recover: Fiber.join(recovery),
				projectFailed,
				registerProject: (projectId, context, onBackgroundWorkChanged) =>
					projectBorrows.withPermits(1)(
						Effect.gen(function* () {
							const project = {
								context,
								...(onBackgroundWorkChanged ? { onBackgroundWorkChanged } : {}),
							};
							borrowed.set(projectId, project);
							yield* Effect.addFinalizer(() =>
								projectBorrows.withPermits(1)(
									Effect.gen(function* () {
										if (borrowed.get(projectId) !== project) return;
										const sessions = yield* sql<{
											readonly id: string;
										}>`SELECT id FROM sessions WHERE project_id = ${projectId}`.pipe(
											Effect.catch((cause) =>
												Effect.logError(
													"Could not release project provider sessions",
													cause,
												).pipe(Effect.as([])),
											),
										);
										for (const providerId of registry.listProviders()) {
											const adapter = registry.getInstance(providerId);
											if (adapter instanceof RunnerProviderInstance)
												yield* adapter.releaseSessionsEffect(
													sessions.map((session) => session.id),
												);
										}
										if (borrowed.get(projectId) === project)
											borrowed.delete(projectId);
									}),
								),
							);
							if (recovered) {
								const sessions = yield* sql<{
									readonly id: string;
								}>`SELECT id FROM sessions WHERE project_id = ${projectId}`.pipe(
									Effect.orDie,
								);
								for (const providerId of registry.listProviders()) {
									const adapter = registry.getInstance(providerId);
									if (adapter instanceof RunnerProviderInstance)
										yield* adapter
											.attachSessionsEffect(
												sessions.map(({ id }) => id),
												recoveryForSession,
											)
											.pipe(
												Effect.provideService(SqlClient.SqlClient, sql),
												Effect.orDie,
											);
								}
							}
							yield* projectFailed(projectId);
						}),
					),
			} satisfies ProviderAdapters["Service"];
		}),
	);
