import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Data, Effect, Layer, Option } from "effect";
import {
	type FindFoldersResponse,
	ProjectSaveRejected,
} from "../../../contracts/ws-rpc.js";
import { getConfigDir } from "../../../daemon/config-persistence.js";
import { isPermissionDenied } from "../../../project-folders.js";
import { isConduitWorktreePath } from "../../daemon/Layers/worktree-layer.js";
import { ConfigTag } from "./services.js";

/** Path autocomplete lists every child folder; this only bounds huge folders like node_modules. The list scrolls. */
const MAX_PATH_MATCHES = 500;
const MAX_FOLDER_ENTRIES = 20;

type DirectoryListOperation = "read" | "stat";

interface DirectoryListingResult {
	readonly path: string;
	readonly entries: ReadonlyArray<string>;
}

export class DirectoryListingServiceError extends Data.TaggedError(
	"DirectoryListingServiceError",
)<{
	readonly operation: DirectoryListOperation;
	readonly path: string;
	readonly cause: unknown;
}> {}

export interface DirectoryListingService {
	find(
		query: string,
	): Effect.Effect<
		FindFoldersResponse,
		DirectoryListingServiceError | ProjectSaveRejected
	>;
}

export class DirectoryListingServiceTag extends Context.Service<
	DirectoryListingServiceTag,
	DirectoryListingService
>()("DirectoryListingService") {}

const expandHome = (path: string): string =>
	path.startsWith("~/") || path === "~" ? homedir() + path.slice(1) : path;

const readDirectoryEntries = (
	rawPath: string,
): Effect.Effect<DirectoryListingResult, DirectoryListingServiceError> =>
	Effect.gen(function* () {
		const expandedPath = expandHome(rawPath);
		const endsWithSlash = expandedPath.endsWith("/");
		const parentDir = endsWithSlash ? expandedPath : dirname(expandedPath);
		const prefix = endsWithSlash ? "" : basename(expandedPath);
		const showHidden = prefix.startsWith(".");

		const directoryEntries = yield* Effect.tryPromise({
			try: () => readdir(parentDir, { withFileTypes: true }),
			catch: (cause) =>
				new DirectoryListingServiceError({
					operation: "read",
					path: parentDir,
					cause,
				}),
		});

		const normalizedParent = parentDir.endsWith("/")
			? parentDir
			: `${parentDir}/`;
		const entries = directoryEntries
			.filter((entry) => {
				// Symlinks are kept here; findFolders drops those that are not folders.
				if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
				if (!showHidden && entry.name.startsWith(".")) return false;
				if (
					prefix &&
					!entry.name.toLowerCase().startsWith(prefix.toLowerCase())
				) {
					return false;
				}
				return true;
			})
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, MAX_PATH_MATCHES)
			.map((entry) => `${normalizedParent}${entry.name}/`);

		return { path: rawPath, entries };
	});

const isMissing = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"code" in cause &&
	cause.code === "ENOENT";

const statPath = (
	path: string,
): Effect.Effect<Option.Option<Stats>, DirectoryListingServiceError> =>
	Effect.tryPromise({
		try: () => stat(path),
		catch: (cause) =>
			new DirectoryListingServiceError({ operation: "stat", path, cause }),
	}).pipe(
		Effect.map(Option.some),
		Effect.catchTag("DirectoryListingServiceError", (error) =>
			isMissing(error.cause)
				? Effect.succeed(Option.none())
				: Effect.fail(error),
		),
	);

const isGitRepo = (
	path: string,
): Effect.Effect<boolean, DirectoryListingServiceError> =>
	statPath(join(path, ".git")).pipe(
		Effect.map(
			(git) =>
				Option.isSome(git) && (git.value.isDirectory() || git.value.isFile()),
		),
	);

type FolderEntry = FindFoldersResponse["entries"][number];

const gitDirectory = (path: string) =>
	Effect.gen(function* () {
		const gitDir = join(path, ".git");
		const gitStats = yield* statPath(gitDir);
		if (Option.isNone(gitStats)) return Option.none<string>();
		if (gitStats.value.isDirectory()) return Option.some(gitDir);
		if (!gitStats.value.isFile()) return Option.none<string>();
		const pointer = yield* Effect.tryPromise(() => readFile(gitDir, "utf8"));
		const target = pointer.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
		return target ? Option.some(resolve(path, target)) : Option.none<string>();
	});

const lastGitActivity = (path: string) =>
	Effect.gen(function* () {
		const gitDir = yield* gitDirectory(path);
		if (Option.isNone(gitDir)) return Option.none<number>();
		const metadata = yield* Effect.forEach(
			["HEAD", "index", "logs/HEAD"],
			(file) => statPath(join(gitDir.value, file)),
			{ concurrency: 3 },
		);
		const times = metadata
			.filter(Option.isSome)
			.map((entry) => entry.value.mtimeMs);
		return times.length > 0
			? Option.some(Math.max(...times))
			: Option.none<number>();
	});

