import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { importRegisteredProjectStores } from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
	createProjectStoreFixture,
	projectStoreBackup,
	sourceChecksums,
} from "../../helpers/daemon-store-import-manifest.js";

// Failure modes: cached recaps disappear on import, or their per-turn version
// numbers are offset as though they belonged to the global read-model clock.
it("imports cached recap chains without changing their version numbers or source store", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-recap-import-"));
	try {
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		const first = await createProjectStoreFixture(root, "existing", {
			transcript: { prompt: "Earlier request", reply: "Earlier reply" },
		});
		const source = await createProjectStoreFixture(root, "recap", {
			transcript: { prompt: "Request", reply: "Reply" },
		});
		const db = new Database(source.sourcePath);
		let expected: unknown[];
		try {
			for (const version of [1, 2])
				db.prepare(`INSERT INTO turn_recaps
				(turn_id, session_id, version, scope, first_ordinal, last_ordinal, text, model, duration_ms, created_at)
				SELECT id, session_id, ?, ?, ?, ?, ?, 'sonnet', 25, 1000 FROM turns LIMIT 1`).run(
					version,
					version === 1 ? "whole" : "new",
					version === 1 ? 1 : 5,
					version === 1 ? 4 : 7,
					`Cached version ${version} [#1]`,
				);
			expected = db.prepare("SELECT * FROM turn_recaps ORDER BY version").all();
		} finally {
			db.close();
		}
		const checksum = sourceChecksums(source.sourcePath);
		const results = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [first, source]),
		);
		const imported = new Database(daemonStorePath(configDir), {
			readonly: true,
		});
		try {
			const recaps = imported
				.prepare("SELECT * FROM turn_recaps ORDER BY version")
				.all();
			expect(recaps).toEqual(expected);
			expect(sourceChecksums(projectStoreBackup(source.sourcePath))).toEqual(
				checksum,
			);
			mkdirSync("test-results/recap", { recursive: true });
			writeFileSync(
				"test-results/recap/import.json",
				JSON.stringify({ results, recaps, sourceUnchanged: true }, null, 2),
			);
		} finally {
			imported.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
