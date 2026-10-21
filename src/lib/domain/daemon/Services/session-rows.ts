import { Array as Arr, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
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
import { sessionRunOwnersQuery } from "../../../provider/session-run-settlement.js";
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
export const makeSessionRows = (
	scope:
		| SessionRowsScope
		| { readonly projects: () => readonly SessionRowsScope[] },
) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const accounts = yield* AccountDirectory;
		const activity = yield* SessionActivityTag;
		const projects = () => ("projects" in scope ? scope.projects() : [scope]);
		const [first, ...rest] = projects();
		const sessionScope: SessionScope | undefined = first && {
			projectIds: [first.slug, ...rest.map(({ slug }) => slug)],
		};
		const overlay = {
			backgroundOf: activity.background.backgroundOf,
			hintDismissals: activity.hintDismissals,
		};
		const readOwned = <T>(
			read: Effect.Effect<T, ReadQueryEffectError | SqlError>,
			items: (value: T) => readonly { readonly id: string }[],
		): Effect.Effect<
			{
				readonly value: T;
				readonly owners: ReadonlyMap<string, string> | undefined;
			},
			ReadQueryEffectError | SqlError
		> =>
			"projects" in scope
				? sql.withTransaction(
						Effect.gen(function* () {
							const value = yield* read;
							const ids = items(value).map(({ id }) => id);
							const owners =
								ids.length === 0
									? new Map<string, string>()
									: new Map(
											(yield* sql<{ id: string; project_id: string }>`
										SELECT id, project_id FROM sessions
										WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`).map(
												({ id, project_id }) => [id, project_id],
											),
										);
							return { value, owners };
						}),
					)
				: read.pipe(Effect.map((value) => ({ value, owners: undefined })));
		const decorate = <T extends Omit<SessionInfo, "projectSlug" | "accountId">>(
			sessions: readonly T[],
			owners?: ReadonlyMap<string, string>,
		) =>
			Effect.gen(function* () {
				const scopes = projects();
				const bySlug = new Map(
					scopes.map((project) => [project.slug, project]),
				);
				// Cold project reads have no relay git-change signal to warm this cache.
				for (const project of scopes) {
					if (!project.refreshGit || !project.gitCache) continue;
					const cache = project.gitCache;
					const directories = new Set(
						sessions.flatMap((session) =>
							owners && owners.get(session.id) !== project.slug
								? []
								: [
										effectiveWorkingDirectory(
											project.folders[0],
											session.workspace,
										),
										...effectiveSessionFolders(
											project.folders,
											session.workspace,
										).map(({ directory }) => directory),
									],
						),
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
						const project = owners
							? bySlug.get(owners.get(session.id) ?? "")
							: scopes[0];
						if (project === undefined)
							return yield* new ReadQueryEffectError({
								operation: "sessionRows.owner",
								cause: `No registered owner for session ${session.id}`,
							});
						const accountId = accountIds.get(session.id);
						const keepsSteers =
							session.status !== "idle" &&
							!!accountId &&
							(yield* accounts.resolve({ _tag: "Id", id: accountId }).pipe(
								Effect.map(
									(account) =>
										getProviderDriver(account.driver)
											?.keepsPendingSteersOnInterrupt === true,
								),
								Effect.catchTag("AccountUnroutable", () =>
									Effect.succeed(false),
								),
							));
						// Mirrors Stop's no-op rule: nothing to stop when only retained steers remain.
						const stop =
							session.status === "idle"
								? undefined
								: yield* sessionRunOwnersQuery(sql, session.id, {
										confirmedStop: true,
										excludeRetainedSteers: keepsSteers,
									});
						const compacting = activity.compactions.compactingOf(session.id);
						const retrying = activity.retries.retryingOf(session.id);
						const enriched = yield* withSessionWorktreeStatus(
							withCachedSessionGit(
								{
									...session,
									projectSlug: project.slug,
									accountId: accountIds.get(session.id) ?? null,
								},
								project.folders,
								project.gitCache,
							),
							{
								slug: project.slug,
								projectDir: project.folders[0],
								extraFolders: project.folders.slice(1),
							},
						).pipe(Effect.provideService(SqlClient.SqlClient, sql));
						return {
							...session,
							...enriched,
							...(stop === undefined
								? {}
								: {
										canStop: !(stop.owners.length === 0 && stop.retainedSteers),
									}),
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
				sessionScope === undefined
					? Effect.succeed([])
					: readOwned(
							readQuery.listSessionInfos(sessionScope, {
								...options,
								...overlay,
							}),
							(sessions) => sessions,
						).pipe(
							Effect.flatMap(({ value, owners }) => decorate(value, owners)),
						),
			read: (
				range?: Omit<
					NonNullable<Parameters<ReadQueryEffect["readSessionList"]>[1]>,
					"backgroundOf" | "hintDismissals"
				>,
			): Effect.Effect<
				Omit<
					Effect.Success<ReturnType<ReadQueryEffect["readSessionList"]>>,
					"rows"
				> & {
					readonly rows: readonly {
						readonly item: SessionInfo;
						readonly version: number;
					}[];
				},
				ReadQueryEffectError | SqlError
			> =>
				sessionScope === undefined
					? sql<{
							value: number;
						}>`SELECT value FROM read_model_counter WHERE id = 1`.pipe(
							Effect.map(([counter]) => ({
								rows: [],
								version: counter?.value ?? 0,
								listing: [],
								removedSince: 0,
							})),
						)
					: readOwned(
							readQuery.readSessionList(sessionScope, { ...range, ...overlay }),
							(list) => list.rows.map(({ item }) => item),
						).pipe(
							Effect.flatMap(({ value: list, owners }) =>
								decorate(
									list.rows.map(({ item }) => item),
									owners,
								).pipe(
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
