import { isDeepStrictEqual } from "node:util";
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
		// Retain the relay's ambient bus and notifier along with command dependencies.
		const services = yield* Effect.context<Dependencies>();
		const moves = yield* Effect.makeSemaphore(1);
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
			move: (sessionId, path, cause) =>
				moves.withPermits(1)(
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
						yield* applySessionCommand({
							type: "session.workspace_changed",
							data: {
								sessionId,
								...workspace,
							},
						}).pipe(Effect.provide(services));
						return target;
					}),
				),
		} satisfies SessionWorkspace;
	}),
);
