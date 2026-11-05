import {
	Cause,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	type Scope,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SessionSetupFinishedPayloadSchema } from "../../../contracts/project-setup.js";
import { readProjectFile } from "../../../daemon/project-file.js";
import * as Failure from "../../../effect/failure-classification.js";
import { createLogger } from "../../../logger.js";
import { bindEventStoreEffect } from "../../../persistence/effect/bind-event-store-effect.js";
import {
	EventStoreEffectTag,
	UnboundEventStoreEffectTag,
} from "../../../persistence/effect/event-store-effect.js";
import { ConfigSnapshotTag } from "../../daemon/Services/config-persistence-service.js";
import { OwnerScopes } from "../../daemon/Services/owner-scopes.js";
import { ProjectContext } from "../../daemon/Services/project-context.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../../daemon/Services/project-registry-service.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { applySessionCommand, SessionCommandError } from "./session-command.js";

type SetupCommandError = Effect.Error<ReturnType<typeof applySessionCommand>>;

export class SessionSetupTag extends Context.Service<
	SessionSetupTag,
	{
		/** Register the gate during workspace initialization; setup runs in the session's owner scope. */
		readonly start: (
			sessionId: string,
			directory: string,
		) => Effect.Effect<void>;
		readonly wait: (sessionId: string) => Effect.Effect<void>;
		/** Once per project per process: a relay rebuild must not fail a live run. */
		readonly recover: (
			projectId: string,
		) => Effect.Effect<void, SetupCommandError>;
	}
>()("SessionSetup") {}

type SetupCommand = Parameters<typeof applySessionCommand>[0];

const makeSessionSetup = (owner: {
	readonly project: (sessionId: string) => Effect.Effect<
		{
			readonly projectId: string;
			readonly mainFolder: string;
			readonly env: Effect.Effect<Readonly<Record<string, string | undefined>>>;
		},
		unknown
	>;
	readonly commit: (
		projectId: string,
		command: SetupCommand,
	) => Effect.Effect<void, SetupCommandError>;
	/** Fork the run into its owner; false when the owner is already gone. */
	readonly fork: (
		sessionId: string,
		run: Effect.Effect<void>,
	) => Effect.Effect<boolean>;
}) =>
	Effect.gen(function* () {
		const registry = yield* Effect.serviceOption(ProjectRegistryTag);
		const snapshot = yield* Effect.serviceOption(ConfigSnapshotTag);
		const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
		const sql = yield* SqlClient.SqlClient;
		const gates = new Map<string, Deferred.Deferred<void>>();
		const recovered = new Set<string>();

		return {
			start: (sessionId: string, directory: string) =>
				Effect.gen(function* () {
					if (gates.has(sessionId)) return;
					const gate = yield* Deferred.make<void>();
					gates.set(sessionId, gate);
					const resolved = yield* owner
						.project(sessionId)
						.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("Setup has no project", cause).pipe(
									Effect.as(undefined),
								),
							),
						);
					const release = Effect.andThen(
						Deferred.succeed(gate, undefined),
						Effect.sync(() => {
							gates.delete(sessionId);
						}),
					);
					if (!resolved) return yield* release;
					const { projectId, mainFolder } = resolved;
					const commit = (command: SetupCommand) =>
						owner.commit(projectId, command);
					let started = false;
					let finished = false;
					const finish = (
						state: Omit<
							typeof SessionSetupFinishedPayloadSchema.Type,
							"sessionId"
						>,
					) =>
						commit({
							type: "session.setup_finished",
							data: { sessionId, ...state },
						}).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									finished = true;
								}),
							),
						);
					const run = Effect.gen(function* () {
						const projects =
							registry._tag === "Some"
								? yield* allProjects.pipe(
										Effect.provideService(ProjectRegistryTag, registry.value),
									)
								: snapshot._tag === "Some"
									? (yield* snapshot.value.build).projects
									: [];
						const setting = projects?.find(
							(project) => project.slug === projectId,
						)?.setupScript;
						const file = yield* readProjectFile(mainFolder);
						const daemonScript = setting?.trim() ? setting : undefined;
						const fileScript =
							file._tag === "parsed" && file.file.setupScript?.trim()
								? file.file.setupScript
								: undefined;
						const script = daemonScript ?? fileScript;
						if (!script && file._tag !== "invalid") return;
						yield* commit({
							type: "session.setup_started",
							data: { sessionId, source: daemonScript ? "daemon" : "file" },
						});
						started = true;
						if (!daemonScript && file._tag === "invalid") {
							yield* finish({ status: "skipped", message: file.message });
							return;
						}
						if (!script || worktrees._tag === "None") {
							yield* finish({
								status: "failed",
								message: "Setup runner is unavailable.",
							});
							return;
						}
						const env = yield* resolved.env;
						yield* worktrees.value.runSetup(directory, script, env).pipe(
							Stream.runForEach((update) =>
								update._tag === "output"
									? commit({
											type: "session.setup_output",
											data: { sessionId, output: update.output },
										})
									: finish({
											status: update.status,
											...(update.exitCode === undefined
												? {}
												: { exitCode: update.exitCode }),
											...(update.message === undefined
												? {}
												: { message: update.message }),
										}),
							),
						);
					}).pipe(
						Effect.onExit((exit) =>
							started && !finished
								? finish({
										status: "failed",
										message: Failure.isInterruptedOnly(
											exit._tag === "Failure" ? exit.cause : Cause.empty,
										)
											? "Setup interrupted by daemon shutdown."
											: `Setup could not finish: ${exit._tag === "Failure" ? Failure.renderCause(exit.cause) : "runner ended without an outcome"}`,
									}).pipe(
										Effect.catchCause((cause) =>
											Effect.logError("Failed to record setup outcome", cause),
										),
									)
								: Effect.void,
						),
						Effect.catchCause((cause) =>
							Failure.isInterruptedOnly(cause)
								? Effect.void
								: Effect.logError("Project setup failed", cause),
						),
						Effect.ensuring(release),
					);
					if (!(yield* owner.fork(sessionId, run))) yield* release;
				}),
			wait: (sessionId: string) =>
				Effect.suspend(() => {
					const gate = gates.get(sessionId);
					return gate ? Deferred.await(gate) : Effect.void;
				}),
			// The setup projector writes parts as setup-${sessionId}-part, so a
			// primary-key range avoids parsing every part's metadata at startup.
			recover: (projectId: string) =>
				recovered.has(projectId)
					? Effect.void
					: sql<{ session_id: string }>`SELECT m.session_id
				FROM messages m JOIN message_parts p ON p.message_id = m.id
				JOIN sessions s ON s.id = m.session_id
				WHERE s.project_id = ${projectId}
					AND p.id >= 'setup-' AND p.id < 'setup.'
					AND CASE WHEN json_valid(p.metadata)
					THEN json_extract(p.metadata, '$.setup.status') END = 'running'`.pipe(
							Effect.mapError(
								(cause) =>
									new SessionCommandError({
										operation: "session.setup.recover",
										cause,
									}),
							),
							Effect.flatMap((rows) =>
								Effect.forEach(
									rows,
									({ session_id }) =>
										owner.commit(projectId, {
											type: "session.setup_finished",
											data: {
												sessionId: session_id,
												status: "failed",
												message: "Setup interrupted by daemon restart.",
											},
										}),
									{ discard: true },
								),
							),
							Effect.tap(() =>
								Effect.sync(() => {
									recovered.add(projectId);
								}),
							),
						),
		};
	});

