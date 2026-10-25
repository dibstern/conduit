import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Brand, Effect, HashMap, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
	type SessionWorktreeOwnership,
} from "../../contracts/session-workspace.js";
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
const canonicalDirectories = new Map<string, CanonicalDirectory>();
const ownedWorkspaceDirectories = new Map<string, CanonicalDirectory>();

/** Recorded checkout roots retain their identity even when a symlink occupies them. */
export const rememberWorkspaceDirectories = (
	workspace: SessionWorkspace,
	ownership: readonly SessionWorktreeOwnership[],
): void => {
	const roots = ownership.map(({ path }) => resolve(path));
	const isOwned = (path: string) =>
		roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
	for (const directory of Object.values(workspace.worktrees)) {
		const path = resolve(directory);
		const key = isOwned(path) ? directoryBrand(path) : canonicalDirectory(path);
		if (!isOwned(key)) continue;
		ownedWorkspaceDirectories.set(path, key);
		ownedWorkspaceDirectories.set(key, key);
	}
};

export const workspaceDirectory = (
	directory: string,
	workspace?: SessionWorkspace | null,
): CanonicalDirectory =>
	workspace?.origin === "conduit" &&
	Object.values(workspace.worktrees).includes(directory)
		? (ownedWorkspaceDirectories.get(resolve(directory)) ??
			canonicalDirectory(directory))
		: canonicalDirectory(directory);

/** SQL keys already anchored by recorded ownership must not become legacy aliases. */
export const publicationDirectory = (directory: string): CanonicalDirectory => {
	const key = resolve(directory);
	const owned = ownedWorkspaceDirectories.get(key);
	return owned === key ? owned : canonicalDirectory(directory);
};

/** Only the SessionGit owner invalidates identities when presence changes. */
export const forgetCanonicalDirectory = (directory: string): void => {
	const key = resolve(directory);
	const canonical = canonicalDirectories.get(key) ?? key;
	canonicalDirectories.delete(key);
	for (const [alias, value] of canonicalDirectories)
		if (value === canonical) canonicalDirectories.delete(alias);
};

/** Preserve one identity through symlink aliases, including a missing child. */
export const canonicalDirectory = (directory: string): CanonicalDirectory => {
	const key = resolve(directory);
	const cached = canonicalDirectories.get(key);
	if (cached !== undefined) return cached;
	let ancestor = key;
	const children: string[] = [];
	let links = 0;
	let canonical: CanonicalDirectory;
	for (;;) {
		try {
			canonical = directoryBrand(
				join(realpathSync(ancestor), ...children.reverse()),
			);
			break;
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
			if (parent === ancestor) {
				canonical = directoryBrand(key);
				break;
			}
			children.push(basename(ancestor));
			ancestor = parent;
		}
	}
	canonicalDirectories.set(key, canonical);
	return canonical;
};

const decodeGit = Schema.decodeUnknownOption(
	Schema.fromJsonString(SessionGitSchema),
);
const decodeMissing = Schema.decodeUnknownOption(
	Schema.fromJsonString(WorkspaceMissingSchema),
);

const readPublications = (
	directories: readonly string[],
	workspace?: SessionWorkspace,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const keys = [
			...new Set(
				directories.flatMap((directory) => [
					resolve(directory),
					workspaceDirectory(directory, workspace),
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
				.map((row) => ({ row, directory: publicationDirectory(row.directory) }))
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
		const primary = effectiveWorkingDirectory(roots[0], workspace);
		const entries = effectiveSessionFolders(roots, workspace);
		const publications = yield* readPublications(
			[primary, ...entries.map(({ directory }) => directory)],
			workspace,
		);
		const labels = labelProjectFolders(roots);
		const statuses = entries.flatMap(({ root, directory, shared }, index) => {
			const git = publications.get(
				workspaceDirectory(directory, workspace),
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
		const git = publications.get(workspaceDirectory(primary, workspace))?.git;
		const missing = entries.flatMap(({ root, directory }) => {
			const state = publications.get(
				workspaceDirectory(directory, workspace),
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
