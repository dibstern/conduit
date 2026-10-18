import { Cause, Context, Deferred, Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { SessionSetupFinishedPayloadSchema } from "../../../contracts/project-setup.js";
import { loadDaemonConfigResult } from "../../../daemon/config-persistence.js";
import { readProjectFile } from "../../../daemon/project-file.js";
import * as Failure from "../../../effect/failure-classification.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../../daemon/Services/project-registry-service.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { ConfigTag } from "./services.js";
import { applySessionCommand, SessionCommandError } from "./session-command.js";

type SetupCommandError = Effect.Error<ReturnType<typeof applySessionCommand>>;

export class SessionSetupTag extends Context.Service<
	SessionSetupTag,
	{
		/** Register the gate during workspace initialization; setup runs in the relay scope. */
		readonly start: (
			sessionId: string,
			directory: string,
		) => Effect.Effect<void>;
		readonly wait: (sessionId: string) => Effect.Effect<void>;
		readonly recover: Effect.Effect<void, SetupCommandError>;
	}
>()("SessionSetup") {}

export const SessionSetupLive = Layer.effect(
	SessionSetupTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const registry = yield* Effect.serviceOption(ProjectRegistryTag);
		const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
		const sql = yield* SqlClient.SqlClient;
		const scope = yield* Effect.scope;
		const context =
			yield* Effect.context<
				Effect.Services<ReturnType<typeof applySessionCommand>>
			>();
		const commit = (command: Parameters<typeof applySessionCommand>[0]) =>
			applySessionCommand(command).pipe(Effect.provide(context));
		const gates = new Map<string, Deferred.Deferred<void>>();

		return {
			start: (sessionId: string, directory: string) =>
				Effect.gen(function* () {
					if (gates.has(sessionId)) return;
					const gate = yield* Deferred.make<void>();
					gates.set(sessionId, gate);
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
								: yield* Effect.suspend(() =>
										Effect.fromResult(loadDaemonConfigResult(config.configDir)),
									).pipe(
										Effect.map((loaded) => loaded.projects),
										Effect.catchTag("NotFound", () =>
											Effect.succeed(undefined),
										),
									);
						const setting = projects?.find(
							(project) => project.slug === config.slug,
						)?.setupScript;
						const file = yield* readProjectFile(config.projectDir);
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
						const prepareShellEnv = config.prepareShellEnv;
						if (prepareShellEnv) {
							yield* Effect.tryPromise(() =>
								prepareShellEnv(config.projectDir),
							);
						}
						const env = config.shellEnv?.(config.projectDir) ?? process.env;
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
						Effect.ensuring(Deferred.succeed(gate, undefined)),
						Effect.ensuring(
							Effect.sync(() => {
								gates.delete(sessionId);
							}),
						),
					);
					yield* Effect.forkIn(Effect.interruptible(run), scope, {
						uninterruptible: "inherit",
					});
				}),
			wait: (sessionId: string) =>
				Effect.suspend(() => {
					const gate = gates.get(sessionId);
					return gate ? Deferred.await(gate) : Effect.void;
				}),
			// The setup projector writes parts as setup-${sessionId}-part, so a
			// primary-key range avoids parsing every part's metadata at startup.
			recover: sql<{ session_id: string }>`SELECT m.session_id
				FROM messages m JOIN message_parts p ON p.message_id = m.id
				JOIN sessions s ON s.id = m.session_id
				WHERE s.project_id = ${config.slug}
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
							commit({
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
			),
		};
	}),
);
