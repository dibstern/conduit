import { statSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import { Data, Effect, Exit, Layer, Option } from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import {
	type createSessionGitCache,
	daemonSessionGitCache,
} from "../../../git/session-git.js";
import type { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	makeReadQueryEffect,
	type ReadQueryEffect,
	ReadQueryEffectTag,
	type SessionScope,
} from "../../../persistence/effect/read-query-effect.js";
import { computeProjectGroups } from "../../../project-grouping.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import { shouldArchiveIdleSession } from "../../../session/auto-archive-policy.js";
import { readPersistedAutoArchiveFacts } from "../../../session/auto-archive-sweep.js";
import { shouldSettleIdleSession } from "../../../session/auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "../../../session/auto-settle-reader.js";
import { getScopeGroupKey } from "../../../session-scope.js";
import type {
	ArchivedSessionQueryOptions,
	ArchivedSessionQueryResult,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	SessionInfo,
} from "../../../shared-types.js";
import type { StoredProject } from "../../../types.js";
import type { AccountDirectory } from "./account-directory.js";
import { DaemonStoreAvailability } from "./daemon-store-availability.js";
import { projectReadDatabase } from "./project-read-database.js";
import {
	allProjects,
	type ProjectRegistryTag,
} from "./project-registry-service.js";
import type { SessionActivityTag } from "./session-activity.js";
import { SessionDirectory } from "./session-directory.js";
import { makeSessionRows } from "./session-rows.js";

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

interface ProjectSessionCandidate {
	readonly sortKey: { readonly at: number; readonly id: string };
	readonly session: SessionInfo;
}

type SessionReadOptions = NonNullable<
	Parameters<ReadQueryEffect["listSessionInfos"]>[1]
>;

const readProjectSessions = (
	project: Pick<StoredProject, "slug" | "folders">,
	options: SessionReadOptions,
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
		const database = yield* projectReadDatabase(project, {
			prepare: true,
		});
		const readQueryLayer = Layer.effect(
			ReadQueryEffectTag,
			makeReadQueryEffect,
		).pipe(Layer.provideMerge(database));

		const sessions = yield* Effect.gen(function* () {
			const rows = yield* makeSessionRows({
				slug: projectSlug,
				folders: project.folders,
				gitCache,
				refreshGit: true,
			});
			return yield* rows.list(options);
		}).pipe(Effect.provide(readQueryLayer));
		return sessions.map(
			(session): ProjectSessionCandidate => ({
				sortKey: {
					at:
						options.orderColumn === "archived_at"
							? (session.archivedAt ?? 0)
							: session.updatedAt,
					id: session.id,
				},
				session,
			}),
		);
	});

/** Check recovery work without acquiring the project's relay or starting providers. */
export const hasProviderRecoveryCandidate = (
	project: Pick<StoredProject, "slug" | "folders">,
	openCodeInstanceIds: readonly string[],
) =>
	Effect.gen(function* () {
		const database = yield* projectReadDatabase(project);
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ needs_recovery: number }>`SELECT EXISTS (
				SELECT 1 FROM provider_command_outbox
				WHERE project_key = ${project.slug} AND provider_id = 'claude' AND effect_type = 'send_turn' AND status = 'running'
			) OR EXISTS (
				SELECT 1 FROM sessions AS session
				JOIN session_providers AS binding ON binding.session_id = session.id
				WHERE session.project_id = ${project.slug} AND binding.status = 'active'
				AND binding.provider IN ${sql.in(openCodeInstanceIds)}
				AND (session.status IN ('busy', 'retry') OR EXISTS (
					SELECT 1 FROM pending_approvals AS approval
					WHERE approval.session_id = session.id AND approval.status = 'pending'
				))
			) AS needs_recovery`;
			return rows[0]?.needs_recovery === 1;
		}).pipe(Effect.provide(database));
	});

