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

const SHIPPED_MIGRATION_HASHES = {
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
	"0006_message_parts_compaction_type.sql":
		"ac54eede8dfd2fb98e8f71c785cdb6b5187dbb0b33c521afa9b3b917b8610eca",
	"0007_messages_context_window.sql":
		"f48d8a577eebf710b78092f158e3d90b3c5c96f728e9c1f89086863546d1bcc7",
	"0008_turn_model_execution.sql":
		"533178028fca7bd02eb561be6ca068515a916e24aa24d268359e80755d2f8096",
	"0009_sessions_permission_mode.sql":
		"704698b5fbe61b4755833cde9fb4b8dfe1f0c33f77cc38b478baef49ac0f7909",
	"0010_session_cascade_deletes.sql":
		"2c71dbc0b5afd829d4c642885e8fdcb70cb4890669ab9f9d8b9f9b8bfd65b494",
	"0011_sessions_read_at.sql":
		"27f5420844d257201e825ab10ba08edfcfc3facb53b7b9cece72540db01e8117",
	"0012_sessions_last_turn_error.sql":
		"ac34afb2ab3b5cc14383fd05f2b1d81e03579ee1d64c6d0972b8f61b58565e91",
	"0013_backfill_compaction_messages.sql":
		"70028b0cee1dd66436319c1d24d7ae3b215265aeafae8c62eba4099616695d73",
	"0014_sessions_settled_pinned.sql":
		"6109b7a23498029054c907af06a1efccef86472ef8b5fd66c8ef3b757eb1e6f9",
	"0015_sessions_snoozed.sql":
		"9e476e07945b4ea923b832a5b69b2cb204fc082e99932ab87f8c33cc0e89f58a",
	"0016_sessions_auto_settle.sql":
		"33ba2a35044d1f57cdfa812ad28ba71cb290e5e28f4b4e7e1e05fddc69d93ceb",
	"0017_projection_failures.sql":
		"ade689f16ce4c5a201fc872718f4f6c678923ca07e55a0774b5991fdd07ac173",
	"0018_read_model_version.sql":
		"b643e63439f45ef732258efb12ccfd40ccc8f6b85ee2ad8e6a9713537ab137af",
	"0019_read_model_counter.sql":
		"b83d069271c9161783e71f5dbd0330622e6cc83340d13ec31e396da591813769",
	"0020_sent_alerts.sql":
		"094c38bd9dccf2799076feb9dce6196a83cf1699e58bee296e14e86b1e729068",
	"0021_fork_point_timestamp.sql":
		"55e06b7e72140b5dfca14caa81625574c7132d9e26420e7074297a69f3afb113",
	"0022_sessions_marked_unread.sql":
		"c424314faa1dacf6bb00f9043a9c83bc36136ef5bcdc791814e135d84151f958",
	"0023_session_attention.sql":
		"42461e73eb8c43e20db3a2570a9b06fb36ae0692353442cecb68f909ec494cc2",
	"0024_read_state_to_turn_ends.sql":
		"2f5154cc5928c3df40633d9526c6ae22d1d28f33aed616f7b3d11082d1b81d98",
	"0025_sessions_forked_from.sql":
		"6ad03148727ef382f1f8d3958910ada6eadf2bce56987ad173eace9b8ba7d32c",
	"0026_messages_backfilled.sql":
		"5249e2f101d80480898a842eb7ef27c824071ce4507fcb9610e99763f9c5aba9",
	"0027_sessions_history_complete.sql":
		"7b07ce8f2b5f7224574acecced69d6241df2e7d4bf2d92a55907589ef41a1198",
	"0028_message_tombstones.sql":
		"54bcb95d358a1b8563a3de2dbf2732b332bd6a45cd33906155d813724db92a76",
	"0029_session_goals.sql":
		"1bd0eede9404bc58e9e376877996da89ccd6627d907c1e22316b33687d55ae43",
	"0030_startup_restore_indexes.sql":
		"84bf88279447e47eccb1e0c167865ece044ebdf5a61b026fb244df1490c6cb24",
	"0031_tool_call_index.sql":
		"6aeb7378d45a6fd2f2efe26390fb45a7573cd3ba833c21d6a10ced32aa89de96",
	"0032_pending_approvals_version.sql":
		"6b8757c79ec3a05864d72d9a9f9f813ba6bff24d923f4c91ab5decca0f631018",
	"0033_sessions_model_settings.sql":
		"b73ed248ed34d011e5127c6a240512dedd726a7fe7de89518ae4bd5aa1eefb27",
	"0034_sessions_side_thread.sql":
		"04bdd308699b5355cc5bf38405136551c408fa83ead2b9bdbd8a52643b180a98",
	"0035_sessions_limit_recovery.sql":
		"30ba500dba79cbb3a9c2979d63c2db083699ed11742435f26d0b9a49f2dd666f",
	"0036_sessions_resumes.sql":
		"baf0ede81b1ce62ed4114ebadcebc5790002c5029ee43176840192bcc7110c89",
	"0037_session_sidebar.sql":
		"a127b46ea6bde1e8df71fc15de72232c73874d033ba8be5f284d088ca0ed3c08",
	"0038_session_sidebar_tombstones.sql":
		"14c0f43e4b94c37a1d18a33ce135cfd7209bbcaaa3a85c00ad988a3fd87e4b75",
} satisfies Record<string, string>;

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
