import { SqlClient } from "@effect/sql";
import { Array as Arr, Effect, Option } from "effect";
import {
	type createSessionGitCache,
	withCachedSessionGit,
} from "../../../git/session-git.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
import type { SessionInfo } from "../../../shared-types.js";
import {
	BackgroundLivenessTag,
	SessionCompactionsTag,
	SessionRetriesTag,
} from "../../relay/Services/services.js";
import { withSessionWorktreeStatus } from "../../relay/Services/session-workspace.js";
import { SessionWorkspaceHintStateTag } from "../../relay/Services/session-workspace-hint-state.js";
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
		const activity = Option.getOrUndefined(
			yield* Effect.serviceOption(SessionActivityTag),
		);
		// Legacy read-only hosts can still supply the existing overlay tags.
		const backgroundOf =
			activity?.background.backgroundOf ??
			Option.getOrUndefined(yield* Effect.serviceOption(BackgroundLivenessTag));
		const compactingOf =
			activity?.compactions.compactingOf ??
			Option.getOrUndefined(yield* Effect.serviceOption(SessionCompactionsTag));
		const retryingOf =
			activity?.retries.retryingOf ??
			Option.getOrUndefined(yield* Effect.serviceOption(SessionRetriesTag));
		const hintDismissals =
			activity?.hintDismissals ??
			Option.getOrUndefined(
				yield* Effect.serviceOption(SessionWorkspaceHintStateTag),
			);
		const overlay = {
			...(backgroundOf === undefined ? {} : { backgroundOf }),
			...(hintDismissals === undefined ? {} : { hintDismissals }),
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
						const compacting = compactingOf?.(session.id);
						const retrying = retryingOf?.(session.id);
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
			list: (options?: Parameters<ReadQueryEffect["listSessionInfos"]>[0]) =>
				readQuery
					.listSessionInfos({ ...overlay, ...options })
					.pipe(Effect.flatMap(decorate)),
			read: (range?: Parameters<ReadQueryEffect["readSessionList"]>[0]) =>
				readQuery.readSessionList({ ...overlay, ...range }).pipe(
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
