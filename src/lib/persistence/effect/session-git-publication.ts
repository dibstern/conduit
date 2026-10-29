import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, HashMap, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
} from "../../contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	WorkspaceMissingSchema,
} from "../../contracts/worktree.js";
import { ProjectRegistryTag } from "../../domain/daemon/Services/project-registry-service.js";
import { labelProjectFolders } from "../../project-folders.js";
import { sessionFolders } from "../../session/session-workspace.js";
import {
	type CanonicalDirectory,
	type WorkspaceDirectories,
	workspaceDirectories,
} from "../../session/workspace-directories.js";
import {
	type ProjectInfo,
	type SessionGit,
	SessionGitSchema,
} from "../../shared-types.js";
import { readSessionWorktreeOwnershipSnapshot } from "./session-worktree-ownership.js";

export {
	type CanonicalDirectory,
	canonicalDirectory,
} from "../../session/workspace-directories.js";

const decodeGit = Schema.decodeUnknownOption(
	Schema.fromJsonString(SessionGitSchema),
);
const decodeMissing = Schema.decodeUnknownOption(
	Schema.fromJsonString(WorkspaceMissingSchema),
);

const readPublications = (
	directories: readonly string[],
	workspace: SessionWorkspace | undefined,
	identities: WorkspaceDirectories["Service"],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const keys = [
			...new Set(
				directories.flatMap((directory) => [
					resolve(directory),
					identities.workspaceDirectory(directory, workspace),
				]),
			),
		];
		const rows = yield* sql<{
			directory: string;
			git: string | null;
			workspace_missing: string | null;
			version: number;
		}>`SELECT directory, git, workspace_missing, version FROM session_git_published
			WHERE directory IN ${sql.in(keys)}`;
		return new Map(
			rows
				.map((row) => ({
					row,
					directory: identities.publicationDirectory(row.directory),
				}))
				.sort(
					(left, right) =>
						Number(left.row.directory === left.directory) -
						Number(right.row.directory === right.directory),
				)
				.map(
					({ row, directory }) =>
						[
							directory,
							{
								git:
									row.git === null
										? undefined
										: Option.getOrUndefined(decodeGit(row.git)),
								workspaceMissing:
									row.workspace_missing === null
										? undefined
										: Option.getOrUndefined(
												decodeMissing(row.workspace_missing),
											),
							},
						] as const,
				),
		);
	});

const sessionPublication = (
	sessionId: string,
	folders?: readonly [string, ...string[]],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ project_id: string; workspace: string | null }>`
			SELECT project_id, workspace FROM sessions WHERE id = ${sessionId}`;
		const row = rows[0];
		if (!row) return undefined;
		let roots = folders;
		if (!roots) {
			const registry = yield* Effect.serviceOption(ProjectRegistryTag);
			if (Option.isSome(registry)) {
				const project = HashMap.get(
					yield* Ref.get(registry.value),
					row.project_id,
				);
				if (Option.isSome(project)) roots = project.value.project.folders;
			}
		}
		if (!roots) return undefined;
		const workspace =
			row.workspace === null
				? undefined
				: Option.getOrUndefined(
						Schema.decodeUnknownOption(
							Schema.fromJsonString(SessionWorkspaceSchema),
						)(row.workspace),
					);
		const identities = yield* workspaceDirectories;
		if (workspace?.origin === "conduit") {
			const ownership = yield* readSessionWorktreeOwnershipSnapshot(
				row.project_id,
				sessionId,
			);
			if (ownership?._tag === "Owned")
				identities.rememberWorkspaceDirectories(workspace, ownership.ownership);
		}
		const {
			workspaceRoot: primary,
			effectiveFolders: entries,
			directories,
		} = sessionFolders(roots, workspace);
		const publications = yield* readPublications(
			directories,
			workspace,
			identities,
		);
		const labels = labelProjectFolders(roots);
		const statuses = entries.flatMap(({ root, directory, shared }, index) => {
			const git = publications.get(
				identities.workspaceDirectory(directory, workspace),
			)?.git;
			return git || shared
				? [
						{
							...git,
							root,
							label: labels[index]?.label ?? root,
							...(shared ? { shared } : {}),
						},
					]
				: [];
		});
		const git = publications.get(
			identities.workspaceDirectory(primary, workspace),
		)?.git;
		const missing = entries.flatMap(({ root, directory }) => {
			const state = publications.get(
				identities.workspaceDirectory(directory, workspace),
			)?.workspaceMissing;
			return state ? [{ folder: root, ...state }] : [];
		});
		const firstMissing = missing[0];
		const workspaceMissing: WorkspaceMissing | undefined = firstMissing && {
			path: firstMissing.path,
			...(firstMissing.branch ? { branch: firstMissing.branch } : {}),
			canRecreate: missing.every((entry) => entry.canRecreate),
			...(missing.find((entry) => !entry.canRecreate)?.reason
				? { reason: missing.find((entry) => !entry.canRecreate)?.reason }
				: firstMissing.reason
					? { reason: firstMissing.reason }
					: {}),
			...(entries.length > 1 ? { folders: missing } : {}),
		};
		return {
			git: git || statuses.length ? { ...git, folders: statuses } : undefined,
			workspaceMissing,
		};
	});

/** Read the committed publication in the caller's SQL snapshot. Never runs git. */
export const readPublishedSessionGit = (
	sessionId: string,
	folders?: readonly [string, ...string[]],
) =>
	sessionPublication(sessionId, folders).pipe(
		Effect.map((state): SessionGit | undefined => state?.git),
	);

export const readPublishedWorkspaceMissing = (
	sessionId: string,
	folders?: readonly [string, ...string[]],
) =>
	sessionPublication(sessionId, folders).pipe(
		Effect.map((state) => state?.workspaceMissing),
	);

/** Project rows have folder identities, rather than a session id. */
export const withPublishedProjectGit = <T extends ProjectInfo>(
	projects: readonly T[],
) =>
	Effect.gen(function* () {
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const identities = yield* workspaceDirectories;
		const publications = Option.isSome(sql)
			? yield* readPublications(
					projects.flatMap(({ folders }) => folders),
					undefined,
					identities,
				).pipe(Effect.provideService(SqlClient.SqlClient, sql.value))
			: new Map<
					CanonicalDirectory,
					{
						git: SessionGit | undefined;
						workspaceMissing: WorkspaceMissing | undefined;
					}
				>();
		return projects.map((project) => {
			const labels = labelProjectFolders(project.folders);
			const folders = project.folders.flatMap((root, index) => {
				const git = publications.get(identities.canonicalDirectory(root))?.git;
				return git
					? [{ ...git, root, label: labels[index]?.label ?? root }]
					: [];
			});
			const primary = publications.get(
				identities.canonicalDirectory(project.folders[0]),
			)?.git;
			return {
				...project,
				missing: !existsSync(project.folders[0]),
				...(primary || folders.length ? { git: { ...primary, folders } } : {}),
			};
		});
	});
