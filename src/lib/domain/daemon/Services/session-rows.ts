import { SqlClient } from "@effect/sql";
import { Array as Arr, Effect } from "effect";
import {
	type createSessionGitCache,
	withCachedSessionGit,
} from "../../../git/session-git.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
	type SessionScope,
} from "../../../persistence/effect/read-query-effect.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
import type { SessionInfo } from "../../../shared-types.js";
import { withSessionWorktreeStatus } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "./account-directory.js";
import { resolveSessionAccountIds } from "./session-accounts.js";
import { SessionActivityTag } from "./session-activity.js";

export interface SessionRowsScope {
	readonly slug: string;
	readonly folders: readonly [string, ...string[]];
	readonly gitCache?: ReturnType<typeof createSessionGitCache>;
	readonly refreshGit?: boolean;
}

/** The common read path for full lists and versioned sidebar/family windows. */
export const makeSessionRows = (scope: SessionRowsScope) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const accounts = yield* AccountDirectory;
		const activity = yield* SessionActivityTag;
		const sessionScope: SessionScope = { projectIds: [scope.slug] };
		const overlay = {
			backgroundOf: activity.background.backgroundOf,
			hintDismissals: activity.hintDismissals,
		};
		const decorate = <T extends Omit<SessionInfo, "projectSlug" | "accountId">>(
			sessions: readonly T[],
		) =>
			Effect.gen(function* () {
				// Cold project reads have no relay git-change signal to warm this cache.
				if (scope.refreshGit && scope.gitCache) {
					const cache = scope.gitCache;
					const directories = new Set(
						sessions.flatMap((session) => [
							effectiveWorkingDirectory(scope.folders[0], session.workspace),
							...effectiveSessionFolders(scope.folders, session.workspace).map(
								({ directory }) => directory,
							),
						]),
					);
					yield* Effect.forEach(
						[...directories].filter((directory) => cache.isStale(directory)),
						(directory) =>
							Effect.tryPromise({
								try: () => cache.refresh(directory),
								catch: (cause) =>
									new ReadQueryEffectError({
										operation: "sessionRows.git",
										cause,
									}),
							}),
						{ concurrency: 4, discard: true },
					);
				}
				const accountIds = yield* resolveSessionAccountIds(
					sessions.map(({ id }) => id),
				).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(AccountDirectory, accounts),
				);
				return yield* Effect.forEach(sessions, (session) =>
					Effect.gen(function* () {
						const compacting = activity.compactions.compactingOf(session.id);
						const retrying = activity.retries.retryingOf(session.id);
						const enriched = yield* withSessionWorktreeStatus(
							withCachedSessionGit(
								{
									...session,
									projectSlug: scope.slug,
									accountId: accountIds.get(session.id) ?? null,
								},
								scope.folders,
								scope.gitCache,
							),
							{
								slug: scope.slug,
								projectDir: scope.folders[0],
								extraFolders: scope.folders.slice(1),
							},
						).pipe(Effect.provideService(SqlClient.SqlClient, sql));
						return {
							...session,
							...enriched,
							...(compacting === undefined ? {} : { compacting }),
							...(retrying === undefined ? {} : { retrying }),
						};
					}),
				);
			});

		return {
			list: (
				options?: Omit<
					NonNullable<Parameters<ReadQueryEffect["listSessionInfos"]>[1]>,
					"backgroundOf" | "hintDismissals"
				>,
			) =>
				readQuery
					.listSessionInfos(sessionScope, { ...options, ...overlay })
					.pipe(Effect.flatMap(decorate)),
			read: (
				range?: Omit<
					NonNullable<Parameters<ReadQueryEffect["readSessionList"]>[1]>,
					"backgroundOf" | "hintDismissals"
				>,
			) =>
				readQuery.readSessionList(sessionScope, { ...range, ...overlay }).pipe(
					Effect.flatMap((list) =>
						decorate(list.rows.map(({ item }) => item)).pipe(
							Effect.map((items) => ({
								...list,
								rows: Arr.zip(list.rows, items).map(([row, item]) => ({
									...row,
									item,
								})),
							})),
						),
					),
				),
		};
	});
