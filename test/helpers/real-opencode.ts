import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

/** Resolve the pinned executable itself: pnpm's shim breaks when symlinked. */
export const resolveRealOpenCode = (): string =>
	realpathSync(
		process.env["CONDUIT_TEST_REAL_OPENCODE"] ??
			createRequire(import.meta.url).resolve("opencode-ai/bin/opencode.exe"),
	);
