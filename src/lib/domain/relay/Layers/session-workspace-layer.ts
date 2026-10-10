import { isDeepStrictEqual } from "node:util";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Schema } from "effect";
import {
	isKnownDriverKind,
	PROVIDER_SESSION_CAPABILITIES,
} from "../../../contracts/provider-instance.js";
import {
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
		// Retain the relay's ambient bus and notifier along with command dependencies.
		const services = yield* Effect.context<Dependencies>();
		const folders = [config.projectDir, ...(config.extraFolders ?? [])];
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
		return {
			get: (sessionId) =>
				readWorkspace(sessionId).pipe(
					Effect.map(({ workspace }) =>
						effectiveWorkingDirectory(config.projectDir, workspace),
					),
				),
			claudeWorktreeState: (sessionId) =>
				Effect.gen(function* () {
					const { workspace } = yield* readWorkspace(sessionId);
					const declarations = yield* sql<{ entered: number }>`
					SELECT json_extract(metadata, '$.claudeWorktree.entered') AS entered
					FROM events WHERE session_id = ${sessionId} AND type = 'tool.completed'
					AND json_type(metadata, '$.claudeWorktree.entered') IN ('true', 'false')
					ORDER BY sequence DESC LIMIT 1`;
					const latest = yield* sql<{ sequence: number; cause: string }>`
					SELECT sequence, json_extract(data, '$.cause') AS cause FROM events
					WHERE session_id = ${sessionId} AND type = 'session.workspace_changed'
					ORDER BY sequence DESC LIMIT 1`;
					const enteredWorktree = declarations[0]?.entered === 1;
					const lastMove = latest[0];
					if (lastMove?.cause !== "user")
						return { enteredWorktree, pendingUserMove: false };
					const requested = effectiveWorkingDirectory(
						config.projectDir,
						workspace,
					);
					const target = yield* realWorkspacePath(requested).pipe(
						Effect.orElseSucceed(() => requested),
					);
					const acknowledgments = yield* sql<{ path: string }>`
					SELECT CASE type WHEN 'session.status' THEN json_extract(metadata, '$.workspaceCwd')
						ELSE json_extract(metadata, '$.claudeWorktree.path') END AS path
					FROM events WHERE session_id = ${sessionId} AND sequence > ${lastMove.sequence}
					AND ((type = 'session.status' AND json_type(metadata, '$.workspaceCwd') = 'text')
						OR (type = 'tool.completed' AND json_type(metadata, '$.claudeWorktree.path') = 'text'))`;
					for (const { path } of acknowledgments) {
						const actual = yield* realWorkspacePath(path).pipe(
							Effect.orElseSucceed(() => path),
						);
						if (actual === target)
							return { enteredWorktree, pendingUserMove: false };
					}
					return { enteredWorktree, pendingUserMove: true };
				}).pipe(
					Effect.mapError(
						(cause) =>
							new SessionCommandError({
								operation: "workspace.claudeWorktreeState",
								cause,
							}),
					),
				),
			move: (sessionId, path, cause, options) => {
				// The canonical commit serializes both RPC and provider moves. A provider
				// move joins its runner-output receipt transaction through the same seam.
				const move = (project: CommitAndSignalProject) =>
					Effect.gen(function* () {
						const { row, workspace: previous } =
							yield* readWorkspace(sessionId);
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
						const target = yield* realWorkspacePath(path);
						let resetFolder: string | undefined;
						for (const folder of folders) {
							const main = yield* realWorkspacePath(folder).pipe(Effect.option);
							if (main._tag === "Some" && main.value === target) {
								resetFolder = folder;
								break;
							}
						}
						let worktrees: Record<string, string>;
						if (resetFolder !== undefined) {
							worktrees =
								resetFolder === config.projectDir
									? {}
									: { ...previous?.worktrees };
							delete worktrees[resetFolder];
						} else {
							const repo = yield* readWorktrees(target);
							if (!repo.worktrees.some((worktree) => worktree.path === target))
								return yield* new WorkspaceMoveError({
									path,
									reason: "not-a-worktree",
								});
							let projectFolder: string | undefined;
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
							if (projectFolder === undefined)
								return yield* new WorkspaceMoveError({
									path,
									reason: "other-repository",
								});
							const from = effectiveWorkingDirectory(
								config.projectDir,
								previous,
							);
							const normalizedFrom = yield* realWorkspacePath(from).pipe(
								Effect.orElseSucceed(() => from),
							);
							if (normalizedFrom === target) return target;
							worktrees = { [projectFolder]: target };
						}
						if (isDeepStrictEqual(worktrees, previous?.worktrees ?? {}))
							return target;
						const workspace = { cause, worktrees, origin: "existing" as const };
						// Warm the per-directory cache before publishing the changed row,
						// using the same key the row readers use (the primary path may
						// be a symlink rather than the normalized target).
						yield* Effect.tryPromise(() =>
							daemonSessionGitCache.refresh(
								effectiveWorkingDirectory(config.projectDir, workspace),
							),
						).pipe(
							Effect.mapError(
								(cause) =>
									new SessionCommandError({
										operation: "workspace.git",
										cause,
									}),
							),
						);
						yield* applySessionCommand(
							{
								type: "session.workspace_changed",
								data: {
									sessionId,
									...workspace,
								},
							},
							{ project },
						).pipe(Effect.provide(services));
						return target;
					});
				return options?.project
					? move(options.project)
					: commitAndSignal.write(move).pipe(
							Effect.mapError((error) =>
								error instanceof WorkspaceMoveError ||
								error instanceof SessionCommandError
									? error
									: new SessionCommandError({
											operation: "workspace.move",
											cause: error,
										}),
							),
						);
			},
		} satisfies SessionWorkspace;
	}),
);
