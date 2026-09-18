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

const updatedAtMillis = (session: SessionInfo): number => {
	if (typeof session.updatedAt === "number") return session.updatedAt;
	if (typeof session.updatedAt === "string") {
		const parsed = Date.parse(session.updatedAt);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
};

const readProjectSessions = (
	projectSlug: string,
	projectDirectory: string,
	roots: boolean | undefined,
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

		const { rows, pendingApprovals } = yield* Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const rows = yield* readQuery.listSessions(
				roots === undefined ? undefined : { roots },
			);
			const pendingApprovals =
				yield* readQuery.countPendingApprovalsBySession();
			return { rows, pendingApprovals };
		}).pipe(Effect.provide(readQueryLayer));
		const pending = pendingApprovalCountsByType(pendingApprovals);

		return sessionRowsToSessionInfoList(Array.from(rows), {
			pendingQuestionCounts: pending.questions,
			pendingPermissionCounts: pending.permissions,
		}).map((session) => ({
			...session,
			projectSlug,
		}));
	});

export const listDaemonSessions = (
	options: DaemonSessionQueryOptions = {},
): Effect.Effect<DaemonSessionQueryResult, never, ProjectRegistryTag> =>
	Effect.gen(function* () {
		const projects = yield* allProjects;
		const projectResults = yield* Effect.forEach(
			projects,
			(project) =>
				Effect.gen(function* () {
					const exit = yield* Effect.exit(
						readProjectSessions(project.slug, project.directory, options.roots),
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

		const sessions = projectResults
			.flatMap((result) => result.sessions)
			.sort((a, b) => updatedAtMillis(b) - updatedAtMillis(a));
		const limitedSessions =
			options.limit === undefined
				? sessions
				: sessions.slice(0, Math.max(0, Math.floor(options.limit)));

		return {
			sessions: limitedSessions,
			availability: projectResults.map((result) => result.availability),
		};
	}).pipe(Effect.withSpan("daemonSessions.list"));
