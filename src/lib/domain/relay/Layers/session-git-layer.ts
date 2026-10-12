import { channel } from "node:diagnostics_channel";
import { isDeepStrictEqual } from "node:util";
import { SqlClient } from "@effect/sql";
import { type Context, Effect, Layer, Option, Schema } from "effect";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import type { WorkspaceMissing } from "../../../contracts/worktree.js";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
import { type SessionGit, SessionGitSchema } from "../../../shared-types.js";
import { ConfigTag } from "../Services/services.js";
import { SessionGitServiceTag } from "../Services/session-git-service.js";
import { inspectSessionWorktree } from "../Services/session-workspace.js";

/** One git refresh pass: folders read from disk, and how many moved. For load tests. */
export interface SessionGitRefresh {
	readonly read: number;
	readonly changed: number;
}

const gitRefreshes = channel("conduit:session-git-refresh");

export const SessionGitLive = Layer.effect(
	SessionGitServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const read = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		const refreshes = yield* Effect.makeSemaphore(1);
		// What browsers were last sent per folder. It is kept with the versions
		// that sent it, so after a restart only folders whose git moved while
		// down are stamped again, and until the first read the cache serves it,
		// so a row's version still covers the git it carries.
		const decodeGit = Schema.decodeUnknownOption(
			Schema.parseJson(SessionGitSchema),
		);
		let published = new Map<
			string,
			{
				git: SessionGit | undefined;
				workspaceMissing: WorkspaceMissing | undefined;
			}
		>();
		// A record that cannot be read or decoded counts as never published.
		// Only git is recorded: a missing worktree is found again on the first
		// refresh and stamps just its own sessions.
		for (const row of yield* sql<{
			directory: string;
			git: string | null;
		}>`SELECT directory, git FROM session_git_published`.pipe(
			Effect.catchAll((error) =>
				Effect.logWarning(
					"Could not read published git; every session is stamped again",
					error,
				).pipe(Effect.as([])),
			),
		)) {
			const git =
				row.git === null ? Option.some(undefined) : decodeGit(row.git);
			if (Option.isNone(git)) continue;
			published.set(row.directory, {
				git: git.value,
				workspaceMissing: undefined,
			});
			daemonSessionGitCache.seed(row.directory, git.value);
		}
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
								const projectFolders = [
									config.projectDir,
									...(config.extraFolders ?? []),
								];
								const directories = new Map<string, boolean>(
									request.all
										? projectFolders.map((directory) => [
												directory,
												request.forceAll,
											])
										: [],
								);
								const missing = new Map<string, WorkspaceMissing>();
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
									const workspaceDirectory = effectiveWorkingDirectory(
										config.projectDir,
										session.workspace,
									);
									if (session.workspace?.origin === "conduit") {
										const state = yield* inspectSessionWorktree(
											session,
											config,
										);
										if (state)
											for (const { path } of state.folders ?? [state])
												missing.set(path, state);
									}
									for (const directory of [
										workspaceDirectory,
										...Object.values(session.workspace?.worktrees ?? {}),
										...effectiveSessionFolders(
											projectFolders,
											session.workspace,
										).map(({ directory }) => directory),
									])
										directories.set(
											directory,
											Boolean(directories.get(directory)) ||
												request.forceAll ||
												request.forceSessionIds.has(session.id),
										);
								}
								const next = new Map(published);
								let fromDisk = 0;
								for (const [directory, force] of directories) {
									const workspaceMissing = missing.get(directory);
									const stale =
										force || daemonSessionGitCache.isStale(directory);
									if (stale) fromDisk++;
									const git = stale
										? yield* Effect.tryPromise(() =>
												daemonSessionGitCache.refresh(directory),
											)
										: daemonSessionGitCache.peek(directory);
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
								if (gitRefreshes.hasSubscribers)
									gitRefreshes.publish({
										read: fromDisk,
										changed: changed.size,
									} satisfies SessionGitRefresh);
								if (changed.size === 0) continue;
								// Git lives in the cache, so version both the session and its sidebar
								// row without changing recency or storing the branch. Recheck workspace
								// membership in the transaction: a move may have landed during git IO.
								// The record of what was published commits with the stamp, so a
								// crash cannot keep one without the other.
								yield* commit.write((_project, stamp) =>
									stamp((version) =>
										Effect.gen(function* () {
											for (const directory of changed) {
												const git = next.get(directory)?.git;
												yield* sql`INSERT INTO session_git_published (directory, git) VALUES (${directory}, ${git === undefined ? null : JSON.stringify(git)}) ON CONFLICT (directory) DO UPDATE SET git = excluded.git`;
											}
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
													) ||
													effectiveSessionFolders(
														projectFolders,
														workspace,
													).some(({ directory }) => changed.has(directory))
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
