// Failure modes: a partial import commits, clocks are confused, hidden primary
// state disappears, rowid ties reorder, a WAL source is written, or a stale
// projector cursor is advanced over an unprojected event.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
import { Effect, Either, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	DaemonStoreImportError,
	importProjectStore,
	importRegisteredProjectStores,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { makeClaudeRunnerReceiptStore } from "../../../src/lib/provider/claude/claude-runner-receipts.js";
import { DurableCommandCommitRepository } from "../../../src/lib/provider/orchestration-command-commit.js";
import {
	type ProjectManifest,
	projectManifest,
	sourceChecksums,
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";

const artifact = "test-results/82tn4-import-manifest.json";
type Project = { projectId: string; sourcePath: string };

async function fixture(
	root: string,
	projectId: string,
	options: {
		sessionId?: string;
		large?: boolean;
		synthetic?: boolean;
		unprojected?: boolean;
	} = {},
): Promise<Project> {
	const folder = join(root, projectId);
	mkdirSync(folder, { recursive: true });
	const sourcePath = join(folder, "events.db");
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(sourcePath, projectId),
	);
	const id = options.sessionId ?? `ses_${projectId}`;
	const user = `${id}_user`;
	const assistant = `${id}_assistant`;
	const time = { provider: "claude", createdAt: 1000 };
	const events: CanonicalEvent[] = [
		canonicalEvent(
			"session.created",
			id,
			{ sessionId: id, title: "Imported history", provider: "claude" },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: user, role: "user" },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: assistant, role: "assistant" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{
				messageId: assistant,
				partId: `${id}_text`,
				text: options.large
					? "long transcript ".repeat(40_000)
					: "Complete transcript",
			},
			time,
		),
		canonicalEvent(
			"thinking.start",
			id,
			{ messageId: assistant, partId: `${id}_thinking` },
			time,
		),
		canonicalEvent(
			"thinking.delta",
			id,
			{ messageId: assistant, partId: `${id}_thinking`, text: "Thinking" },
			time,
		),
		canonicalEvent(
			"thinking.end",
			id,
			{ messageId: assistant, partId: `${id}_thinking` },
			time,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId: assistant,
				partId: `${id}_tool`,
				callId: `${id}_call`,
				toolName: "Bash",
				input: { tool: "Bash", command: "pwd" },
			},
			time,
		),
		canonicalEvent(
			"tool.completed",
			id,
			{
				messageId: assistant,
				partId: `${id}_tool`,
				result: "fixture",
				duration: 10,
				metadata: {},
			},
			time,
		),
		canonicalEvent(
			"turn.completed",
			id,
			{
				messageId: assistant,
				userMessageId: user,
				cost: 0.03,
				duration: 20,
				tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
			},
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_fork`,
			{ sessionId: `${id}_fork`, title: "Fork", provider: "claude" },
			time,
		),
		canonicalEvent(
			"session.forked",
			`${id}_fork`,
			{ sessionId: `${id}_fork`, parentId: id, forkPointEvent: assistant },
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_child`,
			{
				sessionId: `${id}_child`,
				title: "Subagent",
				provider: "claude",
				parentId: id,
			},
			time,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId: assistant,
				partId: `${id}_task`,
				callId: `${id}_task_call`,
				toolName: "Task",
				input: { tool: "Task", description: "Child", prompt: "Continue" },
			},
			time,
		),
		canonicalEvent(
			"tool.running",
			id,
			{
				messageId: assistant,
				partId: `${id}_task`,
				metadata: {
					childSessionId: `${id}_child`,
					providerTaskId: `${id}_provider_task`,
				},
			},
			time,
		),
		canonicalEvent(
			"permission.asked",
			id,
			{
				id: `${id}_pending`,
				sessionId: id,
				toolName: "Bash",
				input: { command: "pwd" },
			},
			time,
		),
		canonicalEvent(
			"permission.asked",
			id,
			{
				id: `${id}_resolved`,
				sessionId: id,
				toolName: "Bash",
				input: { command: "ls" },
			},
			time,
		),
		canonicalEvent(
			"permission.resolved",
			id,
			{ id: `${id}_resolved`, decision: "once" },
			time,
		),
		canonicalEvent(
			"session.provider_changed",
			id,
			{ sessionId: id, oldProvider: "claude", newProvider: "opencode" },
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_queue_1`,
				delivery: "queue",
				request: { text: "queued first" },
			},
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_queue_2`,
				delivery: "queue",
				request: { text: "queued second" },
			},
			time,
		),
		canonicalEvent(
			"input.admitted",
			id,
			{
				sessionId: id,
				inputId: `${id}_removed`,
				delivery: "steer",
				request: { text: "cancelled" },
			},
			time,
		),
		canonicalEvent(
			"input.cancelled",
			id,
			{ sessionId: id, inputId: `${id}_removed` },
			time,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: `${id}_gone`, role: "assistant" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{ messageId: `${id}_gone`, partId: `${id}_gone_part`, text: "remove me" },
			time,
		),
		canonicalEvent(
			"message.part.removed",
			id,
			{ messageId: `${id}_gone`, partId: `${id}_gone_part` },
			time,
		),
		canonicalEvent("message.removed", id, { messageId: `${id}_gone` }, time),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId: `${id}_user_second`, role: "user" },
			time,
		),
		canonicalEvent(
			"text.delta",
			id,
			{
				messageId: `${id}_user_second`,
				partId: `${id}_user_second_text`,
				text: "Second turn",
			},
			time,
		),
		canonicalEvent(
			"session.created",
			`${id}_deleted`,
			{ sessionId: `${id}_deleted`, title: "Deleted", provider: "claude" },
			time,
		),
		canonicalEvent(
			"session.deleted",
			`${id}_deleted`,
			{ sessionId: `${id}_deleted` },
			time,
		),
		canonicalEvent(
			"session.workspace_changed",
			id,
			{
				sessionId: id,
				worktrees: {},
				path: "/fixture/worktree",
				cause: "user",
				origin: "existing",
			},
			time,
		),
		canonicalEvent(
			"session.workspace_hint_changed",
			id,
			{ path: "/fixture/other" },
			time,
		),
	];
	if (options.synthetic)
		events.push(
			canonicalEvent(
				"session.compaction",
				id,
				{ sessionId: id, state: "completed", detail: "Compacted" },
				time,
			),
			canonicalEvent(
				"turn.error",
				id,
				{
					messageId: `${id}_failed`,
					userMessageId: user,
					error: "Fixture error",
					code: "FIXTURE",
				},
				time,
			),
		);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const write = yield* makeCommitAndSignal;
				// Equal timestamps exercise turns' and pending_inputs' rowid tie-breaks.
				for (const event of events) yield* write([event]);
				const sql = yield* SqlClient.SqlClient;
				const [move] = yield* sql<{
					sequence: number;
				}>`SELECT sequence FROM events WHERE session_id = ${id} AND type = 'session.workspace_changed'`;
				if (!move)
					return yield* Effect.die(new Error("Missing fixture workspace move"));
				yield* write([
					canonicalEvent(
						"input.sent",
						id,
						{
							sessionId: id,
							inputId: `${id}_queue_1`,
							workspaceMoveSequence: move.sequence,
						},
						time,
					),
				]);
				const state = yield* ProviderStateEffectTag;
				yield* state.saveUpdates(id, [
					{
						key: "nativeThread:opencode",
						value: JSON.stringify({
							resumeSessionId: `${id}_native`,
							firstSequence: 0,
							deliveredThrough: 0,
						}),
					},
					{ key: "turnCount", value: "2" },
				]);
				const thread = (yield* state.getState(id))["nativeThread:opencode"];
				const repository = new DurableCommandCommitRepository(sql, projectId);
				yield* repository.commit({
					events: [],
					readModelRows: [],
					receipt: {
						commandId: `${id}_command`,
						commandType: "send_turn",
						sessionId: id,
						status: "side_effect_requested",
						fingerprintHash: "fixture-hash",
						fingerprintVersion: 2,
						acceptedSequence: 7,
						sideEffectSequence: 7,
						createdAt: 1000,
						updatedAt: 1000,
					},
					outboxRequests: [
						{
							requestSequence: 7,
							commandId: `${id}_command`,
							sessionId: id,
							providerId: "opencode",
							effectType: "send_turn",
							payloadJson: JSON.stringify({
								providerState: { "nativeThread:opencode": thread },
								prompt: "fixture",
							}),
						},
					],
				});
				const receipts = yield* makeClaudeRunnerReceiptStore(sql);
				yield* receipts.attach(`${projectId}_runner`, "fixture-attachment");
				yield* receipts.acknowledge(
					`${projectId}_runner`,
					1,
					{},
					"fixture-attachment",
				);
				yield* sql`INSERT INTO claude_runner_permission_replies VALUES (${id}, ${`${id}_resolved`}, '{"decision":"allow"}')`;
				// These primary/legacy records have no current canonical event producer.
				yield* sql`INSERT INTO tool_content VALUES (${`${id}_blob`}, ${id}, 'saved tool result', 1000)`;
				yield* sql`INSERT INTO sent_alerts VALUES (${id}, 'turn-finished', ${assistant}, 1000, 'delivered', 'fixture-claim')`;
				yield* sql`INSERT INTO session_pick_backfill VALUES (${id}, 'driver_unresolved')`;
				yield* sql`INSERT INTO session_git_published VALUES (${`/fixture/${projectId}`}, '{"branch":"fixture"}')`;
				yield* sql`INSERT INTO session_goal_checks VALUES (${`${id}_goal_check`}, ${id}, 'complete', 1000, 2, 'continue', 1000)`;
				yield* sql`INSERT INTO provider_command_sessions (project_key, session_id, provider_id, provider_kind, status, created_at, updated_at) VALUES (${projectId}, ${id}, 'opencode', 'opencode', 'idle', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_turns (project_key, session_id, turn_id, command_id, status, created_at, updated_at) VALUES (${projectId}, ${id}, ${user}, ${`${id}_command`}, 'completed', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_interactions (project_key, session_id, interaction_id, kind, status, created_at, updated_at) VALUES (${projectId}, ${id}, ${`${id}_legacy_permission`}, 'permission', 'resolved', 1000, 1000)`;
				yield* sql`INSERT INTO provider_command_tombstones (project_key, scope_kind, scope_id, session_id, event_sequence, reason_code, tombstoned_at) VALUES (${projectId}, 'turn', ${`${id}_old_turn`}, ${id}, ${move.sequence}, 'deleted', 1000)`;
				yield* sql`UPDATE provider_command_meta SET last_applied_sequence = ${move.sequence} WHERE project_key = ${projectId}`;
				yield* sql`INSERT INTO projection_failures (projector_name, event_sequence, event_type, session_id, error, failed_at) VALUES ('fixture-diagnostic', ${move.sequence}, 'session.workspace_changed', ${id}, 'historical diagnostic', 1000)`;
				if (options.unprojected) {
					const store = yield* EventStoreEffectTag;
					yield* store.append(
						canonicalEvent(
							"session.renamed",
							id,
							{ sessionId: id, title: "Unprojected tail" },
							time,
						),
					);
				}
			}),
		);
	} finally {
		await runtime.dispose();
	}
	return { projectId, sourcePath };
}

