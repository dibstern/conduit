// ─── Version Utility ─────────────────────────────────────────────────────────
// Single source of truth for the package version. Reads from package.json once
// and caches the result. Avoids hardcoded version strings scattered across files.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getVersion(): string {
	if (cached) return cached;
	try {
		const dir = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(
			readFileSync(join(dir, "../../package.json"), "utf8"),
		);
		cached = pkg.version ?? "0.0.0";
	} catch {
		cached = "0.0.0";
	}
	// biome-ignore lint/style/noNonNullAssertion: safe — initialized before this code path
	return cached!;
}
