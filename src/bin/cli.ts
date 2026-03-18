#!/usr/bin/env node
// ─── CLI Entry Point (Ticket 3.3) ───────────────────────────────────────────
// Thin wrapper around cli-core.ts for testability.

import { run } from "./cli-core.js";

run(process.argv.slice(2)).catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
