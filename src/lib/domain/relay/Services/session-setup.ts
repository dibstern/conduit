import { SqlClient } from "@effect/sql";
import { Cause, Context, Deferred, Effect, Layer, Stream } from "effect";
import type { SessionSetupFinishedPayloadSchema } from "../../../contracts/project-setup.js";
import { loadDaemonConfig } from "../../../daemon/config-persistence.js";
import { readProjectFile } from "../../../daemon/project-file.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { ConfigTag } from "./services.js";
import { applySessionCommand, SessionCommandError } from "./session-command.js";

type SetupCommandError = Effect.Effect.Error<
	ReturnType<typeof applySessionCommand>
>;

export class SessionSetupTag extends Context.Tag("SessionSetup")<
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
>() {}

export const SessionSetupLive = Layer.scoped(
	SessionSetupTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
		const sql = yield* SqlClient.SqlClient;
		const scope = yield* Effect.scope;
		const context =
			yield* Effect.context<
				Effect.Effect.Context<ReturnType<typeof applySessionCommand>>
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
						// getProjects reads the live daemon registry, including a just-saved setting.
						const projects = config.getProjects
							? yield* Effect.tryPromise(async () => config.getProjects?.())
							: loadDaemonConfig(config.configDir)?.projects;
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
										message: Cause.isInterruptedOnly(
											exit._tag === "Failure" ? exit.cause : Cause.empty,
										)
											? "Setup interrupted by daemon shutdown."
											: `Setup could not finish: ${exit._tag === "Failure" ? Cause.pretty(exit.cause) : "runner ended without an outcome"}`,
									}).pipe(
										Effect.catchAllCause((cause) =>
											Effect.logError("Failed to record setup outcome", cause),
										),
									)
								: Effect.void,
						),
						Effect.catchAllCause((cause) =>
							Cause.isInterruptedOnly(cause)
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
					yield* Effect.forkIn(Effect.interruptible(run), scope);
				}),
			wait: (sessionId: string) =>
				Effect.suspend(() => {
					const gate = gates.get(sessionId);
					return gate ? Deferred.await(gate) : Effect.void;
				}),
			recover: sql<{ session_id: string }>`SELECT m.session_id
				FROM messages m JOIN message_parts p ON p.message_id = m.id
				WHERE CASE WHEN json_valid(p.metadata)
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
