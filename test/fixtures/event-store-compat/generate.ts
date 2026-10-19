// Generates events.db beside this file: a daemon event store written by the
// current build, pinned by test/e2e/specs/harness-event-store-compat-pin.spec.ts
// (conduit-test-16c8.3). It drives the built daemon through the process harness
// with the fake Claude SDK. One session starts as a legacy project store that
// the daemon imports on startup; the others are created and prompted live, one
// with Bash tool calls.
//
// Regenerate only on purpose; the spec's recorded hash and counts change with it:
//
//   export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
//   pnpm build </dev/null
//   CONDUIT_TEST_DIST=dist pnpm exec tsx test/fixtures/event-store-compat/generate.ts </dev/null

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLegacyDaemonFixture } from "../../helpers/daemon-store-import-manifest.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const output = fileURLToPath(new URL("./events.db", import.meta.url));
const harness = ProcessHarness.create({
	dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
});
try {
	await createLegacyDaemonFixture(harness.configDir, [
		{
			projectId: "process-test",
			folder: harness.projectDir,
			sessionId: "ses_compat_imported",
			prompt: "compat-imported-history",
			reply: "done(compat-imported-history)",
		},
	]);
	// Settle and archive policies would otherwise rewrite the 1970 legacy session.
	const configPath = join(harness.configDir, "daemon.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			...JSON.parse(readFileSync(configPath, "utf8")),
			autoSettleAfterDays: null,
			autoArchiveAfterDays: null,
		}),
	);
	await harness.restart();
	const client = await harness.connect();
	const chat = await client.createSession("Compat chat");
	for (const prompt of ["compat-chat-first", "compat-chat-second"])
		if ((await client.send(chat, prompt)).done["status"] !== "idle")
			throw new Error(`Turn ${prompt} did not finish`);
	const tools = await client.createSession("Compat tools");
	for (const prompt of ["load-tools-2", "compat-tools-follow-up"])
		if ((await client.send(tools, prompt, 30_000)).done["status"] !== "idle")
			throw new Error(`Turn ${prompt} did not finish`);
	await harness.terminate();

	// Fold the WAL in and leave WAL mode, so the fixture is one file that
	// read-only inspection never grows sidecars beside. The daemon switches the
	// copy back to WAL when it opens it.
	const store = harness.daemonStorePath();
	const db = new DatabaseSync(store);
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.exec("PRAGMA journal_mode = DELETE");
		db.exec("VACUUM");
	} finally {
		db.close();
	}
	if (existsSync(`${store}-wal`))
		throw new Error("The store still has a WAL after checkpointing");
	copyFileSync(store, output);
	console.log(`Wrote ${output}`);
} finally {
	await harness.dispose();
}
