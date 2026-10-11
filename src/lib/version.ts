// Single source of truth for the package version. Reads from package.json once
// and caches the result. Avoids hardcoded version strings scattered across files.

import { readFileSync } from "node:fs";

let cached: string | null = null;

export function getVersion(): string {
	if (cached) return cached;
	// Source modules live under src/lib; built modules live under dist/src/lib.
	for (const relative of ["../../package.json", "../../../package.json"]) {
		try {
			const pkg: { version?: string } = JSON.parse(
				readFileSync(new URL(relative, import.meta.url), "utf8"),
			);
			if (pkg.version) {
				cached = pkg.version;
				return cached;
			}
		} catch {}
	}
	cached = "0.0.0";
	return cached;
}
