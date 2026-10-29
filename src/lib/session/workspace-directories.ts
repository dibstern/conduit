import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Brand, Context, Effect, Layer, Option } from "effect";
import type {
	SessionWorkspace,
	SessionWorktreeOwnership,
} from "../contracts/session-workspace.js";

export type CanonicalDirectory = string & Brand.Brand<"CanonicalDirectory">;
const directoryBrand = Brand.nominal<CanonicalDirectory>();

/** Resolve aliases, including missing children, without retaining caller state. */
export const canonicalDirectory = (directory: string): CanonicalDirectory => {
	const key = resolve(directory);
	let ancestor = key;
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
			if (parent === ancestor) return directoryBrand(key);
			children.push(basename(ancestor));
			ancestor = parent;
		}
	}
};

/** One store owns aliases and recorded checkout identities for its lifetime. */
export const makeWorkspaceDirectories = () => {
	const canonicalDirectories = new Map<string, CanonicalDirectory>();
	const ownedWorkspaceDirectories = new Map<string, CanonicalDirectory>();
	const canonical = (directory: string): CanonicalDirectory => {
		const key = resolve(directory);
		const cached = canonicalDirectories.get(key);
		if (cached !== undefined) return cached;
		const value = canonicalDirectory(key);
		canonicalDirectories.set(key, value);
		return value;
	};
	const rememberWorkspaceDirectories = (
		workspace: SessionWorkspace,
		ownership: readonly SessionWorktreeOwnership[],
	): void => {
		const roots = ownership.map(({ path }) => resolve(path));
		const isOwned = (path: string) =>
			roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
		for (const directory of Object.values(workspace.worktrees)) {
			const path = resolve(directory);
			const key = isOwned(path) ? directoryBrand(path) : canonical(path);
			if (!isOwned(key)) continue;
			ownedWorkspaceDirectories.set(path, key);
			ownedWorkspaceDirectories.set(key, key);
		}
	};
	const workspaceDirectory = (
		directory: string,
		workspace?: SessionWorkspace | null,
	): CanonicalDirectory =>
		workspace?.origin === "conduit" &&
		Object.values(workspace.worktrees).includes(directory)
			? (ownedWorkspaceDirectories.get(resolve(directory)) ??
				canonical(directory))
			: canonical(directory);
	const publicationDirectory = (directory: string): CanonicalDirectory => {
		const key = resolve(directory);
		const owned = ownedWorkspaceDirectories.get(key);
		return owned === key ? owned : canonical(directory);
	};
	const forgetCanonicalDirectory = (directory: string): void => {
		const key = resolve(directory);
		const value = canonicalDirectories.get(key) ?? key;
		canonicalDirectories.delete(key);
		for (const [alias, canonical] of canonicalDirectories)
			if (canonical === value) canonicalDirectories.delete(alias);
	};
	return {
		canonicalDirectory: canonical,
		rememberWorkspaceDirectories,
		workspaceDirectory,
		publicationDirectory,
		forgetCanonicalDirectory,
	};
};

export class WorkspaceDirectories extends Context.Service<
	WorkspaceDirectories,
	ReturnType<typeof makeWorkspaceDirectories>
>()("WorkspaceDirectories") {}

export const WorkspaceDirectoriesLive = Layer.sync(
	WorkspaceDirectories,
	makeWorkspaceDirectories,
);

/** Snapshot-only consumers can resolve identities without retaining a cache. */
export const workspaceDirectories = Effect.map(
	Effect.serviceOption(WorkspaceDirectories),
	Option.getOrElse(makeWorkspaceDirectories),
);
