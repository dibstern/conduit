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

export const findFolders = (
	query: string,
): Effect.Effect<FindFoldersResponse, DirectoryListingServiceError> =>
	Effect.gen(function* () {
		if (!query.startsWith("/") && !query.startsWith("~"))
			return { entries: [] };
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
		const entries: Array<FindFoldersResponse["entries"][number]> = [];
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
			const git = yield* statPath(join(candidate, ".git"));
			entries.push({
				path: candidate,
				isGitRepo:
					Option.isSome(git) && (git.value.isDirectory() || git.value.isFile()),
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
