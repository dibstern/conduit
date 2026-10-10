import { statSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Data, Effect, Either, Exit, Layer } from "effect";
import {
	type createSessionGitCache,
	daemonSessionGitCache,
	withCachedSessionGit,
} from "../../../git/session-git.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import { shouldSettleIdleSession } from "../../../session/auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "../../../session/auto-settle-reader.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import type {
	DaemonSessionCursor,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	SessionInfo,
} from "../../../shared-types.js";
import type { StoredProject } from "../../../types.js";
import {
	allProjects,
	type ProjectRegistryTag,
} from "./project-registry-service.js";

class DaemonSessionReadError extends Data.TaggedError(
	"DaemonSessionReadError",
)<{
	readonly projectSlug: string;
	readonly cause: unknown;
}> {
	get message(): string {
		return this.cause instanceof Error
			? this.cause.message
			: String(this.cause);
	}
}

const isMissingPathError = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"code" in cause &&
	cause.code === "ENOENT";

interface ProjectSessionCandidate {
	readonly sortKey: DaemonSessionCursor;
	readonly session: SessionInfo;
}

const readProjectSessions = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	options: DaemonSessionQueryOptions,
	gitCache: ReturnType<typeof createSessionGitCache>,
) =>
	Effect.gen(function* () {
		const {
			slug: projectSlug,
			folders: [projectDirectory],
		} = project;
		const directory = yield* Effect.try({
			try: () => statSync(projectDirectory),
			catch: (cause) => new DaemonSessionReadError({ projectSlug, cause }),
		});
		if (!directory.isDirectory()) {
			return yield* new DaemonSessionReadError({
				projectSlug,
				cause: `Project path is not a directory: ${projectDirectory}`,
			});
		}
		if (gitCache.isStale(projectDirectory))
			void gitCache.refresh(projectDirectory);

		const databasePath = projectEventsDbPath({ configDir, ...project });
		const databaseStat = yield* Effect.either(
			Effect.try({
				try: () => statSync(databasePath),
				catch: (cause) => cause,
			}),
		);
		if (Either.isLeft(databaseStat)) {
			if (isMissingPathError(databaseStat.left)) {
				return [];
			}
			return yield* new DaemonSessionReadError({
				projectSlug,
				cause: databaseStat.left,
			});
		}

		const sqliteLayer = SqliteNode.layer({
			filename: databasePath,
			readonly: true,
			disableWAL: true,
		}).pipe(Layer.provide(Reactivity.layer));
		const readQueryLayer = Layer.effect(
			ReadQueryEffectTag,
			makeReadQueryEffect,
		).pipe(Layer.provide(sqliteLayer));

		const sessions = yield* Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			return yield* readQuery.listSessionInfos({
				...(options.roots !== undefined ? { roots: options.roots } : {}),
				...(options.limit !== undefined ? { limit: options.limit } : {}),
				...(options.search !== undefined ? { titleQuery: options.search } : {}),
				...(options.cursor !== undefined ? { before: options.cursor } : {}),
			});
		}).pipe(Effect.provide(readQueryLayer));
		const directories = new Set(
			sessions.map((session) =>
				effectiveWorkingDirectory(projectDirectory, session.workspace),
			),
		);
		yield* Effect.tryPromise({
			try: () =>
				Promise.all(
					[...directories]
						.filter((path) => gitCache.isStale(path))
						.map((path) => gitCache.refresh(path)),
				),
			catch: (cause) => new DaemonSessionReadError({ projectSlug, cause }),
		});
		return sessions.map(
			(session): ProjectSessionCandidate => ({
				sortKey: { updatedAt: session.updatedAt, id: session.id },
				session: {
					...withCachedSessionGit(session, projectDirectory, gitCache),
					projectSlug,
				},
			}),
		);
	});

/** Check outstanding Claude admissions without acquiring the project's relay. */
export const hasRunningClaudeTurn = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
) =>
	Effect.gen(function* () {
		const databasePath = projectEventsDbPath({ configDir, ...project });
		const databaseStat = yield* Effect.either(
			Effect.try({
				try: () => statSync(databasePath),
				catch: (cause) => cause,
			}),
		);
		if (Either.isLeft(databaseStat)) {
			if (isMissingPathError(databaseStat.left)) return false;
			return yield* Effect.fail(databaseStat.left);
		}
		const sqliteLayer = SqliteNode.layer({
			filename: databasePath,
			readonly: true,
			disableWAL: true,
		}).pipe(Layer.provide(Reactivity.layer));
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ has_running_turn: number }>`SELECT EXISTS (
				SELECT 1 FROM provider_command_outbox
				WHERE provider_id = 'claude' AND effect_type = 'send_turn' AND status = 'running'
			) AS has_running_turn`;
			return rows[0]?.has_running_turn === 1;
		}).pipe(Effect.provide(sqliteLayer));
	});

