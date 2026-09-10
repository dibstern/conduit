import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");

interface AllowedSessionMutation {
	readonly path: string;
	readonly linePattern: RegExp;
}

// Stopgap: once session mutations flow through one command seam, this allowlist collapses to one sync-adapter rule.
const allowedSessionMutations: readonly AllowedSessionMutation[] = [
	// SessionManager owns provider creation while it coordinates the new session state.
	{
		path: "src/lib/domain/relay/Services/session-manager-service.ts",
		linePattern: /api\.session\.create\(title \? \{ title \} : undefined\),/,
	},
	// SessionManager owns provider deletion while it clears the matching session state.
	{
		path: "src/lib/domain/relay/Services/session-manager-service.ts",
		linePattern: /api\.session\.delete\(sessionId\)/,
	},
	// SessionManager owns provider renaming after checking for a SQLite-backed session.
	{
		path: "src/lib/domain/relay/Services/session-manager-service.ts",
		linePattern: /api\.session\.update\(sessionId, \{ title \}\),/,
	},
];

function productionSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...productionSourceFiles(path));
		} else if (path.endsWith(".ts") || path.endsWith(".svelte")) {
			files.push(path);
		}
	}
	return files;
}

describe("session mutation boundary grep", () => {
	it("keeps direct provider session mutations on an explicit allowlist", () => {
		const hits = productionSourceFiles(SRC_ROOT).flatMap((file) => {
			const path = relative(REPO_ROOT, file);
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					/api\.session\.(?:create|update|delete)\s*\(/.test(line)
						? [{ path, line: index + 1, source: line.trim() }]
						: [],
				);
		});

		const missingAllowedSites = [...allowedSessionMutations];
		const unexpected = hits.filter((hit) => {
			const allowedIndex = missingAllowedSites.findIndex(
				(allowed) =>
					allowed.path === hit.path && allowed.linePattern.test(hit.source),
			);
			if (allowedIndex === -1) return true;

			missingAllowedSites.splice(allowedIndex, 1);
			return false;
		});

		const parityRequirement =
			"A direct api.session mutation can update the provider without updating Conduit's durable state. Every session create, update, or delete must reach the SQLite read model, not just the provider. Route new mutations through the session command seam or add a reviewed temporary allowlist entry.";

		expect({ unexpected, missingAllowedSites }, parityRequirement).toEqual({
			unexpected: [],
			missingAllowedSites: [],
		});
	});
});