/** The run outlives the request that started it, so it forks into a scope it does not own. */
const forkInto =
	(scope: Scope.Scope) => (_sessionId: string, run: Effect.Effect<void>) =>
		Effect.forkIn(Effect.interruptible(run), scope, {
			uninterruptible: "inherit",
		}).pipe(Effect.as(true));

/** Standalone relay (no daemon): its own project, its relay scope. */
export const SessionSetupLive = Layer.effect(
	SessionSetupTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const context =
			yield* Effect.context<
				Effect.Services<ReturnType<typeof applySessionCommand>>
			>();
		return yield* makeSessionSetup({
			project: () =>
				Effect.succeed({
					projectId: config.slug,
					mainFolder: config.projectDir,
					env: Effect.gen(function* () {
						const prepare = config.prepareShellEnv;
						if (prepare)
							yield* Effect.promise(() => prepare(config.projectDir));
						return config.shellEnv?.(config.projectDir).env ?? process.env;
					}),
				}),
			commit: (_projectId, command) =>
				applySessionCommand(command).pipe(Effect.provide(context)),
			fork: forkInto(yield* Effect.scope),
		});
	}),
);

/**
 * Daemon-owned setup: one instance for every project. A run lives in its
 * session's owner scope, so deleting the session ends it and a relay rebuild
 * does not.
 */
export const DaemonSessionSetupLive = Layer.effect(
	SessionSetupTag,
	Effect.gen(function* () {
		const projects = yield* ProjectContext;
		const owners = yield* Effect.serviceOption(OwnerScopes);
		const store = yield* UnboundEventStoreEffectTag;
		const context =
			yield* Effect.context<
				Exclude<
					Effect.Services<ReturnType<typeof applySessionCommand>>,
					EventStoreEffectTag | LoggerTag
				>
			>();
		const log = createLogger("session-setup");
		const daemonScope = yield* Effect.scope;
		return yield* makeSessionSetup({
			project: (sessionId) =>
				Effect.map(projects.forSession(sessionId), (project) => ({
					projectId: project.projectId,
					mainFolder: project.mainFolder,
					env: projects.forSession(sessionId, { prepareShellEnv: true }).pipe(
						Effect.map(({ shellEnv }) => shellEnv),
						Effect.orElseSucceed(() => project.shellEnv),
					),
				})),
			commit: (projectId, command) =>
				applySessionCommand(command).pipe(
					Effect.provideService(
						EventStoreEffectTag,
						bindEventStoreEffect(store, projectId),
					),
					Effect.provideService(LoggerTag, log),
					Effect.provide(context),
				),
			fork: (sessionId, run) =>
				Option.isNone(owners)
					? forkInto(daemonScope)(sessionId, run)
					: owners.value.sessionScope(sessionId).pipe(
							Effect.flatMap((scope) =>
								scope.acquire<unknown, never, never>(
									Effect.forkScoped(Effect.interruptible(run), {
										uninterruptible: "inherit",
									}),
								),
							),
							Effect.as(true),
							// Closed: the session is gone, so its setup never starts.
							Effect.catchTag("OwnerScopeClosedError", () =>
								Effect.succeed(false),
							),
							Effect.catch((error) =>
								Effect.logWarning(
									"Setup runs without a session owner",
									error,
								).pipe(Effect.andThen(forkInto(daemonScope)(sessionId, run))),
							),
						),
		});
	}),
);

/** The daemon's session setup when it lends one; a standalone relay is its own daemon. */
export const SessionSetupOrOwn = Layer.unwrap(
	Effect.map(Effect.serviceOption(SessionSetupTag), (shared) =>
		Option.isSome(shared)
			? Layer.succeed(SessionSetupTag, shared.value)
			: SessionSetupLive,
	),
);
