import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Default frontend directory resolved relative to the caller module.
 * Compiled daemon modules live under dist/src/lib/domain/daemon, so walking
 * five levels reaches dist/frontend. Dev mode falls back to cwd/dist/frontend.
 */
export function resolveDefaultStaticDir(options?: {
	readonly moduleUrl?: string;
	readonly cwd?: string;
	readonly exists?: (path: string) => boolean;
}): string {
	const moduleUrl = options?.moduleUrl ?? import.meta.url;
	const cwd = options?.cwd ?? process.cwd();
	const exists = options?.exists ?? existsSync;
	const candidate = join(
		dirname(fileURLToPath(moduleUrl)),
		"..",
		"..",
		"..",
		"..",
		"..",
		"frontend",
	);
	return exists(candidate) ? candidate : join(cwd, "dist", "frontend");
}
