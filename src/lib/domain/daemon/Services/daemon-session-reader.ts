import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Reactivity } from "@effect/experimental";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Data, Effect, Either, Exit, Layer } from "effect";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import {
	pendingApprovalCountsByType,
	sessionRowsToSessionInfoList,
} from "../../../persistence/session-list-adapter.js";
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

		const databasePath = resolve(projectDirectory, ".conduit", "events.db");
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

		const { rows, pendingApprovals, lineage, statuses } = yield* Effect.gen(
			function* () {
				const readQuery = yield* ReadQueryEffectTag;
				const rows = yield* readQuery.listSessions({
					...(options.roots !== undefined ? { roots: options.roots } : {}),
					...(options.limit !== undefined ? { limit: options.limit } : {}),
					...(options.search !== undefined
						? { titleQuery: options.search }
						: {}),
					...(options.cursor !== undefined ? { before: options.cursor } : {}),
				});
				const pendingApprovals =
					yield* readQuery.countPendingApprovalsBySession();
				const lineage = yield* readQuery.getSessionLineage();
				const statuses = yield* readQuery.getAllSessionStatuses();
				return { rows, pendingApprovals, lineage, statuses };
			},
		).pipe(Effect.provide(readQueryLayer));
		const pending = pendingApprovalCountsByType(pendingApprovals);

		const sessions = sessionRowsToSessionInfoList(Array.from(rows), {
			parentMap: new Map(
				lineage.rows.flatMap((row) =>
					row.parent_id === null ? [] : [[row.id, row.parent_id] as const],
				),
			),
			statuses: Object.fromEntries(
				Object.entries(statuses).map(([id, type]) => [id, { type }]),
			),
			pendingQuestionCounts: pending.questions,
			pendingPermissionCounts: pending.permissions,
		});
		const sortKeys = new Map(
			rows.map((row) => [
				row.id,
				{ updatedAt: row.updated_at, id: row.id } satisfies DaemonSessionCursor,
			]),
		);
		return sessions.flatMap((session): ProjectSessionCandidate[] => {
			const sortKey = sortKeys.get(session.id);
			return sortKey === undefined
				? []
				: [{ sortKey, session: { ...session, projectSlug } }];
		});
	});

export const listDaemonSessions = (
	options: DaemonSessionQueryOptions = {},
): Effect.Effect<DaemonSessionQueryResult, never, ProjectRegistryTag> =>
	Effect.gen(function* () {
		const projects = yield* allProjects;
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