it("imports complete projects without changing sources and rolls back rejected projects", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-daemon-import-"));
	const evidence: {
		projects: {
			before: { rows: ProjectManifest["rowCounts"]; hash: string };
			after: { rows: ProjectManifest["rowCounts"]; hash: string };
			equal: boolean;
		}[];
		idempotency: boolean;
		sourceChecksums: boolean;
		collisionRollback: boolean;
		independentProject: boolean;
		sourceTailRejected: boolean;
		destinationTailRejected: boolean;
		changedSourceReported: boolean;
		passed: boolean;
	} = {
		projects: [],
		idempotency: false,
		sourceChecksums: false,
		collisionRollback: false,
		independentProject: false,
		sourceTailRejected: false,
		destinationTailRejected: false,
		changedSourceReported: false,
		passed: false,
	};
	let walWriter: Database.Database | undefined;
	writeImportArtifact(artifact, evidence);
	try {
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		const alpha = await fixture(root, "alpha", {
			large: true,
			synthetic: true,
		});
		const seedSetup = new Database(alpha.sourcePath);
		try {
			seedSetup.exec(
				"DROP TABLE claude_runner_cursors; DROP TABLE claude_runner_permission_replies;",
			);
		} finally {
			seedSetup.close();
		}
		const beta = await fixture(root, "beta");
		const betaSetup = new Database(beta.sourcePath);
		try {
			betaSetup.exec(
				"UPDATE message_parts SET version = 0 WHERE type = 'thinking'; UPDATE sqlite_sequence SET seq = seq + 100 WHERE name = 'events'; UPDATE sessions SET project_id = NULL; UPDATE session_sidebar SET project_id = NULL; UPDATE events SET project_id = NULL; UPDATE command_receipts SET project_key = NULL;",
			);
		} finally {
			betaSetup.close();
		}
		const gamma = await fixture(root, "gamma");
		const projects = [beta, alpha, gamma];
		// Leave committed state solely in WAL, keep its writer open and suppress
		// auto-checkpoint. Imports must include it without checkpointing the source.
		walWriter = new Database(beta.sourcePath);
		walWriter.pragma("wal_autocheckpoint = 0");
		walWriter
			.prepare("UPDATE sessions SET history_complete = 0 WHERE id = ?")
			.run("ses_beta");
		const fixtureDb = new Database(beta.sourcePath, { readonly: true });
		try {
			expect(
				fixtureDb
					.prepare("SELECT COUNT(*) AS n FROM projection_failures")
					.get(),
			).toEqual({ n: 1 });
			expect(
				fixtureDb.prepare("SELECT COUNT(*) AS n FROM turns").get(),
			).toEqual({ n: 2 });
			expect(
				fixtureDb
					.prepare("SELECT status FROM pending_approvals ORDER BY status")
					.all(),
			).toEqual([{ status: "pending" }, { status: "resolved" }]);
			expect(
				fixtureDb
					.prepare(
						"SELECT COUNT(*) AS n FROM pending_inputs WHERE state = 'removed'",
					)
					.get(),
			).toEqual({ n: 2 });
		} finally {
			fixtureDb.close();
		}
		const before = projects.map((project) =>
			projectManifest(project.sourcePath, project.projectId),
		);
		const checksums = projects.map((project) =>
			sourceChecksums(project.sourcePath),
		);
		expect(checksums[0]?.wal).not.toBeNull();
		const result = await Effect.runPromise(
			importRegisteredProjectStores(configDir, projects),
		);
		expect(result.find((entry) => entry.projectId === "alpha")?.outcome).toBe(
			"seeded",
		);
		expect(result.filter((entry) => entry.outcome === "imported")).toHaveLength(
			2,
		);
		const destination = daemonStorePath(configDir);
		for (const [index, project] of projects.entries()) {
			const prior = before[index];
			if (!prior) throw new Error("Missing source manifest");
			const after = projectManifest(destination, project.projectId, prior);
			evidence.projects.push({
				before: { rows: prior.rowCounts, hash: prior.hash },
				after: { rows: after.rowCounts, hash: after.hash },
				equal: after.hash === prior.hash,
			});
			expect(after.tables, `logical manifest ${project.projectId}`).toEqual(
				prior.tables,
			);
		}
		evidence.sourceChecksums = projects.every(
			(project, index) =>
				JSON.stringify(sourceChecksums(project.sourcePath)) ===
				JSON.stringify(checksums[index]),
		);
		expect(evidence.sourceChecksums).toBe(true);
		const counts = storeTableCounts(destination);
		const rerun = await Effect.runPromise(
			importRegisteredProjectStores(configDir, projects),
		);
		expect(
			rerun.map((entry) => entry.outcome),
			JSON.stringify(rerun),
		).toEqual(["skipped", "skipped", "skipped"]);
		expect(storeTableCounts(destination)).toEqual(counts);
		for (const [index, project] of projects.entries())
			expect(
				projectManifest(destination, project.projectId, before[index]).hash,
			).toBe(before[index]?.hash);
		evidence.idempotency = true;

		const collision = await fixture(root, "collision", {
			sessionId: "ses_beta",
		});
		const rejected = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, collision)),
		);
		expect(Either.isLeft(rejected)).toBe(true);
		if (Either.isLeft(rejected)) {
			expect(rejected.left).toBeInstanceOf(DaemonStoreImportError);
			expect(rejected.left.kind).toBe("collision");
		}
		expect(storeTableCounts(destination)).toEqual(counts);
		evidence.collisionRollback = true;
		const delta = await fixture(root, "delta");
		const independent = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [collision, delta]),
		);
		expect(
			independent.map((entry) => entry.outcome),
			JSON.stringify(independent),
		).toEqual(["failed", "imported"]);
		const deltaBefore = projectManifest(delta.sourcePath, delta.projectId);
		expect(
			projectManifest(destination, delta.projectId, deltaBefore).tables,
		).toEqual(deltaBefore.tables);
		evidence.independentProject = true;

		const lagging = await fixture(root, "lagging", { unprojected: true });
		const stableCounts = storeTableCounts(destination);
		const tail = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, lagging)),
		);
		expect(Either.isLeft(tail) && tail.left.kind).toBe("unprojected-tail");
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		evidence.sourceTailRejected = true;
		const seedConfig = join(root, "bad-seed");
		mkdirSync(seedConfig);
		const seedTail = await Effect.runPromise(
			Effect.either(seedDaemonStore(seedConfig, lagging)),
		);
		expect(Either.isLeft(seedTail) && seedTail.left.kind).toBe(
			"unprojected-tail",
		);

		for (const mutation of [
			"UPDATE provider_command_sessions SET last_sequence = 1",
			"DELETE FROM effect_sql_migrations WHERE migration_id = (SELECT MAX(migration_id) FROM effect_sql_migrations)",
		]) {
			const unsupported = await fixture(
				root,
				mutation.startsWith("UPDATE") ? "legacy" : "old-schema",
			);
			const source = new Database(unsupported.sourcePath);
			try {
				source.exec(mutation);
			} finally {
				source.close();
			}
			const failed = await Effect.runPromise(
				Effect.either(importProjectStore(configDir, unsupported)),
			);
			expect(Either.isLeft(failed) && failed.left.kind).toBe(
				"unsupported-source",
			);
			expect(storeTableCounts(destination)).toEqual(stableCounts);
		}
		const tombstoneCollision = await fixture(root, "tombstone-collision");
		const tombstoneDb = new Database(tombstoneCollision.sourcePath);
		try {
			tombstoneDb
				.prepare("UPDATE message_tombstones SET message_id = ?")
				.run("ses_beta_assistant");
		} finally {
			tombstoneDb.close();
		}
		const tombstone = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, tombstoneCollision)),
		);
		expect(Either.isLeft(tombstone) && tombstone.left.kind).toBe("collision");
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		const orphanCollision = await fixture(root, "orphan-collision");
		const orphanDb = new Database(orphanCollision.sourcePath);
		try {
			orphanDb
				.prepare(
					"UPDATE events SET session_id = ? WHERE sequence = (SELECT MAX(sequence) FROM events)",
				)
				.run("ses_beta");
		} finally {
			orphanDb.close();
		}
		const orphan = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, orphanCollision)),
		);
		expect(Either.isLeft(orphan) && orphan.left.kind).toBe("collision");
		expect(storeTableCounts(destination)).toEqual(stableCounts);

		// A retired session can survive only in durable command state. Its
		// project-qualified legacy key must not hide a global session collision.
		const retainedCollision = await fixture(root, "retained-collision");
		const retainedDb = new Database(destination);
		try {
			retainedDb
				.prepare(`INSERT INTO provider_command_sessions
				(project_key, session_id, provider_id, provider_kind, status, created_at, updated_at)
				VALUES ('alpha', 'ses_retained-collision', 'claude', 'claude', 'idle', 1000, 1000)`)
				.run();
		} finally {
			retainedDb.close();
		}
		const retainedCounts = storeTableCounts(destination);
		const retained = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, retainedCollision)),
		);
		expect(Either.isLeft(retained) && retained.left.kind).toBe("collision");
		expect(storeTableCounts(destination)).toEqual(retainedCounts);
		const cleanupRetained = new Database(destination);
		try {
			cleanupRetained
				.prepare(
					"DELETE FROM provider_command_sessions WHERE project_key = 'alpha' AND session_id = 'ses_retained-collision'",
				)
				.run();
		} finally {
			cleanupRetained.close();
		}

		walWriter
			.prepare("UPDATE sessions SET history_complete = 1 WHERE id = ?")
			.run("ses_beta");
		const changed = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [beta]),
		);
		expect(changed[0]?.outcome).toBe("source-changed");
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		evidence.changedSourceReported = true;

		const destDb = new Database(destination);
		try {
			destDb.prepare("UPDATE projector_cursors SET last_applied_seq = 0").run();
		} finally {
			destDb.close();
		}
		const epsilon = await fixture(root, "epsilon");
		const destTail = await Effect.runPromise(
			Effect.either(importProjectStore(configDir, epsilon)),
		);
		expect(Either.isLeft(destTail) && destTail.left.kind).toBe(
			"unprojected-tail",
		);
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		evidence.destinationTailRejected = true;
		evidence.passed = true;
	} finally {
		writeImportArtifact(artifact, evidence);
		walWriter?.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
