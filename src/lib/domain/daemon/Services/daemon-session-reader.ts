import { statSync } from "node:fs";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Data, Effect, Either, Exit, Layer } from "effect";
import {
	type createSessionGitCache,
	daemonSessionGitCache,
} from "../../../git/session-git.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import { shouldSettleIdleSession } from "../../../session/auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "../../../session/auto-settle-reader.js";
import type {
	DaemonSessionCursor,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	SessionInfo,
} from "../../../shared-types.js";
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
	projectSlug: string,
	projectDirectory: string,
	options: DaemonSessionQueryOptions,
	gitCache: ReturnType<typeof createSessionGitCache>,
) =>
	Effect.gen(function* () {
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

		const databasePath = projectEventsDbPath({ directory: projectDirectory });
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
		const gitContext = gitCache.peek(projectDirectory);
		return sessions.map(
			(session): ProjectSessionCandidate => ({
				sortKey: { updatedAt: session.updatedAt, id: session.id },
				session: {
					...session,
					projectSlug,
					...(gitContext ? { git: gitContext } : {}),
				},
			}),
		);
	});

/** Check outstanding Claude admissions without acquiring the project's relay. */
export const hasRunningClaudeTurn = (projectDirectory: string) =>
	Effect.gen(function* () {
		const databasePath = projectEventsDbPath({ directory: projectDirectory });
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

/** Use the same read-only SQLite path as the daemon-wide session list. */
export const hasColdAutoSettleCandidate = (
	projectDirectory: string,
	now: number,
	idleWindowMs: number,
) =>
	Effect.gen(function* () {
		const databasePath = projectEventsDbPath({ directory: projectDirectory });
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
	options: DaemonSessionQueryOptions = {},
	gitCache: ReturnType<typeof createSessionGitCache> = daemonSessionGitCache,
): Effect.Effect<DaemonSessionQueryResult, never, ProjectRegistryTag> =>
	Effect.gen(function* () {
		const projects = (yield* allProjects).filter(
			(project) =>
				options.scope === undefined || project.slug === options.scope,
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
						readProjectSessions(
							project.slug,
							project.directory,
							projectOptions,
							gitCache,
						),
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

export const resolveDaemonSession = (sessionId: string) =>
	Effect.gen(function* () {
		for (const project of yield* allProjects) {
			const databasePath = projectEventsDbPath(project);
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
