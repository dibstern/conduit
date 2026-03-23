// Fork Metadata Persistence
// Stores fork-point message IDs in ~/.conduit/fork-metadata.json.
// Maps sessionId -> forkMessageId (the last inherited message in a forked session).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../env.js";

const FILENAME = "fork-metadata.json";
const TMP_FILENAME = ".fork-metadata.json.tmp";

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Load all fork metadata from disk. Returns empty map on missing/corrupt file. */
export function loadForkMetadata(configDir?: string): Map<string, string> {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, FILENAME), "utf-8");
		const obj = JSON.parse(data) as Record<string, string>;
		return new Map(Object.entries(obj));
	} catch {
		return new Map();
	}
}

/** Atomic write of fork metadata to disk. */
export function saveForkMetadata(
	meta: Map<string, string>,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	mkdirSync(dir, { recursive: true });
	const obj = Object.fromEntries(meta);
	const tmpPath = join(dir, TMP_FILENAME);
	const finalPath = join(dir, FILENAME);
	writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}
