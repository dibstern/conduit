import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Brand, Effect, HashMap, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SessionWorkspaceSchema } from "../../contracts/session-workspace.js";
import {
	type WorkspaceMissing,
	WorkspaceMissingSchema,
} from "../../contracts/worktree.js";
import { ProjectRegistryTag } from "../../domain/daemon/Services/project-registry-service.js";
import { labelProjectFolders } from "../../project-folders.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../session/session-workspace.js";
import {
	type ProjectInfo,
	type SessionGit,
	SessionGitSchema,
} from "../../shared-types.js";

export type CanonicalDirectory = string & Brand.Brand<"CanonicalDirectory">;
const directoryBrand = Brand.nominal<CanonicalDirectory>();

/** Preserve one identity through symlink aliases, including a missing child. */
export const canonicalDirectory = (directory: string): CanonicalDirectory => {
	let ancestor = resolve(directory);
	const children: string[] = [];
	let links = 0;
	for (;;) {
		try {
			return directoryBrand(
				join(realpathSync(ancestor), ...children.reverse()),
			);
		} catch {
			try {
				if (links < 40 && lstatSync(ancestor).isSymbolicLink()) {
					links++;
					ancestor = resolve(dirname(ancestor), readlinkSync(ancestor));
					continue;
				}
			} catch {
				// Resolve missing children from the nearest existing ancestor.
			}
			const parent = dirname(ancestor);
			if (parent === ancestor) return directoryBrand(resolve(directory));
			children.push(basename(ancestor));
			ancestor = parent;
		}
	}
};

const decodeGit = Schema.decodeUnknownOption(
	Schema.fromJsonString(SessionGitSchema),
);
const decodeMissing = Schema.decodeUnknownOption(
	Schema.fromJsonString(WorkspaceMissingSchema),
);

const readPublications = (directories: readonly string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const keys = [
			...new Set(
				directories.flatMap((directory) => [
					resolve(directory),
					canonicalDirectory(directory),
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
			[...rows]
				.sort(
					(left, right) =>
						Number(left.directory === canonicalDirectory(left.directory)) -
						Number(right.directory === canonicalDirectory(right.directory)),
				)
				.map(
					(row) =>
						[
							canonicalDirectory(row.directory),
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
		const primary = effectiveWorkingDirectory(roots[0], workspace);
		const entries = effectiveSessionFolders(roots, workspace);
		const publications = yield* readPublications([
			primary,
			...entries.map(({ directory }) => directory),
		]);
		const labels = labelProjectFolders(roots);
		const statuses = entries.flatMap(({ root, directory, shared }, index) => {
			const git = publications.get(canonicalDirectory(directory))?.git;
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
		const git = publications.get(canonicalDirectory(primary))?.git;
		const missing = entries.flatMap(({ root, directory }) => {
			const state = publications.get(
				canonicalDirectory(directory),
			)?.workspaceMissing;
			return state ? [{ folder: root, ...state }] : [];
		});
		const firstMissing = missing[0];
		const workspaceMissing: WorkspaceMissing | undefined = firstMissing && {
			path: firstMissing.path,
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
		Effect.map((state) => state?.git),
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
		const publications = Option.isSome(sql)
			? yield* readPublications(
					projects.flatMap(({ folders }) => folders),
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
				const git = publications.get(canonicalDirectory(root))?.git;
				return git
					? [{ ...git, root, label: labels[index]?.label ?? root }]
					: [];
			});
			const primary = publications.get(
				canonicalDirectory(project.folders[0]),
			)?.git;
			return {
				...project,
				missing: !existsSync(project.folders[0]),
				...(primary || folders.length ? { git: { ...primary, folders } } : {}),
			};
		});
	});
