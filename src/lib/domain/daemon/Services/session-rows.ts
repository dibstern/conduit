import { Array as Arr, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
	type SessionScope,
} from "../../../persistence/effect/read-query-effect.js";
import { readPublishedSessionGit } from "../../../persistence/effect/session-git-publication.js";
import { sessionRunOwnersQuery } from "../../../provider/session-run-settlement.js";
import type { SessionInfo } from "../../../shared-types.js";
import { withSessionWorktreeStatus } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "./account-directory.js";
import { ReadRequest } from "./read-request.js";
import { resolveSessionAccountIds } from "./session-accounts.js";
import { SessionActivityTag } from "./session-activity.js";
import { SessionGit } from "./session-git.js";

export interface SessionRowsScope {
	readonly slug: string;
	readonly folders: readonly [string, ...string[]];
}

type SessionListOptions = Omit<
	NonNullable<Parameters<ReadQueryEffect["listSessionInfos"]>[1]>,
	"backgroundOf" | "hintDismissals"
>;

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
		const sessionGit = yield* Effect.serviceOption(SessionGit);
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
						const git = yield* (
							sessionGit._tag === "Some"
								? sessionGit.value.read(session.id)
								: readPublishedSessionGit(session.id, project.folders)
						).pipe(
							Effect.provideService(ReadRequest, "ListSessions"),
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.mapError(
								(cause) =>
									new ReadQueryEffectError({
										operation: "sessionRows.git",
										cause,
									}),
							),
						);
						const enriched = yield* withSessionWorktreeStatus(
							{
								...session,
								git,
								projectSlug: project.slug,
								accountId: accountIds.get(session.id) ?? null,
							},
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

		const page = (options?: SessionListOptions) =>
			sessionScope === undefined
				? Effect.succeed({ value: [], owners: undefined })
				: readOwned(
						readQuery.listSessionInfos(sessionScope, {
							...options,
							...overlay,
						}),
						(sessions) => sessions,
					);

		return {
			list: (options?: SessionListOptions) =>
				sessionScope === undefined
					? Effect.succeed([])
					: sql.withTransaction(
							page(options).pipe(
								Effect.flatMap(({ value, owners }) => decorate(value, owners)),
							),
						),
			/**
			 * The row, its companion count and published git share one SQL snapshot.
			 */
			listWith: <A, E, R>(
				options: SessionListOptions | undefined,
				alongside: Effect.Effect<A, E, R>,
			) =>
				sql.withTransaction(
					Effect.all([alongside, page(options)]).pipe(
						Effect.flatMap(([companion, { value, owners }]) =>
							decorate(value, owners).pipe(
								Effect.map((sessions) => ({ sessions, companion })),
							),
						),
					),
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
					: sql.withTransaction(
							readOwned(
								readQuery.readSessionList(sessionScope, {
									...range,
									...overlay,
								}),
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
						),
		};
	});