const folderMetadata = (
	path: string,
	git: boolean,
): Effect.Effect<Pick<FolderEntry, "branch" | "repoCount">> =>
	Effect.gen(function* () {
		if (git) {
			const gitDir = yield* gitDirectory(path);
			if (Option.isNone(gitDir)) return {};
			const head = yield* Effect.tryPromise(() =>
				readFile(join(gitDir.value, "HEAD"), "utf8"),
			);
			const branch = head.trim().match(/^ref: refs\/heads\/(.+)$/)?.[1];
			return branch ? { branch } : {};
		}
		const entries = yield* Effect.tryPromise(() =>
			readdir(path, { withFileTypes: true }),
		);
		if (entries.length > MAX_PATH_MATCHES) return {};
		const repos = yield* Effect.filter(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(path, entry.name)),
			isGitRepo,
			{ concurrency: 16 },
		);
		return repos.length > 0 ? { repoCount: repos.length } : {};
	}).pipe(Effect.orElseSucceed(() => ({})));

/** What plain-text queries suggest from: recent.json and every project folder. */
export interface FolderSuggestionSources {
	readonly recent: readonly string[];
	readonly projectFolders: readonly string[];
}

// Reading these makes macOS show a privacy prompt (or they are huge), so the
// scan never opens them; they stay reachable by browsing.
const UNSCANNED_HOME_FOLDERS = new Set([
	"Applications",
	"Desktop",
	"Documents",
	"Downloads",
	"Library",
	"Movies",
	"Music",
	"Pictures",
	"Public",
]);

/** Scan each home root breadth-first, so overlapping roots get their full depth. */
const discoverGitRepos = Effect.gen(function* () {
	const home = homedir();
	let folders = [
		home,
		...["src", "code", "Developer", "projects", "dev", "work"].map((name) =>
			join(home, name),
		),
	];
	const visited = new Set<string>();
	const repos: string[] = [];
	for (let depth = 0; depth <= 2; depth++) {
		const pending = [...new Set(folders)].filter((path) => !visited.has(path));
		for (const path of pending) visited.add(path);
		const listings = yield* Effect.forEach(
			pending,
			(path) =>
				Effect.tryPromise(() => readdir(path, { withFileTypes: true })).pipe(
					Effect.map((entries) => {
						if (entries.length > MAX_PATH_MATCHES)
							return { repos: [], folders: [] };
						return {
							repos: entries.some((entry) => entry.name === ".git")
								? [path]
								: [],
							folders: entries
								.filter(
									(entry) =>
										entry.isDirectory() &&
										!entry.name.startsWith(".") &&
										entry.name !== "node_modules" &&
										!(path === home && UNSCANNED_HOME_FOLDERS.has(entry.name)),
								)
								.map((entry) => join(path, entry.name)),
						};
					}),
					Effect.orElseSucceed(() => ({ repos: [], folders: [] })),
				),
			{ concurrency: 8 },
		);
		for (const listing of listings) repos.push(...listing.repos);
		folders = listings.flatMap((listing) => listing.folders);
	}
	return repos;
});

/**
 * Existing folders from the recent-projects list, then git repos one level
 * beside each project folder, whose names contain `text`. An empty query also
 * discovers recently active repositories under common home roots. Unreadable
 * paths are skipped rather than failing the lookup.
 */