/** Count busy/retry sessions and admitted turns awaiting their first provider event. */
export const countRunningProjectSessions = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
) =>
	Effect.gen(function* () {
		const databasePath = projectEventsDbPath({ configDir, ...project });
		const databaseStat = yield* Effect.either(
			Effect.try({
				try: () => statSync(databasePath),
				catch: (cause) => cause,
			}),
		);
		if (Either.isLeft(databaseStat)) {
			if (isMissingPathError(databaseStat.left)) return 0;
			return yield* Effect.fail(databaseStat.left);
		}
		const sqliteLayer = SqliteNode.layer({
			filename: databasePath,
			readonly: true,
			disableWAL: true,
		}).pipe(Layer.provide(Reactivity.layer));
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM (
				SELECT id FROM sessions WHERE status IN ('busy', 'retry')
				UNION
				SELECT session_id FROM provider_command_outbox
				WHERE effect_type = 'send_turn' AND status IN ('pending', 'running')
			)`;
			return rows[0]?.count ?? 0;
		}).pipe(Effect.provide(sqliteLayer));
	});

/** Use the same read-only SQLite path as the daemon-wide session list. */
export const hasColdAutoSettleCandidate = (
	project: Pick<StoredProject, "slug" | "folders">,
	configDir: string,
	now: number,
	idleWindowMs: number,
) =>
	Effect.gen(function* () {
		const databasePath = projectEventsDbPath({ configDir, ...project });
		const databaseStat = yield* Effect.either(
			// Keep the raw error: the shorthand form wraps it in UnknownException,
			// hiding the ENOENT code that marks a project with no store yet.
			Effect.try({
				try: () => statSync(databasePath),
				catch: (cause) => cause,
			}),
		);
		if (Either.isLeft(databaseStat)) {
			if (isMissingPathError(databaseStat.left)) return false;
			return yield* Effect.fail(databaseStat.left);
		}
		const sqliteLayer = SqliteNode.layer({
			filename: databasePath,
			readonly: true,
			disableWAL: true,
		}).pipe(Layer.provide(Reactivity.layer));
		const facts = yield* readPersistedAutoSettleFacts(now).pipe(
			Effect.provide(sqliteLayer),
		);
		return [...facts.values()].some((item) =>
			shouldSettleIdleSession(item, now, idleWindowMs),
		);
	});

export const listDaemonSessions = (
	configDir: string,
	options: DaemonSessionQueryOptions = {},
	gitCache: ReturnType<typeof createSessionGitCache> = daemonSessionGitCache,
): Effect.Effect<DaemonSessionQueryResult, never, ProjectRegistryTag> =>
	Effect.gen(function* () {
		const projects = (yield* allProjects).filter(
			(project) =>
				(options.scope === undefined || project.slug === options.scope) &&
				project.slug !== options.exclude,
		);
		const limit =
			options.limit === undefined
				? undefined
				: Math.max(0, Math.floor(options.limit));
		// One bounded lookahead row per project is necessary to distinguish an
		// exhausted project from one whose result count exactly equals the page size.
		const projectLimit = limit === undefined || limit === 0 ? limit : limit + 1;
		const projectOptions = {
			...options,
			...(projectLimit !== undefined ? { limit: projectLimit } : {}),
		};
		const projectResults = yield* Effect.forEach(
			projects,
			(project) =>
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						readProjectSessions(project, configDir, projectOptions, gitCache),
					);
					if (Exit.isSuccess(exit)) {
						return {
							sessions: exit.value,
							availability: {
								projectSlug: project.slug,
								available: true as const,
							},
						};
					}
					return {
						sessions: [],
						availability: {
							projectSlug: project.slug,
							available: false as const,
							error: String(Cause.squash(exit.cause)),
						},
					};
				}),
			{ concurrency: 4 },
		);

		// Merge with the raw SQL sort key. SessionInfo.updatedAt may be a parsed
		// string or absent, which would disagree with the integer keyset predicate.
		const candidates = projectResults
			.flatMap((result) => result.sessions)
			.sort((a, b) => {
				const timestampOrder = b.sortKey.updatedAt - a.sortKey.updatedAt;
				if (timestampOrder !== 0) return timestampOrder;
				if (a.sortKey.id === b.sortKey.id) return 0;
				return a.sortKey.id < b.sortKey.id ? 1 : -1;
			});
		const page = limit === undefined ? candidates : candidates.slice(0, limit);
		// This is exact: the per-project lookahead means a non-overflowing merge has
		// exhausted every project, while an overflow contains a real next row.
		const hasMore = limit !== undefined && candidates.length > limit;
		const last = page.at(-1);
		const nextCursor = hasMore && last !== undefined ? last.sortKey : null;

		return {
			sessions: page.map((candidate) => candidate.session),
			availability: projectResults.map((result) => result.availability),
			hasMore,
			nextCursor,
		};
	}).pipe(Effect.withSpan("daemonSessions.list"));

export const resolveDaemonSession = (configDir: string, sessionId: string) =>
	Effect.gen(function* () {
		for (const project of yield* allProjects) {
			const databasePath = projectEventsDbPath({ configDir, ...project });
			const result = yield* Effect.exit(
				Effect.gen(function* () {
					yield* Effect.try(() => statSync(databasePath));
					return yield* Effect.gen(function* () {
						const readQuery = yield* ReadQueryEffectTag;
						return yield* readQuery.getSession(sessionId);
					}).pipe(
						Effect.provide(
							Layer.effect(ReadQueryEffectTag, makeReadQueryEffect).pipe(
								Layer.provide(
									SqliteNode.layer({
										filename: databasePath,
										readonly: true,
										disableWAL: true,
									}).pipe(Layer.provide(Reactivity.layer)),
								),
							),
						),
					);
				}),
			);
			if (Exit.isSuccess(result) && result.value !== undefined) {
				return project.slug;
			}
		}
		return null;
	}).pipe(Effect.withSpan("daemonSessions.resolve"));
