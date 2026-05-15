// ─── File Browser Handlers ───────────────────────────────────────────────────

import { Effect } from "effect";
import ignore from "ignore";
import {
	LoggerTag,
	OpenCodeFileServiceTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";

// ─── Gitignore Helpers ──────────────────────────────────────────────────────

/** Directories we always skip (even if .gitignore is unavailable). */
const ALWAYS_SKIP = new Set([".git", ".svn", ".hg"]);

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

// ─── Handlers ───────────────────────────────────────────────────────────────

export const handleGetFileList = (
	clientId: string,
	payload: { path?: string },
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const result = yield* getFileListResponse(payload.path ?? ".");

		wsHandler.sendTo(clientId, {
			type: "file_list",
			path: result.path,
			entries: result.entries,
		});
	});

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

export const handleGetFileContent = (
	clientId: string,
	payload: { path: string },
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		const { path: filePath } = payload;
		if (filePath) {
			const result = yield* getFileContentResponse(filePath);
			wsHandler.sendTo(clientId, {
				type: "file_content",
				path: result.path,
				content: result.content,
				...(result.binary != null && { binary: result.binary }),
			});
		}
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

		const walkResult = yield* Effect.either(
			Effect.gen(function* () {
				const ig = yield* loadGitignore;
				const MAX_DEPTH = 10;
				const MAX_ENTRIES = 5_000;
				const queue: Array<{ dir: string; depth: number }> = [
					{ dir: ".", depth: 0 },
				];

				while (queue.length > 0 && entries.length < MAX_ENTRIES) {
					const next = queue.shift();
					if (next === undefined) break;
					const { dir, depth } = next;
					const items = yield* files.list(dir);

					for (const item of items) {
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
			}),
		);

		if (walkResult._tag === "Left") {
			log.warn(`Error walking directory: ${walkResult.left}`);
		}

		return entries;
	});

export const handleGetFileTree = (
	clientId: string,
	_payload: Record<string, never>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const entries = yield* getFileTreeEntries();
		wsHandler.sendTo(clientId, { type: "file_tree", entries });
	});
