import { isDeepStrictEqual } from "node:util";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Schema } from "effect";
import {
	isKnownDriverKind,
	PROVIDER_SESSION_CAPABILITIES,
} from "../../../contracts/provider-instance.js";
import {
	type SessionWorkspace as RecordedWorkspace,
	SessionWorkspaceSchema,
	WorkspaceMoveError,
} from "../../../contracts/session-workspace.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import { readWorktrees, realWorkspacePath } from "../../../git/worktrees.js";
import {
	type CommitAndSignalProject,
	makeCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import { ConfigTag } from "../Services/services.js";
import {
	applySessionCommand,
	SessionCommandError,
} from "../Services/session-command.js";
import {
	type ResolvedWorkspaceTarget,
	type SessionWorkspace,
	SessionWorkspaceTag,
} from "../Services/session-workspace.js";

type Dependencies = Effect.Effect.Context<
	ReturnType<typeof applySessionCommand>
>;

export const SessionWorkspaceLive = Layer.effect(
	SessionWorkspaceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const read = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const commitAndSignal = yield* makeCommitAndSignal;
		// Capture the relay context so command commits retain its event bus.
		const services = yield* Effect.context<Dependencies>();
		const folders = [config.projectDir, ...(config.extraFolders ?? [])];
		const primary = yield* realWorkspacePath(config.projectDir).pipe(
			Effect.orElseSucceed(() => config.projectDir),
		);
		const readWorkspace = (sessionId: string) =>
			Effect.gen(function* () {
				const row = yield* read
					.getSession(sessionId)
					.pipe(
						Effect.mapError(
							(cause) =>
								new SessionCommandError({ operation: "workspace.get", cause }),
						),
					);
				if (!row)
					return yield* new SessionCommandError({
						operation: "workspace.get",
						cause: `Session ${sessionId} not found`,
					});
				const workspace =
					row.workspace == null
						? null
						: yield* Schema.decodeUnknown(
								Schema.parseJson(SessionWorkspaceSchema),
							)(row.workspace).pipe(
								Effect.mapError(
									(cause) =>
										new SessionCommandError({
											operation: "workspace.get",
											cause,
										}),
								),
							);
				return { row, workspace };
			});
		const latestMove = (sessionId: string) => sql<{
			sequence: number;
			cause: string;
		}>`
			SELECT sequence, json_extract(data, '$.cause') AS cause FROM events
			WHERE session_id = ${sessionId} AND type = 'session.workspace_changed'
			ORDER BY sequence DESC LIMIT 1`;
		const worktreesFor = (
			target: ResolvedWorkspaceTarget,
			previous: RecordedWorkspace | null,
		): Record<string, string> => {
			if (!target.reset) return { [target.projectFolder]: target.path };
			const worktrees =
				target.projectFolder === config.projectDir
					? {}
					: { ...previous?.worktrees };
			delete worktrees[target.projectFolder];
			return worktrees;
		};
		const resolve: SessionWorkspace["resolve"] = (sessionId, path, cause) =>
			Effect.gen(function* () {
				const { row, workspace: previous } = yield* readWorkspace(sessionId);
				const driver = resolveProviderRoutingDriver(
					loadDaemonConfig(config.configDir),
					row.provider,
				);
				if (
					!driver ||
					!isKnownDriverKind(driver) ||
					!PROVIDER_SESSION_CAPABILITIES[driver].supportsWorktree
				)
					return yield* new WorkspaceMoveError({
						path,
						reason: "unsupported-provider",
					});
				const normalized = yield* realWorkspacePath(path);
				let projectFolder: string | undefined;
				let reset = false;
				for (const folder of folders) {
					const main = yield* realWorkspacePath(folder).pipe(Effect.option);
					if (main._tag === "Some" && main.value === normalized) {
						projectFolder = folder;
						reset = true;
						break;
					}
				}
				if (!reset) {
					const repo = yield* readWorktrees(normalized);
					if (!repo.worktrees.some(({ path }) => path === normalized))
						return yield* new WorkspaceMoveError({
							path,
							reason: "not-a-worktree",
						});
					for (const folder of folders) {
						const owner = yield* readWorktrees(folder).pipe(Effect.option);
						if (
							owner._tag === "Some" &&
							owner.value.commonDir === repo.commonDir
						) {
							projectFolder = folder;
							break;
						}
					}
				}
				if (projectFolder === undefined)
					return yield* new WorkspaceMoveError({
						path,
						reason: "other-repository",
					});
				const target = {
					path: normalized,
					projectFolder,
					reset,
					provider: row.provider,
				};
				const workspace = {
					cause,
					worktrees: worktreesFor(target, previous),
					origin: "existing" as const,
				};
				// Warm outside the permit, using the key read-model consumers use.
				yield* Effect.tryPromise(() =>
					daemonSessionGitCache.refresh(
						effectiveWorkingDirectory(config.projectDir, workspace),
					),
				).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({ operation: "workspace.git", cause }),
					),
				);
				return target;
			});
		const record: SessionWorkspace["record"] = (
			sessionId,
			target,
			cause,
			options,
		) => {
			const append = (project: CommitAndSignalProject) =>
				Effect.gen(function* () {
					const { row, workspace: previous } = yield* readWorkspace(sessionId);
					// A provider switch during resolution must not bypass capability validation.
					if (row.provider !== target.provider)
						return yield* new WorkspaceMoveError({
							path: target.path,
							reason: "unsupported-provider",
						});
					const worktrees = worktreesFor(target, previous);
					if (
						(!target.reset &&
							effectiveWorkingDirectory(config.projectDir, previous) ===
								target.path) ||
						isDeepStrictEqual(worktrees, previous?.worktrees ?? {})
					) {
						// A successful declaration can acknowledge a user move to the same path,
						// including a reset whose read-model workspace is NULL.
						if (
							cause !== "agent" ||
							(yield* latestMove(sessionId))[0]?.cause !== "user"
						)
							return target.path;
					}
					yield* applySessionCommand(
						{
							type: "session.workspace_changed",
							data: { sessionId, cause, worktrees, origin: "existing" },
						},
						{ project, upstreamAdapter: null },
					).pipe(Effect.provide(services));
					return target.path;
				});
			return (
				options?.project
					? append(options.project)
					: commitAndSignal.write(append)
			).pipe(
				Effect.mapError((error) =>
					error instanceof WorkspaceMoveError ||
					error instanceof SessionCommandError
						? error
						: new SessionCommandError({
								operation: "workspace.record",
								cause: error,
							}),
				),
			);
		};
		return {
			get: (sessionId) =>
				readWorkspace(sessionId).pipe(
					Effect.map(({ workspace }) =>
						effectiveWorkingDirectory(config.projectDir, workspace),
					),
				),
			resolve,
			record,
			move: (sessionId, path, cause) =>
				resolve(sessionId, path, cause).pipe(
					Effect.flatMap((target) => record(sessionId, target, cause)),
				),
			claudeWorktreeState: (sessionId) =>
				Effect.gen(function* () {
					const lastMove = (yield* latestMove(sessionId))[0];
					if (lastMove?.cause !== "user") return { pendingUserMove: false };
					const { workspace } = yield* readWorkspace(sessionId);
					const requested = effectiveWorkingDirectory(
						config.projectDir,
						workspace,
					);
					const target = requested === config.projectDir ? primary : requested;
					const acknowledgments = yield* sql`
					SELECT 1 FROM events WHERE session_id = ${sessionId}
					AND sequence > ${lastMove.sequence} AND type = 'session.workspace_started'
					AND json_extract(data, '$.path') = ${target} LIMIT 1`;
					return { pendingUserMove: acknowledgments.length === 0 };
				}).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({
								operation: "workspace.claudeWorktreeState",
								cause,
							}),
					),
				),
		} satisfies SessionWorkspace;
	}),
);
