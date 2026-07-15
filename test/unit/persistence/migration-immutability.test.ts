// ─── Migration Immutability Guard ────────────────────────────────────────────
// Shipped migrations are applied exactly once per database and recorded in the
// effect_sql_migrations bookkeeping table. Editing an already-shipped file only
// changes what FRESH databases get — every existing database keeps the old
// schema, silently forking deployed schemas from the checked-in baseline.
//
// That exact mistake shipped in f1f94c2e: it removed the events.session_id
// FOREIGN KEY by editing 0001 in place, so databases created before it kept
// the FK and rejected every OpenCode runtime-ingress write (fixed by 0004).
//
// If this test fails: do NOT update the hash. Revert the edit and express the
// schema change as a NEW migration file instead. Only append new entries here.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(
	import.meta.dirname,
	"../../../src/lib/persistence/migrations",
);

const SHIPPED_MIGRATION_HASHES: Record<string, string> = {
	"0001_current_event_store.sql":
		"2758f4b08c34b1acab9c151b2e80daf94e2e85bd802e0a8464ef15b6b1d78d1b",
	"0002_message_part_metadata.sql":
		"e1dccc67ff0f79d6f3f40f58acd46c08ebbc58003cd80ce7278fef291ae8b8ca",
	"0003_durable_provider_commands.sql":
		"8b2300726a0e08d1a4fd50da16d96834413104e67b0a770fff5f2e5d2072ce4b",
	"0004_drop_events_session_fk.sql":
		"179a1c6414e125919ec66d155c696ed3de02b41dbef71acfb84bf07511c7b4a6",
	"0005_message_parts_file_type.sql":
		"699999463ada108bdd14801d62e447c381fea837ce96c1457b901806a0650f08",
};

describe("shipped migrations are immutable", () => {
	it("every shipped migration file matches its pinned hash", () => {
		for (const [file, expected] of Object.entries(SHIPPED_MIGRATION_HASHES)) {
			const sql = readFileSync(join(MIGRATIONS_DIR, file));
			const actual = createHash("sha256").update(sql).digest("hex");
			expect(
				actual,
				`${file} changed after shipping. Existing databases already ran the old version — write a NEW migration instead of editing this one.`,
			).toBe(expected);
		}
	});

	it("every migration file on disk is pinned (append new entries here)", () => {
		const onDisk = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		expect(onDisk).toEqual(Object.keys(SHIPPED_MIGRATION_HASHES).sort());
	});
});
