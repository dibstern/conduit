import { Clock, Effect, Option } from "effect";
import ignore from "ignore";
import {
	LoggerTag,
	OpenCodeFileServiceTag,
} from "../domain/relay/Services/services.js";

/** Directories we always skip (even if .gitignore is unavailable). */
const ALWAYS_SKIP = new Set([".git", ".svn", ".hg"]);

const MAX_DEPTH = 10;
const MAX_ENTRIES = 5_000;
const FILE_TREE_FOLDER_TIMEOUT_MS = 5_000;
const FILE_TREE_TIMEOUT_MS = 15_000;

/** Load .gitignore rules via Effect. */
const loadGitignore = Effect.gen(function* () {
	const files = yield* OpenCodeFileServiceTag;
	const ig = ignore();
	const readResult = yield* Effect.either(files.read(".gitignore"));
	if (readResult._tag === "Right" && readResult.right.content) {
		ig.add(readResult.right.content);
	}
	return ig;
});

const isIgnored = (
	ig: ReturnType<typeof ignore>,
	path: string,
	type: string,
): boolean =>
	type === "directory"
		? ig.ignores(path) || ig.ignores(`${path}/`)
		: ig.ignores(path);

export const getFileListResponse = (dirPath = ".") =>
	Effect.gen(function* () {
		const fileService = yield* OpenCodeFileServiceTag;
		const [files, ig] = yield* Effect.all([
			fileService.list(dirPath),
			loadGitignore,
		]);

		const filtered = files.filter((f) => {
			if (ALWAYS_SKIP.has(f.name)) return false;
			const rel = dirPath === "." ? f.name : `${dirPath}/${f.name}`;
			return !isIgnored(ig, rel, f.type);
		});

		return {
			path: dirPath,
			entries: filtered.map((entry) => ({
				name: entry.name,
				type: entry.type as "file" | "directory",
				...(entry.size != null ? { size: entry.size } : {}),
			})),
		};
	});

export const getFileContentResponse = (filePath: string) =>
	Effect.gen(function* () {
		const files = yield* OpenCodeFileServiceTag;
		const result = yield* files.read(filePath);
		const binary = (result as { binary?: boolean }).binary;
		return {
			path: filePath,
			content: (result as { content: string }).content ?? "",
			...(binary != null && { binary }),
		};
	});

export const getFileTreeEntries = () =>
	Effect.gen(function* () {
		const files = yield* OpenCodeFileServiceTag;
		const log = yield* LoggerTag;

		const entries: string[] = [];
		const startedAt = yield* Clock.currentTimeMillis;
		let currentPath = ".gitignore";

		const walkResult = yield* Effect.either(
			Effect.gen(function* () {
				const ig = yield* loadGitignore;
				const queue: Array<{ dir: string; depth: number }> = [
					{ dir: ".", depth: 0 },
				];

				while (queue.length > 0 && entries.length < MAX_ENTRIES) {
					const next = queue.shift();
					if (next === undefined) break;
					const { dir, depth } = next;
					currentPath = dir;
					const folderStartedAt = yield* Clock.currentTimeMillis;
					const items = yield* files
						.list(dir)
						.pipe(Effect.timeoutOption(FILE_TREE_FOLDER_TIMEOUT_MS));
					if (Option.isNone(items)) {
						const elapsed = (yield* Clock.currentTimeMillis) - folderStartedAt;
						log.warn(
							`File tree folder timed out: ${JSON.stringify(dir)} after ${elapsed} ms`,
						);
						continue;
					}

					for (const item of items.value) {
						if (ALWAYS_SKIP.has(item.name)) continue;
						const path = dir === "." ? item.name : `${dir}/${item.name}`;
						if (isIgnored(ig, path, item.type)) continue;

						if (item.type === "directory") {
							entries.push(`${path}/`);
							if (depth < MAX_DEPTH) {
								queue.push({ dir: path, depth: depth + 1 });
							}
						} else {
							entries.push(path);
						}
					}
				}
			}).pipe(Effect.timeoutOption(FILE_TREE_TIMEOUT_MS)),
		);

		const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
		if (walkResult._tag === "Left") {
			log.warn(`Error walking directory: ${walkResult.left}`);
		} else if (Option.isNone(walkResult.right)) {
			log.warn(
				`File tree deadline reached: ${JSON.stringify(currentPath)} after ${elapsed} ms`,
			);
		}

		return entries;
	});
