// Fork Metadata Persistence
// Stores fork-point metadata in ~/.conduit/fork-metadata.json.
// Maps sessionId → { forkMessageId, parentID } for user-initiated forks.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../env.js";

export interface ForkEntry {
	forkMessageId: string;
	parentID: string;
	/** Unix-ms timestamp of the fork-point message. Messages with
	 *  time.created < this value are inherited from the parent session. */
	forkPointTimestamp?: number;
}

const FILENAME = "fork-metadata.json";
const TMP_FILENAME = ".fork-metadata.json.tmp";

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Load all fork metadata from disk. Returns empty map on missing/corrupt file. */
export function loadForkMetadata(configDir?: string): Map<string, ForkEntry> {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, FILENAME), "utf-8");
		const obj = JSON.parse(data) as Record<string, ForkEntry | string>;
		const map = new Map<string, ForkEntry>();
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === "string") {
				// Legacy format: value is just forkMessageId string
				map.set(k, { forkMessageId: v, parentID: "" });
			} else if (v && typeof v === "object") {
				map.set(k, v);
			}
		}
		return map;
	} catch {
		return new Map();
	}
}

/** Atomic write of fork metadata to disk. */
export function saveForkMetadata(
	meta: Map<string, ForkEntry>,
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
