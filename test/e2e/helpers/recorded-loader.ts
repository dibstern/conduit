import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/recorded");

/** Load an OpenCode HTTP-level recording by name (without extension). */
export function loadOpenCodeRecording(name: string): OpenCodeRecording {
	const gzPath = path.join(FIXTURES_DIR, `${name}.opencode.json.gz`);
	const raw = gunzipSync(readFileSync(gzPath));
	return JSON.parse(raw.toString()) as OpenCodeRecording;
}
