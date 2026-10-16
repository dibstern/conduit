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
		"08be345da1699bd430c0abfb4ee369ef4bb197ddcbfe96af8b4b040cb4e60c0b",
	"0039_sessions_workspace.sql":
		"b37dbcd0febeb5a9d39959263b1341b192104638ef40140772af18e8a2ae61dd",
	"0040_messages_input_id.sql":
		"9810a56cd0d51fc664bf8eabbe757997bad9abcff00142052d4ddcc129ba130e",
	"0041_pending_inputs.sql":
		"4454f92eb123bac242c514140668577a7c06874a119de4ea42d32b8cfc8716d6",
	"0042_messages_steered.sql":
		"bc7e3ec7b28fdd150dc76afbbc5a45f9fde2aa28c6c817c80fca72bd24410afc",
	"0043_sessions_last_turn_end_input_id.sql":
		"c053fb26981748d594cb750829156ea93b7b9a8913ee744a4660d17579c3e092",
	"0044_project_provenance.sql":
		"74c70d168dd3e2a3b6ba8d79e082c9c5399a9134596e4326f35e04eaa8fa6880",
	"0045_messages_context_tokens.sql":
		"3c9b9a0d6642743f73d0873401aff4337371fb6b57a1e9af3c6d0e087dbfd758",
	"0046_messages_completed_at.sql":
		"86d1bca97ee9d97f2d27f43c947758ede52fa73ff9acb3292256e5ae31779b69",
	"0047_sessions_claude_worktree_state.sql":
		"e4ee51459d89f465247de115fc7db07de678e7daab24ba1069f9aab2369f3ae4",
	"0048_sessions_workspace_hint.sql":
		"e4ba9b42bd6c018c488be554f77d18e8f414bf856f67b6d08780aa297d335338",
	"0049_sessions_pending_rewind.sql":
		"800627b4fcb1a3dd9981547efcf92c686b27920f962dd5ed6445598b4747f77c",
	"0050_message_part_versions.sql":
		"2ce56e8af786cd6792f7272045f88f39b70cff05374107195a7db9fdc49fa939",
	"0051_session_git_published.sql":
		"205eeb72db732ded84a158f22db36d6180b22a5843d862ea4c8a8b6e1f968157",
	"0052_store_identity.sql":
		"4c34513f8564f8f6f4af0140445e7b7676ca4293b9ab1efe56f5455e62f9d1cf",
	"0053_events_unstamped_index.sql":
		"5960ff526aca456c19a4d3baea8fb876d80586b3153b57f1fb0149e5e61658ef",
	"0054_events_session_type_index.sql":
		"f28a0226c1cc8f86174ce646e14ae241765e5a63589a78a2cb942800d102b95c",
	"0055_drop_activities.sql":
		"db617a57dfbd9081ce9c7f0b90d05eee2bded880b12a80cbf6815bb7c8b277bc",
	"0056_session_pick_backfill.sql":
		"cb6c2389c5629e5e78936b55f161038ce0d3a91a6daf87c39a49a58f9bc383d9",
	"0057_compact_redundant_events.sql":
		"31851d8038679c54ec637d7e952976e5f494792e4f795c1aaf298af96926969a",
	"0058_session_project_scope.sql":
		"7a728bf86fade4f288f477b086566700f9cbae71a6984271d5ef8f231eabdf28",
	"0059_sessions_lineage.sql":
		"160bb88d6430d0feb2beb0277fca64930a860d02924286f785c12a3157082550",
	"0060_legacy_forks.sql":
		"bfb0aad3254f1b17cabaa6b1959d815153f3e3e0819a5cea5322d7a4f938e333",
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
		// Effect key 10 is a code-only purge; SQL files run from 0001 to 0060.
		expect(onDisk).toHaveLength(60);
		expect(onDisk.map((file) => Number(file.slice(0, 4)))).toEqual(
			Array.from({ length: 60 }, (_, index) => index + 1),
		);
	});
});
