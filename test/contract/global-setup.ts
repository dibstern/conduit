// Spawns an ephemeral OpenCode instance on a random port so contract tests
// never hit the user's live instance at :4096.

import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../e2e/helpers/opencode-spawner.js";
import { startControlledOpenCodeInference } from "../helpers/controlled-opencode-inference.js";

let instance: SpawnedOpenCode | undefined;
let inference:
	| Awaited<ReturnType<typeof startControlledOpenCodeInference>>
	| undefined;

export async function setup(): Promise<void> {
	console.log("[contract] Starting ephemeral OpenCode instance...");
	try {
		inference = await startControlledOpenCodeInference(
			"test-results/controlled-contract-inference.json",
		);
		instance = await spawnOpenCode({ timeoutMs: 60_000, env: inference.env });
		await inference.assertOpenCodeConfig(instance.url);
	} catch (error) {
		try {
			instance?.stop();
			instance = undefined;
		} finally {
			await inference?.close();
		}
		throw error;
	}

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
	try {
		inference?.writeEvidence();
	} finally {
		try {
			if (instance) {
				console.log("[contract] Stopping ephemeral OpenCode instance...");
				instance.stop();
				instance = undefined;
			}
		} finally {
			await inference?.close();
		}
	}
	if (inference?.errors.length) {
		throw new Error(
			`Controlled inference failed: ${inference.errors.join("; ")}`,
		);
	}
}
