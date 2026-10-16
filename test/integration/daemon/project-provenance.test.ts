import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ListDaemonSessions,
	SaveProject,
	SubmitInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const tables = [
	"command_receipts",
	"events",
	"provider_command_interactions",
	"provider_command_meta",
	"provider_command_outbox",
	"provider_command_sessions",
	"provider_command_tombstones",
	"provider_command_turns",
] as const;

function provenance(fixture: ProcessHarness, slug: string) {
	const db = new Database(fixture.projectStorePath(slug), { readonly: true });
	try {
		return {
			events: db
				.prepare(`SELECT type, project_id, COUNT(*) AS count
				FROM events GROUP BY type, project_id ORDER BY type, project_id`)
				.all(),
			receipts: db
				.prepare(`SELECT command_type, status, project_key, COUNT(*) AS count
				FROM command_receipts GROUP BY command_type, status, project_key
				ORDER BY command_type, status, project_key`)
				.all(),
			tables: tables.map((table) => ({
				table,
				column: table === "events" ? "project_id" : "project_key",
				rows: db
					.prepare(`SELECT ${table === "events" ? "project_id" : "project_key"} AS project, COUNT(*) AS count FROM ${table}
					GROUP BY project ORDER BY project`)
					.all() as Array<{
					project: string | null;
					count: number;
				}>,
			})),
		};
	} finally {
		db.close();
	}
}

function outbox(fixture: ProcessHarness, slug: string) {
	const db = new Database(fixture.projectStorePath(slug), { readonly: true });
	try {
		return db
			.prepare(`SELECT command_id, status, attempt_count
			FROM provider_command_outbox ORDER BY request_sequence`)
			.all() as Array<{
			command_id: string;
			status: string;
			attempt_count: number;
		}>;
	} finally {
		db.close();
	}
}

// Copy daemon-written history into the actual schema immediately before this
// ticket. No DROP COLUMN simulation: the old migration registry creates it.
async function stagePreProvenanceStore(filename: string) {
	const source = `${filename}.before-provenance`;
	copyFileSync(filename, source);
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(`${filename}${suffix}`, { force: true });
	await Effect.runPromise(
		Effect.scoped(
			makeEffectSqlMigrator(
				Object.fromEntries(Object.entries(effectMigrationEntries).slice(0, 44)),
			).pipe(Effect.provide(SqliteClient.layer({ filename }))),
		),
	);
	const db = new Database(filename);
	try {
		db.pragma("foreign_keys = OFF");
		db.prepare("ATTACH DATABASE ? AS previous").run(source);
		const names = db
			.prepare(`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			AND name != 'effect_sql_migrations' ORDER BY name`)
			.all() as Array<{ name: string }>;
		db.transaction(() => {
			for (const { name } of names) {
				const columns = (
					db.pragma(`table_info(${name})`) as Array<{ name: string }>
				)
					.map((column) => `"${column.name}"`)
					.join(", ");
				db.exec(`DELETE FROM ${name}`);
				db.exec(
					`INSERT INTO ${name} (${columns}) SELECT ${columns} FROM previous.${name}`,
				);
			}
		})();
		expect(db.pragma("table_info(events)")).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "project_id" })]),
		);
		// Exercise real legacy folder keys, including metadata PK collisions.
		for (const table of tables.filter((table) => table !== "events"))
			db.exec(`UPDATE ${table} SET project_key = 'legacy-folder'`);
		db.exec(`INSERT INTO provider_command_meta
			(project_key, last_applied_sequence, schema_version, rebuilt_at)
			SELECT 'other-legacy-folder', last_applied_sequence + 1, schema_version, rebuilt_at
			FROM provider_command_meta`);
	} finally {
		db.close();
	}
}