/** Count busy/retry sessions and admitted turns awaiting their first provider event. */
export const countRunningProjectSessions = (
	project: Pick<StoredProject, "slug" | "folders">,
) =>
	Effect.gen(function* () {
		const database = yield* projectReadDatabase(project);
		return yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM (
				SELECT id FROM sessions WHERE project_id = ${project.slug} AND status IN ('busy', 'retry')
				UNION
				SELECT session_id FROM provider_command_outbox
				WHERE project_key = ${project.slug} AND effect_type = 'send_turn' AND status IN ('pending', 'running')
			)`;
			return rows[0]?.count ?? 0;
		}).pipe(Effect.provide(database));
	});

/** Probe without acquiring the project's relay. */
export const hasColdAutoSettleCandidate = (
	project: Pick<StoredProject, "slug" | "folders">,
	now: number,
	idleWindowMs: number,
) =>
	Effect.gen(function* () {
		const database = yield* projectReadDatabase(project);
		const facts = yield* readPersistedAutoSettleFacts(
			project.slug,
			now,
			undefined,
			project.folders[0],
		).pipe(Effect.provide(database));
		return [...facts.values()].some((item) =>
			shouldSettleIdleSession(item, now, idleWindowMs),
		);
	});

export const hasColdAutoArchiveCandidate = (
	project: Pick<StoredProject, "slug" | "folders">,
	now: number,
	idleWindowMs: number,
) =>
	Effect.gen(function* () {
		const database = yield* projectReadDatabase(project);
		const facts = yield* readPersistedAutoArchiveFacts(project.slug, now).pipe(
			Effect.provide(database),
		);
		return [...facts.values()].some((item) =>
			shouldArchiveIdleSession(item, now, idleWindowMs),
		);
	});

const listProjectSessions = (
	projects: readonly Pick<StoredProject, "slug" | "folders">[],
	options: SessionReadOptions,
	gitCache: ReturnType<typeof createSessionGitCache>,
) =>
	Effect.gen(function* () {
		const unavailable = yield* DaemonStoreAvailability;
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
					const reason = unavailable.get(project.slug);
					if (reason !== undefined) {
						return {
							sessions: [],
							availability: {
								projectSlug: project.slug,
								available: false as const,
								error: reason,
							},
						};
					}
					const exit = yield* Effect.exit(
						readProjectSessions(project, projectOptions, gitCache),
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
							error: String(Failure.squashCause(exit.cause)),
						},
					};
				}),
			{ concurrency: 4 },
		);

		// Use the same timestamp column for project keysets and the global merge.
		const candidates = projectResults
			.flatMap((result) => result.sessions)
			.sort((a, b) => {
				const timestampOrder = b.sortKey.at - a.sortKey.at;
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
	});

export const listDaemonSessions = (
	configDir: string,
	options: DaemonSessionQueryOptions = {},
	gitCache: ReturnType<typeof createSessionGitCache> = daemonSessionGitCache,
): Effect.Effect<
	DaemonSessionQueryResult,
	never,
	ProjectRegistryTag | AccountDirectory | SessionActivityTag | PersistenceStore
> =>
	Effect.gen(function* () {
		const registered = yield* allProjects;
		const groupKey = getScopeGroupKey(options.scope);
		const defaultMode =
			loadRelaySettings(configDir).defaultGroupingMode ?? "repository";
		const groups =
			groupKey === null
				? null
				: computeProjectGroups(
						registered.map((project) => ({
							...project,
							groupingMode: project.groupingMode ?? defaultMode,
						})),
					);
		// Scope before querying or merging any project pages. The same pure
		// function owns membership in the registry and in the frontend.
		const projects = registered.filter(
			(project) =>
				(options.scope === undefined ||
					(groupKey === null
						? project.slug === options.scope
						: groups?.[project.slug]?.key === groupKey)) &&
				project.slug !== options.exclude,
		);
		const result = yield* listProjectSessions(
			projects,
			{
				excludeArchived: options.includeArchived !== true,
				...(options.roots !== undefined ? { roots: options.roots } : {}),
				...(options.limit !== undefined ? { limit: options.limit } : {}),
				...(options.search !== undefined ? { titleQuery: options.search } : {}),
				...(options.cursor !== undefined
					? { before: { at: options.cursor.updatedAt, id: options.cursor.id } }
					: {}),
			},
			gitCache,
		);
		return {
			...result,
			nextCursor: result.nextCursor
				? { updatedAt: result.nextCursor.at, id: result.nextCursor.id }
				: null,
		};
	}).pipe(Effect.withSpan("daemonSessions.list"));

export const listArchivedSessions = (
	options: ArchivedSessionQueryOptions = {},
	gitCache: ReturnType<typeof createSessionGitCache> = daemonSessionGitCache,
): Effect.Effect<
	ArchivedSessionQueryResult,
	never,
	ProjectRegistryTag | AccountDirectory | SessionActivityTag | PersistenceStore
> =>
	Effect.gen(function* () {
		const result = yield* listProjectSessions(
			yield* allProjects,
			{
				roots: true,
				archivedOnly: true,
				orderColumn: "archived_at",
				...(options.limit !== undefined ? { limit: options.limit } : {}),
				...(options.cursor !== undefined
					? { before: { at: options.cursor.archivedAt, id: options.cursor.id } }
					: {}),
			},
			gitCache,
		);
		return {
			...result,
			nextCursor: result.nextCursor
				? { archivedAt: result.nextCursor.at, id: result.nextCursor.id }
				: null,
		};
	}).pipe(Effect.withSpan("daemonSessions.listArchived"));

export const resolveDaemonSession = (sessionId: string) =>
	Effect.gen(function* () {
		const directory = yield* SessionDirectory;
		return yield* directory
			.projectOf(sessionId)
			.pipe(Effect.map(Option.getOrNull));
	}).pipe(Effect.withSpan("daemonSessions.resolve"));

/** Active bindings take precedence after provider switches; legacy rows use the session id. */
export const findOpenCodeSession = (
	scope: SessionScope,
	instanceId: string,
	providerSessionId: string,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			id: string;
		}>`SELECT session.id FROM sessions AS session
			LEFT JOIN session_providers AS binding ON binding.id = (
				SELECT id FROM session_providers WHERE session_id = session.id AND status = 'active'
				ORDER BY activated_at DESC, id DESC LIMIT 1
			)
			WHERE session.project_id IN ${sql.in(scope.projectIds)}
			AND COALESCE(binding.provider, session.provider) = ${instanceId}
			AND COALESCE(binding.provider_sid, session.provider_sid, session.id) = ${providerSessionId}
			LIMIT 2`;
		if (rows.length > 1)
			return yield* Effect.fail(
				new Error("OpenCode session has ambiguous Conduit bindings"),
			);
		return rows[0]?.id;
	});

/** Resolve a provider id within its owning instance, including cold project stores. */
export const resolveDaemonOpenCodeSession = (
	instanceId: string,
	providerSessionId: string,
) =>
	Effect.gen(function* () {
		let match: { projectSlug: string; sessionId: string } | undefined;
		for (const project of yield* allProjects) {
			const database = yield* projectReadDatabase(project, {
				prepare: true,
			});
			const sessionId = yield* findOpenCodeSession(
				{ projectIds: [project.slug] },
				instanceId,
				providerSessionId,
			).pipe(Effect.provide(database));
			if (sessionId !== undefined) {
				if (match !== undefined)
					return yield* Effect.fail(
						new Error(
							"OpenCode session belongs to more than one Conduit project",
						),
					);
				match = { projectSlug: project.slug, sessionId };
			}
		}
		return match;
	}).pipe(Effect.withSpan("daemonSessions.resolveOpenCode"));
