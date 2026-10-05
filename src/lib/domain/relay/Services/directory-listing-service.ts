import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Data, Effect, Layer, Option } from "effect";
import type { FindFoldersResponse } from "../../../contracts/ws-rpc.js";

const MAX_DIR_ENTRIES = 50;
const MAX_FOLDER_ENTRIES = 20;

type DirectoryListOperation = "read" | "stat";

export interface DirectoryListingResult {
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
	list(path: string): Effect.Effect<DirectoryListingResult>;
	find(
		query: string,
	): Effect.Effect<FindFoldersResponse, DirectoryListingServiceError>;
}

export class DirectoryListingServiceTag extends Context.Tag(
	"DirectoryListingService",
)<DirectoryListingServiceTag, DirectoryListingService>() {}

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
				if (!entry.isDirectory()) return false;
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
			.slice(0, MAX_DIR_ENTRIES)
			.map((entry) => `${normalizedParent}${entry.name}/`);

		return { path: rawPath, entries };
	});

export const listDirectoryEntries = (
	rawPath: string,
): Effect.Effect<DirectoryListingResult> =>
	readDirectoryEntries(rawPath).pipe(
		Effect.catchAll(() => Effect.succeed({ path: rawPath, entries: [] })),
	);

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

/** What plain-text queries suggest from: recent.json and every project folder. */
export interface FolderSuggestionSources {
	readonly recent: readonly string[];
	readonly projectFolders: readonly string[];
}

/**
 * Existing folders from the recent-projects list, then git repos one level
 * beside each project folder, whose names contain `text`. One readdir per
 * distinct parent; nothing else on disk is scanned. Unreadable paths are
 * skipped rather than failing the lookup.
 */
const suggestFolders = (
	text: string,
	sources: FolderSuggestionSources,
): Effect.Effect<FindFoldersResponse> =>
	Effect.gen(function* () {
		const needle = text.toLowerCase();
		const named = (path: string) =>
			basename(path).toLowerCase().includes(needle);
		// Folders already in a project are never suggested, recent or sibling.
		const inProject = new Set(sources.projectFolders);
		const recent = yield* Effect.forEach(
			sources.recent.filter((path) => !inProject.has(path) && named(path)),
			(path) =>
				Effect.gen(function* () {
					const stats = yield* statPath(path);
					if (Option.isNone(stats) || !stats.value.isDirectory()) return [];
					const git = yield* isGitRepo(path);
					return [
						{ path, isGitRepo: git, reason: "recent", exists: true } as const,
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
		for (const entry of [
			...recent.flat(),
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
): Effect.Effect<FindFoldersResponse, DirectoryListingServiceError> =>
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
		const exists = Option.isSome(requested);
		const matches = listing.entries
			.map((entry) => resolve(entry))
			.filter((entry) => entry !== path)
			.slice(0, MAX_FOLDER_ENTRIES - 1);
		const candidates = exists ? [path, ...matches] : [...matches, path];
		const entries: FolderEntry[] = [];
		for (const candidate of candidates) {
			const directory =
				candidate === path ? requested : yield* statPath(candidate);
			if (Option.isNone(directory)) {
				if (candidate === path)
					entries.push({
						path,
						isGitRepo: false,
						reason: "match",
						exists: false,
					});
				continue;
			}
			if (!directory.value.isDirectory()) continue;
			entries.push({
				path: candidate,
				isGitRepo: yield* isGitRepo(candidate),
				reason: "match",
				exists: true,
			});
		}
		return { entries };
	});

export const DirectoryListingServiceLive: Layer.Layer<DirectoryListingServiceTag> =
	Layer.succeed(DirectoryListingServiceTag, {
		list: listDirectoryEntries,
		find: findFolders,
	});
