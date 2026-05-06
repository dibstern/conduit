// ─── File Browser Handlers ───────────────────────────────────────────────────

import { Effect } from "effect";
import ignore from "ignore";
import {
	LoggerTag,
	OpenCodeAPITag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { PayloadMap } from "./payloads.js";

// ─── Gitignore Helpers ──────────────────────────────────────────────────────

/** Directories we always skip (even if .gitignore is unavailable). */
const ALWAYS_SKIP = new Set([".git", ".svn", ".hg"]);

/** Load .gitignore rules via Effect. */
const loadGitignore = Effect.gen(function* () {
	const client = yield* OpenCodeAPITag;
	const ig = ignore();
	const readResult = yield* Effect.either(
		Effect.tryPromise(() => client.file.read(".gitignore")),
	);
	if (readResult._tag === "Right" && readResult.right.content) {
		ig.add(readResult.right.content);
	}
	return ig;
});

// ─── Handlers ───────────────────────────────────────────────────────────────

export const handleGetFileList = (
	clientId: string,
	payload: PayloadMap["get_file_list"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;

		const dirPath = payload.path ?? ".";
		const [files, ig] = yield* Effect.all([
			Effect.tryPromise(() => client.file.list(dirPath)),
			loadGitignore,
		]);

		const filtered = files.filter((f) => {
			if (ALWAYS_SKIP.has(f.name)) return false;
			const rel = dirPath === "." ? f.name : `${dirPath}/${f.name}`;
			return !ig.ignores(rel);
		});

		wsHandler.sendTo(clientId, {
			type: "file_list",
			path: dirPath,
			entries: filtered as Array<{
				name: string;
				type: "file" | "directory";
				size?: number;
			}>,
		});
	});

export const handleGetFileContent = (
	clientId: string,
	payload: PayloadMap["get_file_content"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;

		const { path: filePath } = payload;
		if (filePath) {
			const result = yield* Effect.tryPromise(() => client.file.read(filePath));
			const binary = (result as { binary?: boolean }).binary;
			wsHandler.sendTo(clientId, {
				type: "file_content",
				path: filePath,
				content: (result as { content: string }).content ?? "",
				...(binary != null && { binary }),
			});
		}
	});

export const handleGetFileTree = (
	clientId: string,
	_payload: PayloadMap["get_file_tree"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
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
					const items = yield* Effect.tryPromise(() => client.file.list(dir));

					for (const item of items) {
						if (ALWAYS_SKIP.has(item.name)) continue;
						const path = dir === "." ? item.name : `${dir}/${item.name}`;
						if (ig.ignores(path)) continue;

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

		wsHandler.sendTo(clientId, { type: "file_tree", entries });
	});
