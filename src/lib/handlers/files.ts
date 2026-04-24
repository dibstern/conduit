// ─── File Browser Handlers ───────────────────────────────────────────────────

import { Effect } from "effect";
import ignore, { type Ignore } from "ignore";
import {
	LoggerTag,
	OpenCodeAPITag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

// ─── Gitignore Helpers ──────────────────────────────────────────────────────

/** Directories we always skip (even if .gitignore is unavailable). */
const ALWAYS_SKIP = new Set([".git", ".svn", ".hg"]);

/**
 * Fetch and parse .gitignore from the project root.
 * Returns an `ignore` instance ready for path testing.
 * Silently returns an empty matcher if .gitignore doesn't exist.
 */
async function loadGitignore(deps: HandlerDeps): Promise<Ignore> {
	const ig = ignore();
	try {
		const res = await deps.client.file.read(".gitignore");
		if (res.content) ig.add(res.content);
	} catch {
		// No .gitignore or fetch failed — that's fine, use empty rules
	}
	return ig;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export async function handleGetFileList(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_file_list"],
): Promise<void> {
	const dirPath = payload.path ?? ".";
	const [files, ig] = await Promise.all([
		deps.client.file.list(dirPath),
		loadGitignore(deps),
	]);

	const filtered = files.filter((f) => {
		if (ALWAYS_SKIP.has(f.name)) return false;
		const rel = dirPath === "." ? f.name : `${dirPath}/${f.name}`;
		return !ig.ignores(rel);
	});

	deps.wsHandler.sendTo(clientId, {
		type: "file_list",
		path: dirPath,
		entries: filtered as Array<{
			name: string;
			type: "file" | "directory";
			size?: number;
		}>,
	});
}

export async function handleGetFileContent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_file_content"],
): Promise<void> {
	const { path: filePath } = payload;
	if (filePath) {
		const result = await deps.client.file.read(filePath);
		const binary = (result as { binary?: boolean }).binary;
		deps.wsHandler.sendTo(clientId, {
			type: "file_content",
			path: filePath,
			content: (result as { content: string }).content ?? "",
			...(binary != null && { binary }),
		});
	}
}

export async function handleGetFileTree(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_file_tree"],
): Promise<void> {
	const entries: string[] = [];

	try {
		const ig = await loadGitignore(deps);
		const MAX_DEPTH = 10;
		const MAX_ENTRIES = 5_000;
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: ".", depth: 0 },
		];

		while (queue.length > 0 && entries.length < MAX_ENTRIES) {
			const next = queue.shift();
			if (next === undefined) break;
			const { dir, depth } = next;
			const items = await deps.client.file.list(dir);

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
	} catch (err) {
		deps.log.warn(`Error walking directory: ${err}`);
	}

	deps.wsHandler.sendTo(clientId, { type: "file_tree", entries });
}

// ─── Effect-based handler implementations ──────────────────────────────────
// These will replace the above functions once the dispatch table is rewired
// in Task 5.3. Until then they coexist alongside the original handlers.

/** Load .gitignore rules via Effect (mirrors loadGitignore above). */
const loadGitignoreEffect = Effect.gen(function* () {
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

export const handleGetFileListEffect = (
	clientId: string,
	payload: PayloadMap["get_file_list"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;

		const dirPath = payload.path ?? ".";
		const [files, ig] = yield* Effect.all([
			Effect.tryPromise(() => client.file.list(dirPath)),
			loadGitignoreEffect,
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

export const handleGetFileContentEffect = (
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

export const handleGetFileTreeEffect = (
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
				const ig = yield* loadGitignoreEffect;
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