describe("Project provenance through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	const slugs = ["process-test", "provenance-two"];

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-2-${scenario}.json`,
				JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>"),
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	async function start(name: string) {
		scenario = name;
		evidence = {};
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		harness = await ProcessHarness.start();
		const second = join(harness.root, "provenance-two");
		mkdirSync(second);
		await sendRpcRequest(
			join(harness.configDir, "relay.sock"),
			new SaveProject({
				folders: [second],
			}),
		);
		return harness;
	}

	it("creates, sends, approves and deletes in two projects, executing each command once", async () => {
		const fixture = await start("commands");
		const projects = [];
		for (const slug of slugs) {
			const browser = await fixture.connect(
				undefined,
				`provenance-${slug}`,
				slug,
			);
			const sessionId = await browser.createSession("Project provenance");
			await browser.send(sessionId, "stream-parity");
			await vi.waitFor(() =>
				expect(outbox(fixture, slug)).toMatchObject([
					{ status: "completed", attempt_count: 1 },
				]),
			);
			const commandId = outbox(fixture, slug)[0]?.command_id;
			expect(commandId).toBeDefined();
			// Replay the identical command through RPC. Its durable receipt must
			// suppress a second provider execution, including after the next turn.
			const replay = () =>
				sendRpcRequest(
					join(fixture.configDir, "relay.sock"),
					new SubmitInput({
						sessionId,
						originId: `provenance-${slug}`,
						inputId: commandId ?? "missing-command",
						delivery: "queue",
						text: "stream-parity",
					}),
				);
			await replay();
			const cursor = browser.frames.length;
			const approvalsBefore = fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-command" && mark.type === "answer-permission",
			).length;
			const pending = browser.send(sessionId, "approval-parity");
			const request = await browser.waitFor(
				(message) => message["type"] === "permission_pending",
				cursor,
			);
			await browser.answerApproval(request, "allow");
			await pending;
			await replay();
			await vi.waitFor(() =>
				expect(outbox(fixture, slug)).toMatchObject([
					{ status: "completed", attempt_count: 1 },
					{ status: "completed", attempt_count: 1 },
				]),
			);
			await browser.deleteSession(sessionId);
			const manifest = provenance(fixture, slug);
			for (const table of manifest.tables)
				for (const row of table.rows)
					expect(row.project, table.table).toBe(slug);
			expect(manifest.events).toEqual(
				expect.arrayContaining([
					{ type: "session.created", project_id: slug, count: 1 },
					{ type: "session.deleted", project_id: slug, count: 1 },
					{ type: "permission.asked", project_id: slug, count: 1 },
					{ type: "permission.resolved", project_id: slug, count: 1 },
					{ type: "input.admitted", project_id: slug, count: 2 },
					{ type: "input.sent", project_id: slug, count: 2 },
				]),
			);
			for (const command of outbox(fixture, slug)) {
				expect(
					fixture.marks.filter(
						(mark) =>
							mark.kind === "runner-command" &&
							mark.type === "send-turn" &&
							mark.commandId === command.command_id,
					),
				).toHaveLength(1);
			}
			const approvalExecutions =
				fixture.marks.filter(
					(mark) =>
						mark.kind === "runner-command" && mark.type === "answer-permission",
				).length - approvalsBefore;
			expect(approvalExecutions).toBe(1);
			projects.push({
				projectId: slug,
				...manifest,
				executions: {
					send: 2,
					approve: approvalExecutions,
					create: 1,
					delete: 1,
				},
			});
		}
		expect(
			fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-command" && mark.type === "answer-permission",
			),
		).toHaveLength(2);
		evidence["projects"] = projects.sort((a, b) =>
			a.projectId.localeCompare(b.projectId),
		);
	}, 90_000);

	it("stamps pre-migration stores on open and preserves session lists, transcripts and event ordering", async () => {
		const fixture = await start("stamping");
		const histories = [];
		for (const slug of slugs) {
			const browser = await fixture.connect(undefined, undefined, slug);
			const sessionId = await browser.createSession(`History ${slug}`);
			await browser.send(sessionId, "stream-parity");
			await vi.waitFor(() =>
				expect(outbox(fixture, slug)[0]?.status).toBe("completed"),
			);
			const { sessions } = await sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				new ListDaemonSessions({ projectSlug: slug, scope: slug }),
			);
			histories.push({
				slug,
				sessionId,
				sessions,
				history: await browser.history(sessionId),
			});
		}
		await fixture.terminate();
		for (const slug of slugs) {
			mkdirSync(dirname(fixture.projectStorePath(slug)), { recursive: true });
			await stagePreProvenanceStore(fixture.projectStorePath(slug));
		}
		await fixture.restart();
		const projects = [];
		for (const before of histories) {
			const browser = await fixture.connect(
				before.sessionId,
				undefined,
				before.slug,
			);
			expect(await browser.history(before.sessionId)).toEqual(before.history);
			const { sessions } = await sendRpcRequest(
				join(fixture.configDir, "relay.sock"),
				new ListDaemonSessions({
					projectSlug: before.slug,
					scope: before.slug,
				}),
			);
			expect(sessions).toEqual(before.sessions);
			const manifest = provenance(fixture, before.slug);
			for (const table of manifest.tables)
				for (const row of table.rows)
					expect(row.project, table.table).toBe(before.slug);
			const db = new Database(fixture.projectStorePath(before.slug), {
				readonly: true,
			});
			const old = new Database(
				`${fixture.projectStorePath(before.slug)}.before-provenance`,
				{ readonly: true },
			);
			try {
				const events =
					"SELECT sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at FROM events ORDER BY sequence";
				expect(db.prepare(events).all()).toEqual(old.prepare(events).all());
			} finally {
				db.close();
				old.close();
			}
			projects.push({
				projectId: before.slug,
				...manifest,
				stamping: {
					sessionsUnchanged: true,
					transcriptsUnchanged: true,
					eventsUnchanged: true,
				},
			});
		}
		await fixture.terminate();
		await fixture.restart();
		for (const project of projects)
			expect(provenance(fixture, project.projectId)).toEqual({
				events: project.events,
				receipts: project.receipts,
				tables: project.tables,
			});
		evidence["projects"] = projects.sort((a, b) =>
			a.projectId.localeCompare(b.projectId),
		);
	}, 90_000);
});