const suggestFolders = (
	text: string,
	sources: FolderSuggestionSources,
): Effect.Effect<Pick<FindFoldersResponse, "entries">> =>
	Effect.gen(function* () {
		const needle = text.toLowerCase();
		const named = (path: string) =>
			basename(path).toLowerCase().includes(needle);
		// Folders already in a project are never suggested, recent or sibling.
		const inProject = new Set(sources.projectFolders);
		const discovered = text ? [] : yield* discoverGitRepos;
		const recentPaths = new Set([...sources.recent, ...discovered]);
		const recent = yield* Effect.forEach(
			[...recentPaths].filter((path) => !inProject.has(path) && named(path)),
			(path) =>
				Effect.gen(function* () {
					const stats = yield* statPath(path);
					if (Option.isNone(stats) || !stats.value.isDirectory()) return [];
					const git = yield* isGitRepo(path);
					const lastUsed = git
						? yield* lastGitActivity(path)
						: Option.none<number>();
					if (!sources.recent.includes(path) && Option.isNone(lastUsed))
						return [];
					return [
						{
							path,
							isGitRepo: git,
							reason: "recent",
							exists: true,
							...(Option.isSome(lastUsed) ? { lastUsed: lastUsed.value } : {}),
						} as const,
					];
				}).pipe(Effect.orElseSucceed(() => [])),
			{ concurrency: 8 },
		);
		const siblings = yield* Effect.forEach(
			new Set(sources.projectFolders.map((folder) => dirname(folder))),
			(parent) =>
				Effect.tryPromise(() => readdir(parent, { withFileTypes: true })).pipe(
					Effect.map((dirents) =>
						dirents
							.filter(
								(dirent) =>
									dirent.isDirectory() && !dirent.name.startsWith("."),
							)
							.map((dirent) => join(parent, dirent.name))
							.filter((path) => !inProject.has(path) && named(path))
							.sort((a, b) => a.localeCompare(b)),
					),
					Effect.orElseSucceed((): string[] => []),
				),
			{ concurrency: 8 },
		);
		const repos = yield* Effect.filter(
			siblings.flat(),
			(path) => isGitRepo(path).pipe(Effect.orElseSucceed(() => false)),
			{ concurrency: 8 },
		);
		const unique = new Map<string, FolderEntry>();
		const recentEntries = recent.flat();
		if (!text)
			recentEntries.sort(
				(a, b) =>
					(b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.path.localeCompare(b.path),
			);
		for (const entry of [
			...recentEntries,
			...repos.map(
				(path) =>
					({ path, isGitRepo: true, reason: "sibling", exists: true }) as const,
			),
		]) {
			if (!unique.has(entry.path)) unique.set(entry.path, entry);
		}
		return { entries: [...unique.values()].slice(0, MAX_FOLDER_ENTRIES) };
	});

/**
 * A query starting with / or ~ autocompletes that path; any other text filters
 * the folder suggestions built from `sources`.
 */
export const findFolders = (
	query: string,
	sources: FolderSuggestionSources = { recent: [], projectFolders: [] },
	configDir?: string,
): Effect.Effect<
	FindFoldersResponse,
	DirectoryListingServiceError | ProjectSaveRejected
> =>
	Effect.gen(function* () {
		if (!query.startsWith("/") && !query.startsWith("~"))
			return yield* suggestFolders(query.trim(), sources);
		if (query.startsWith("~") && query !== "~" && !query.startsWith("~/")) {
			return yield* Effect.fail(
				new DirectoryListingServiceError({
					operation: "stat",
					path: query,
					cause: new Error("Home paths must start with ~/"),
				}),
			);
		}
		const path = resolve(expandHome(query));
		if (
			configDir !== undefined &&
			(yield* Effect.try({
				try: () => isConduitWorktreePath(configDir, path),
				catch: (cause) =>
					new DirectoryListingServiceError({ operation: "stat", path, cause }),
			}))
		)
			return yield* new ProjectSaveRejected({
				issues: [{ kind: "conduit-worktree", path }],
			});
		const requested = yield* statPath(path);
		if (Option.isSome(requested) && !requested.value.isDirectory()) {
			return yield* Effect.fail(
				new DirectoryListingServiceError({
					operation: "stat",
					path,
					cause: new Error(`Not a directory: ${path}`),
				}),
			);
		}
		const listing = yield* readDirectoryEntries(
			query.endsWith("/") ? `${path}/` : path,
		).pipe(
			Effect.catchTag("DirectoryListingServiceError", (error) =>
				isMissing(error.cause)
					? Effect.succeed({ path, entries: [] })
					: Effect.fail(error),
			),
		);
		const children = yield* Effect.forEach(
			listing.entries
				.map((entry) => resolve(entry))
				.filter((entry) => entry !== path),
			(candidate) =>
				Effect.gen(function* () {
					const directory = yield* statPath(candidate);
					if (Option.isNone(directory) || !directory.value.isDirectory())
						return [];
					const git = yield* isGitRepo(candidate);
					return [
						{
							path: candidate,
							isGitRepo: git,
							...(yield* folderMetadata(candidate, git)),
							reason: "match",
							exists: true,
						} as const,
					];
				}).pipe(Effect.orElseSucceed(() => [])),
			{ concurrency: 16 },
		);
		if (Option.isNone(requested))
			return {
				entries: [
					...children.flat(),
					{ path, isGitRepo: false, reason: "match", exists: false } as const,
				],
			};
		const git = yield* isGitRepo(path);
		const typed = {
			path,
			isGitRepo: git,
			...(yield* folderMetadata(path, git)),
			reason: "match",
			exists: true,
		} as const;
		return { entries: [typed, ...children.flat()] };
	}).pipe(
		Effect.flatMap((result: Pick<FindFoldersResponse, "entries">) =>
			Effect.filter(result.entries, (entry) =>
				configDir === undefined
					? Effect.succeed(true)
					: Effect.try(
							() => !isConduitWorktreePath(configDir, entry.path),
						).pipe(Effect.orElseSucceed(() => false)),
			).pipe(Effect.map((entries) => ({ ...result, entries }))),
		),
		Effect.map((result) => ({ home: homedir(), ...result })),
		Effect.mapError((error) =>
			error instanceof ProjectSaveRejected
				? error
				: isPermissionDenied(error.cause)
					? new ProjectSaveRejected({
							issues: [
								{ kind: "permission-denied", path: resolve(expandHome(query)) },
							],
						})
					: error,
		),
	);

export const DirectoryListingServiceLive = Layer.effect(
	DirectoryListingServiceTag,
	Effect.gen(function* () {
		const config = yield* Effect.serviceOption(ConfigTag);
		return {
			find: (query: string) =>
				findFolders(
					query,
					undefined,
					Option.isSome(config)
						? (config.value.configDir ?? getConfigDir())
						: getConfigDir(),
				),
		};
	}),
);
