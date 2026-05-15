import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { Context, Data, Effect, Layer } from "effect";

const MAX_DIR_ENTRIES = 50;

type DirectoryListOperation = "read";

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
}

export class DirectoryListingServiceTag extends Context.Tag(
	"DirectoryListingService",
)<DirectoryListingServiceTag, DirectoryListingService>() {}

const expandHome = (path: string): string =>
	path.startsWith("~/") || path === "~" ? homedir() + path.slice(1) : path;

export const listDirectoryEntries = (
	rawPath: string,
): Effect.Effect<DirectoryListingResult> =>
	Effect.gen(function* () {
		const expandedPath = expandHome(rawPath);
		const endsWithSlash = expandedPath.endsWith("/");
		const parentDir = endsWithSlash ? expandedPath : dirname(expandedPath);
		const prefix = endsWithSlash ? "" : basename(expandedPath);
		const showHidden = prefix.startsWith(".");

		const readResult = yield* Effect.either(
			Effect.tryPromise({
				try: () => readdir(parentDir, { withFileTypes: true }),
				catch: (cause) =>
					new DirectoryListingServiceError({
						operation: "read",
						path: parentDir,
						cause,
					}),
			}),
		);

		if (readResult._tag === "Left") {
			return { path: rawPath, entries: [] };
		}

		const normalizedParent = parentDir.endsWith("/")
			? parentDir
			: `${parentDir}/`;
		const entries = readResult.right
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

export const DirectoryListingServiceLive: Layer.Layer<DirectoryListingServiceTag> =
	Layer.succeed(DirectoryListingServiceTag, {
		list: listDirectoryEntries,
	});
