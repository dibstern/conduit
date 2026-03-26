import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const FIXTURES_DIR = resolve(
	import.meta.dirname,
	"../../e2e/fixtures/recorded",
);

/**
 * Extract all session IDs that received a prompt (POST .../prompt_async)
 * from a compressed OpenCode recording.
 */
function extractPromptSessionIds(filePath: string): string[] {
	const raw = gunzipSync(readFileSync(filePath)).toString();
	const recording = JSON.parse(raw) as {
		interactions: { kind: string; method?: string; path?: string }[];
	};
	const ids: string[] = [];
	for (const ix of recording.interactions) {
		if (
			ix.kind === "rest" &&
			ix.method === "POST" &&
			ix.path?.includes("prompt_async")
		) {
			const m = /\/session\/([^/]+)\//.exec(ix.path);
			if (m?.[1]) ids.push(m[1]);
		}
	}
	return ids;
}

describe("Recording session isolation", () => {
	it("no session ID receives prompts in more than one recording", () => {
		const files = readdirSync(FIXTURES_DIR).filter((f) =>
			f.endsWith(".opencode.json.gz"),
		);
		expect(files.length).toBeGreaterThan(0);

		const seen = new Map<string, string>(); // sessionId → first recording name
		const reuses: string[] = [];

		for (const file of files) {
			const name = file.replace(".opencode.json.gz", "");
			const sessionIds = extractPromptSessionIds(resolve(FIXTURES_DIR, file));
			for (const sid of sessionIds) {
				const prior = seen.get(sid);
				if (prior !== undefined && prior !== name) {
					reuses.push(`${sid.slice(-8)} used in "${prior}" AND "${name}"`);
				}
				seen.set(sid, name);
			}
		}

		expect(reuses, "Cross-recording session reuse detected").toEqual([]);
	});
});
