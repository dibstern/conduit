// ─── Contract Test Global Setup ────────────────────────────────────────────
// Spawns an ephemeral OpenCode instance on a random port so contract tests
// never hit the user's live instance at :4096.

import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../e2e/helpers/opencode-spawner.js";

let instance: SpawnedOpenCode | undefined;

export async function setup(): Promise<void> {
	console.log("[contract] Starting ephemeral OpenCode instance...");
	instance = await spawnOpenCode({ timeoutMs: 60_000 });

	// Point contract test helpers at the ephemeral instance.
	// server-connection.ts reads OPENCODE_URL at import time;
	// setting it here (before forks) ensures workers inherit it.
	process.env["OPENCODE_URL"] = instance.url;

	// The spawned instance has no password, so clear any inherited
	// password to avoid auth mismatches.
	process.env["OPENCODE_SERVER_PASSWORD"] = "";

	console.log(`[contract] OpenCode ready at ${instance.url}`);
}

export async function teardown(): Promise<void> {
	if (instance) {
		console.log("[contract] Stopping ephemeral OpenCode instance...");
		instance.stop();
		instance = undefined;
	}
}
