import { isDeepStrictEqual } from "node:util";
import { SqlClient } from "@effect/sql";
import { type Context, Effect, Layer, Schema } from "effect";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { WorkspaceMissing } from "../../../contracts/worktree.js";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type { SessionGit, SessionInfo } from "../../../shared-types.js";
import { ConfigTag } from "../Services/services.js";
import { SessionGitServiceTag } from "../Services/session-git-service.js";
import { inspectSessionWorktree } from "../Services/session-workspace.js";

export const SessionGitLive = Layer.effect(
	SessionGitServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const read = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const refreshes = yield* Effect.makeSemaphore(1);
		let published = new Map<
			string,
			{
				git: SessionGit | undefined;
				workspaceMissing: WorkspaceMissing | undefined;
			}
		>();
		let queued:
			| {
					all: boolean;
					forceAll: boolean;
					sessionIds: Set<string>;
					forceSessionIds: Set<string>;
			  }
			| undefined;
		return {
			refresh: (options = {}) =>
				Effect.suspend(() => {
					queued ??= {
						all: false,
						forceAll: false,
						sessionIds: new Set(),
						forceSessionIds: new Set(),
					};
					queued.all ||= options.sessionId === undefined;
					if (options.sessionId !== undefined) {
						queued.sessionIds.add(options.sessionId);
						if (!options.staleOnly)
							queued.forceSessionIds.add(options.sessionId);
					} else queued.forceAll ||= !options.staleOnly;
					return refreshes.withPermits(1)(
						Effect.gen(function* () {
							while (queued !== undefined) {
								// Consume all waiting requests together. Calls queued during git IO
								// become one follow-up; the other permit waiters then have no work.
								const request = queued;
								queued = undefined;
								const sessions = yield* read.listSessionInfos();
								const directories = new Map<string, boolean>(
									request.all ? [[config.projectDir, request.forceAll]] : [],
								);
								const isolated = new Map<string, SessionInfo>();
								for (const session of sessions) {
									if (
										!request.sessionIds.has(session.id) &&
										!(
											request.all &&
											(session.settledAt == null ||
												session.workspace?.origin === "conduit")
										)
									)
										continue;
									const directory = effectiveWorkingDirectory(
										config.projectDir,
										session.workspace,
									);
									if (session.workspace?.origin === "conduit")
										isolated.set(directory, session);
									directories.set(
										directory,
										Boolean(directories.get(directory)) ||
											request.forceAll ||
											request.forceSessionIds.has(session.id),
									);
								}
								const next = new Map(published);
								for (const [directory, force] of directories) {
									const session = isolated.get(directory);
									const workspaceMissing = session
										? yield* inspectSessionWorktree(session, config)
										: undefined;
									const git =
										!force && !daemonSessionGitCache.isStale(directory)
											? daemonSessionGitCache.peek(directory)
											: yield* Effect.tryPromise(() =>
													daemonSessionGitCache.refresh(directory),
												);
									next.set(directory, {
										git: workspaceMissing ? undefined : git,
										workspaceMissing,
									});
								}
								const changed = new Set(
									[...directories.keys()].filter(
										(directory) =>
											!published.has(directory) ||
											!isDeepStrictEqual(
												published.get(directory),
												next.get(directory),
											),
									),
								);
								if (changed.size === 0) continue;
								// Git lives in the cache, so version both the session and its sidebar
								// row without changing recency or storing the branch. Recheck workspace
								// membership in the transaction: a move may have landed during git IO.
								yield* commit.write((_project, stamp) =>
									stamp((version) =>
										Effect.gen(function* () {
											const rows = yield* sql<
												Pick<SessionRow, "id" | "workspace">
											>`SELECT id, workspace FROM sessions`;
											const ids: string[] = [];
											for (const row of rows) {
												const workspace =
													row.workspace == null
														? null
														: yield* Schema.decodeUnknown(
																Schema.parseJson(SessionWorkspaceSchema),
															)(row.workspace);
												if (
													changed.has(
														effectiveWorkingDirectory(
															config.projectDir,
															workspace,
														),
													)
												)
													ids.push(row.id);
											}
											if (ids.length === 0) return [];
											const moved = yield* sql<{
												id: string;
											}>`UPDATE sessions SET version = ${version} WHERE id IN ${sql.in(ids)} RETURNING id`;
											yield* sql`UPDATE session_sidebar SET version = ${version}, row = json_set(row, '$.version', ${version}) WHERE session_id IN (SELECT root_id FROM sessions WHERE id IN ${sql.in(moved.map(({ id }) => id))})`;
											return moved.map(({ id }) => id);
										}),
									),
								);
								yield* Effect.tryPromise(async () => {
									await config.refreshSessionGit?.();
									await config.broadcastSessionListChanged?.();
								});
								published = next;
							}
						}),
					);
				}),
		} satisfies Context.Tag.Service<typeof SessionGitServiceTag>;
	}),
);
