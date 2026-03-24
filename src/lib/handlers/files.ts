// ─── File Browser Handlers ───────────────────────────────────────────────────

import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetFileList(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_file_list"],
): Promise<void> {
	const dirPath = payload.path;
	const files = await deps.client.listDirectory(dirPath);
	deps.wsHandler.sendTo(clientId, {
		type: "file_list",
		path: dirPath ?? ".",
		entries: files as Array<{
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
		const result = await deps.client.getFileContent(filePath);
		const binary = (result as { binary?: boolean }).binary;
		deps.wsHandler.sendTo(clientId, {
			type: "file_content",
			path: filePath,
			content: (result as { content: string }).content ?? "",
			...(binary != null && { binary }),
		});
	}
}

/** Directories to skip when building the file tree (large, generated, or internal). */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	".turbo",
	".cache",
	"__pycache__",
	".venv",
	"venv",
	"target",
	"vendor",
	".worktrees",
]);

export async function handleGetFileTree(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_file_tree"],
): Promise<void> {
	const entries: string[] = [];

	try {
		// Breadth-first walk of project directory, skipping well-known heavy dirs
		const queue: string[] = ["."];

		while (queue.length > 0) {
			const dir = queue.shift();
			if (dir === undefined) break;
			const items = await deps.client.listDirectory(dir);

			for (const item of items) {
				const path = dir === "." ? item.name : `${dir}/${item.name}`;
				if (item.type === "directory") {
					if (SKIP_DIRS.has(item.name)) continue;
					entries.push(`${path}/`);
					queue.push(path);
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
