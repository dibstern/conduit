// Failure modes: a partial import commits, clocks are confused, hidden primary
// state disappears, rowid ties reorder, a WAL source is written, or a stale
// projector cursor is advanced over an unprojected event.
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { Effect, Result as Either, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	DaemonStoreImportError,
	importProjectStore,
	importRegisteredProjectStores,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { PREVIEW_CODE_POINTS } from "../../../src/lib/persistence/tool-wire-projection.js";
import {
	daemonStoreAssertions,
	createProjectStoreFixture as fixture,
	type ProjectManifest,
	type ProjectStoreFixture,
	projectManifest,
	projectStoreBackup,
	sourceChecksums,
	storeImportPosition,
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";

const artifact = "test-results/82tn4-import-manifest.json";
type Project = ProjectStoreFixture;

it("remaps event-owned tool results when importing a project", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-tool-result-import-"));
	try {
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		const alpha = await fixture(root, "alpha", { eventSequenceStart: 1000 });
		const beta = await fixture(root, "beta");
		const output = 'imported 🦊 "output"\\\n'.repeat(PREVIEW_CODE_POINTS);
		const source = ManagedRuntime.make(
			makePersistenceEffectLayer(beta.sourcePath, beta.projectId),
		);
		try {
			await source.runPromise(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("tool.completed", "ses_beta", {
							messageId: "ses_beta_assistant",
							partId: "ses_beta_tool",
							result: output,
							duration: 10,
						}),
					]);
				}),
			);
		} finally {
			await source.dispose();
		}
		const sourceDb = new Database(beta.sourcePath, { readonly: true });
		let sourceSequence: number;
		try {
			const stored = sourceDb
				.prepare<[], { result_event_seq: number }>(
					"SELECT result_event_seq FROM message_parts WHERE id = 'ses_beta_tool'",
				)
				.get();
			expect(stored?.result_event_seq).toBeGreaterThan(0);
			sourceSequence = stored?.result_event_seq ?? 0;
		} finally {
			sourceDb.close();
		}
		await Effect.runPromise(importRegisteredProjectStores(configDir, [alpha]));
		const imported = await Effect.runPromise(
			importProjectStore(configDir, beta),
		);
		expect(imported.outcome).toBe("imported");
		const destination = daemonStorePath(configDir);
		const db = new Database(destination, { readonly: true });
		try {
			const stored = db
				.prepare<
					[],
					{ result_event_seq: number; session_id: string; result: string }
				>(
					`SELECT mp.result_event_seq, e.session_id, json_extract(e.data, '$.result') AS result
					 FROM message_parts mp JOIN events e ON e.sequence = mp.result_event_seq
					 WHERE mp.id = 'ses_beta_tool'`,
				)
				.get();
			expect(stored?.result_event_seq).toBeGreaterThan(sourceSequence);
			expect(stored).toMatchObject({ session_id: "ses_beta", result: output });
		} finally {
			db.close();
		}
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(destination, beta.projectId),
		);
		try {
			const details = await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* ReadQueryEffectTag).readToolDetails(
						"ses_beta",
						["ses_beta_call"],
					);
				}),
			);
			expect(details[0]?.output).toEqual({ _tag: "whole", text: output });
		} finally {
			await runtime.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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
		sharedSessionsExcluded: boolean;
		independentProject: boolean;
		sourceTailRecovered: boolean;
		destinationTailRejected: boolean;
		changedSourceReported: boolean;
		invariants: ReturnType<typeof daemonStoreAssertions>[];
		emptyDaemonImport: boolean;
		symlinkSeed: boolean;
		symlinkImport: boolean;
		canonicalMarkers: boolean;
		passed: boolean;
	} = {
		projects: [],
		idempotency: false,
		sourceChecksums: false,
		sharedSessionsExcluded: false,
		independentProject: false,
		sourceTailRecovered: false,
		destinationTailRejected: false,
		changedSourceReported: false,
		invariants: [],
		emptyDaemonImport: false,
		symlinkSeed: false,
		symlinkImport: false,
		canonicalMarkers: false,
		passed: false,
	};
	let walWriter: Database.Database | undefined;
	const symlinkWriters: DatabaseSync[] = [];
	writeImportArtifact(artifact, evidence);
	try {
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		const alpha = await fixture(root, "alpha", {
			large: true,
			synthetic: true,
			// Disjoint numeric ranges let omitted offsets pass uniqueness checks;
			// the raw allocation assertions must still reject them.
			eventSequenceStart: 1000,
			outboxSequence: 700,
		});
		const seedSetup = new Database(alpha.sourcePath);
		try {
			seedSetup.exec(
				"DROP TABLE claude_runner_cursors; DROP TABLE claude_runner_permission_replies; UPDATE sessions SET project_id = NULL WHERE id = 'ses_alpha'; UPDATE session_sidebar SET project_id = NULL WHERE session_id = 'ses_alpha'; UPDATE events SET project_id = NULL WHERE session_id = 'ses_alpha'; UPDATE command_receipts SET project_key = NULL;",
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
		const result = [
			...(await Effect.runPromise(
				importRegisteredProjectStores(configDir, [alpha]),
			)),
		];
		const destination = daemonStorePath(configDir);
		for (const project of [beta, gamma]) {
			const position = storeImportPosition(destination);
			result.push(
				...(await Effect.runPromise(
					importRegisteredProjectStores(configDir, [project]),
				)),
			);
			const assertions = daemonStoreAssertions(destination, {
				projectId: project.projectId,
				before: position,
			});
			evidence.invariants.push(assertions);
			for (const [name, passed] of Object.entries(assertions))
				expect.soft(passed, `${project.projectId}: ${name}`).toBe(true);
		}
		expect(result.find((entry) => entry.projectId === "alpha")?.outcome).toBe(
			"seeded",
		);
		expect(result.filter((entry) => entry.outcome === "imported")).toHaveLength(
			2,
		);
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
				JSON.stringify(
					sourceChecksums(projectStoreBackup(project.sourcePath)),
				) === JSON.stringify(checksums[index]),
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
			Effect.result(importProjectStore(configDir, collision)),
		);
		expect(Either.isSuccess(rejected) && rejected.success).toMatchObject({
			outcome: "imported",
			importedEvents: 0,
			sharedSessions: [
				"ses_beta",
				"ses_beta_child",
				"ses_beta_deleted",
				"ses_beta_fork",
			],
		});
		expect(
			projectManifest(destination, beta.projectId, before[0]).tables,
		).toEqual(before[0]?.tables);
		evidence.sharedSessionsExcluded = true;
		const delta = await fixture(root, "delta");
		const deltaPosition = storeImportPosition(destination);
		const independent = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [collision, delta]),
		);
		expect(
			independent.map((entry) => entry.outcome),
			JSON.stringify(independent),
		).toEqual(["skipped", "imported"]);
		const deltaBefore = projectManifest(
			projectStoreBackup(delta.sourcePath),
			delta.projectId,
		);
		expect(
			projectManifest(destination, delta.projectId, deltaBefore).tables,
		).toEqual(deltaBefore.tables);
		evidence.independentProject = true;
		const deltaAssertions = daemonStoreAssertions(destination, {
			projectId: delta.projectId,
			before: deltaPosition,
		});
		evidence.invariants.push(deltaAssertions);
		for (const [name, passed] of Object.entries(deltaAssertions))
			expect.soft(passed, `delta: ${name}`).toBe(true);

		const lagging = await fixture(root, "lagging", { unprojected: true });
		let stableCounts = storeTableCounts(destination);
		const tail = await Effect.runPromise(
			Effect.result(importProjectStore(configDir, lagging)),
		);
		expect(Either.isSuccess(tail) && tail.success.outcome).toBe("imported");
		const recovered = new Database(destination, { readonly: true });
		try {
			expect(
				recovered
					.prepare("SELECT title FROM sessions WHERE id = 'ses_lagging'")
					.get(),
			).toEqual({ title: "Unprojected tail" });
		} finally {
			recovered.close();
		}
		stableCounts = storeTableCounts(destination);
		evidence.sourceTailRecovered = true;
		const seedConfig = join(root, "bad-seed");
		mkdirSync(seedConfig);
		const seedTail = await Effect.runPromise(
			Effect.result(seedDaemonStore(seedConfig, lagging)),
		);
		expect(Either.isSuccess(seedTail) && seedTail.success.outcome).toBe(
			"seeded",
		);

		for (const mutation of [
			"UPDATE provider_command_sessions SET last_sequence = 1",
			"DROP TABLE daemon_store_imports; DELETE FROM effect_sql_migrations WHERE migration_id = 60",
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
				Effect.result(importProjectStore(configDir, unsupported)),
			);
			if (mutation.startsWith("UPDATE")) {
				expect(Either.isFailure(failed) && failed.failure.kind).toBe(
					"unsupported-source",
				);
				expect(storeTableCounts(destination)).toEqual(stableCounts);
			} else {
				expect(Either.isSuccess(failed) && failed.success.outcome).toBe(
					"imported",
				);
				stableCounts = storeTableCounts(destination);
			}
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
			Effect.result(importProjectStore(configDir, tombstoneCollision)),
		);
		expect(Either.isFailure(tombstone)).toBe(true);
		if (Either.isFailure(tombstone)) {
			expect(tombstone.failure).toBeInstanceOf(DaemonStoreImportError);
			expect(tombstone.failure.kind).toBe("collision");
		}
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
			Effect.result(importProjectStore(configDir, orphanCollision)),
		);
		expect(Either.isSuccess(orphan) && orphan.success).toMatchObject({
			outcome: "imported",
			sharedSessions: ["ses_beta"],
		});
		stableCounts = storeTableCounts(destination);

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
			Effect.result(importProjectStore(configDir, retainedCollision)),
		);
		expect(Either.isFailure(retained) && retained.failure.kind).toBe(
			"unsupported-source",
		);
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

		walWriter.close();
		walWriter = undefined;
		copyFileSync(projectStoreBackup(beta.sourcePath), beta.sourcePath);
		const recreated = new Database(beta.sourcePath);
		try {
			recreated
				.prepare("UPDATE sessions SET history_complete = 1 WHERE id = ?")
				.run("ses_beta");
		} finally {
			recreated.close();
		}
		const changed = await Effect.runPromise(
			importRegisteredProjectStores(configDir, [beta]),
		);
		expect(changed[0]?.outcome).toBe("source-changed");
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		evidence.changedSourceReported = true;

		const emptyConfig = join(root, "empty-daemon");
		mkdirSync(emptyConfig);
		const emptyDestination = daemonStorePath(emptyConfig);
		const emptyRuntime = ManagedRuntime.make(
			makePersistenceEffectLayer(emptyDestination, "empty"),
		);
		try {
			await emptyRuntime.runPromise(
				Effect.flatMap(ProjectionRunnerEffectTag, (runner) => runner.recover()),
			);
		} finally {
			await emptyRuntime.dispose();
		}
		const emptyPosition = storeImportPosition(emptyDestination);
		expect(emptyPosition.eventSequence).toBe(0);
		const populated = await fixture(root, "empty-target-source");
		const populatedManifest = projectManifest(
			populated.sourcePath,
			populated.projectId,
		);
		const emptyResult = await Effect.runPromise(
			importProjectStore(emptyConfig, populated),
		);
		expect(emptyResult.outcome).toBe("imported");
		expect(
			projectManifest(emptyDestination, populated.projectId, populatedManifest)
				.tables,
		).toEqual(populatedManifest.tables);
		const emptyAssertions = daemonStoreAssertions(emptyDestination, {
			projectId: populated.projectId,
			before: emptyPosition,
		});
		evidence.invariants.push(emptyAssertions);
		for (const [name, passed] of Object.entries(emptyAssertions))
			expect.soft(passed, `empty destination: ${name}`).toBe(true);
		evidence.emptyDaemonImport = true;

		const symlinkConfig = join(root, "symlink-daemon");
		mkdirSync(symlinkConfig);
		const symlinkSources: Project[] = [];
		const aliases: Project[] = [];
		for (const projectId of ["symlink-seed", "symlink-import"]) {
			const source = await fixture(root, projectId, {
				large: projectId === "symlink-seed",
			});
			const writer = new DatabaseSync(source.sourcePath);
			symlinkWriters.push(writer);
			writer.exec("PRAGMA wal_autocheckpoint = 0");
			writer.exec("BEGIN");
			writer.prepare("SELECT COUNT(*) FROM events").get();
			const runtime = ManagedRuntime.make(
				makePersistenceEffectLayer(source.sourcePath, projectId),
			);
			try {
				await runtime.runPromise(
					Effect.gen(function* () {
						const write = yield* makeCommitAndSignal;
						yield* write([
							canonicalEvent(
								"session.renamed",
								`ses_${projectId}`,
								{
									sessionId: `ses_${projectId}`,
									title: "Committed only in WAL",
								},
								{ provider: "claude", createdAt: 2000 },
							),
						]);
					}),
				);
			} finally {
				await runtime.dispose();
			}
			// Empty optimizer statistics force optimize to consider this attached
			// source. An importer must never try to ANALYZE a read-only source.
			writer.exec("COMMIT");
			writer.exec("ANALYZE; DELETE FROM sqlite_stat1;");
			if (
				writer
					.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat4'")
					.get()
			)
				writer.exec("DELETE FROM sqlite_stat4;");
			expect(statSync(`${source.sourcePath}-wal`).size).toBeGreaterThan(0);
			const mainOnlyPath = join(root, `${projectId}-main-only.db`);
			copyFileSync(source.sourcePath, mainOnlyPath);
			const mainOnly = new Database(mainOnlyPath, { readonly: true });
			try {
				const mainCount = mainOnly
					.prepare("SELECT COUNT(*) AS n FROM events")
					.get() as { n: number };
				const committedCount = writer
					.prepare("SELECT COUNT(*) AS n FROM events")
					.get() as { n: number };
				expect(
					mainCount.n,
					"the new event must exist only in WAL",
				).toBeLessThan(committedCount.n);
			} finally {
				mainOnly.close();
			}
			const alias = join(root, `${projectId}.db`);
			symlinkSync(source.sourcePath, alias);
			symlinkSources.push(source);
			aliases.push({ projectId, sourcePath: alias });
		}
		const seedSource = symlinkSources[0];
		const importedSource = symlinkSources[1];
		if (!seedSource || !importedSource)
			throw new Error("Missing symlink sources");
		const symlinkManifests = symlinkSources.map((source) =>
			projectManifest(source.sourcePath, source.projectId),
		);
		const symlinkChecksums = symlinkSources.map((source) =>
			sourceChecksums(source.sourcePath),
		);
		const symlinkPosition = storeImportPosition(seedSource.sourcePath);
		const symlinkResults = await Effect.runPromise(
			importRegisteredProjectStores(symlinkConfig, [...aliases].reverse()),
		);
		expect(
			symlinkResults.find((result) => result.projectId === seedSource.projectId)
				?.outcome,
			JSON.stringify(symlinkResults),
		).toBe("seeded");
		expect(
			symlinkResults.find(
				(result) => result.projectId === importedSource.projectId,
			)?.outcome,
			JSON.stringify(symlinkResults),
		).toBe("imported");
		const symlinkDestination = daemonStorePath(symlinkConfig);
		for (const [index, source] of symlinkSources.entries()) {
			const prior = symlinkManifests[index];
			if (!prior) throw new Error("Missing WAL manifest");
			expect(
				projectManifest(symlinkDestination, source.projectId, prior).tables,
				`WAL frames for ${source.projectId}`,
			).toEqual(prior.tables);
			expect(sourceChecksums(projectStoreBackup(source.sourcePath))).toEqual(
				symlinkChecksums[index],
			);
		}
		const symlinkAssertions = daemonStoreAssertions(symlinkDestination, {
			projectId: importedSource.projectId,
			before: symlinkPosition,
		});
		evidence.invariants.push(symlinkAssertions);
		for (const [name, passed] of Object.entries(symlinkAssertions))
			expect.soft(passed, `symlink: ${name}`).toBe(true);
		const markers = new Database(symlinkDestination, { readonly: true });
		try {
			for (const source of symlinkSources)
				expect(
					markers
						.prepare(
							"SELECT source_path FROM daemon_store_imports WHERE project_id = ?",
						)
						.get(source.projectId),
				).toEqual({ source_path: source.sourcePath });
		} finally {
			markers.close();
		}
		expect(
			(
				await Effect.runPromise(
					importRegisteredProjectStores(symlinkConfig, aliases),
				)
			).every((result) => result.outcome === "skipped"),
		).toBe(true);
		expect(
			(
				await Effect.runPromise(
					importRegisteredProjectStores(symlinkConfig, symlinkSources),
				)
			).every((result) => result.outcome === "skipped"),
		).toBe(true);
		evidence.symlinkSeed = true;
		evidence.symlinkImport = true;
		evidence.canonicalMarkers = true;

		const destDb = new Database(destination);
		try {
			destDb.prepare("UPDATE projector_cursors SET last_applied_seq = 0").run();
		} finally {
			destDb.close();
		}
		const epsilon = await fixture(root, "epsilon");
		const destTail = await Effect.runPromise(
			Effect.result(importProjectStore(configDir, epsilon)),
		);
		expect(Either.isFailure(destTail) && destTail.failure.kind).toBe(
			"unprojected-tail",
		);
		expect(storeTableCounts(destination)).toEqual(stableCounts);
		evidence.destinationTailRejected = true;
		evidence.passed = evidence.invariants.every((checks) =>
			Object.values(checks).every(Boolean),
		);
	} finally {
		writeImportArtifact(artifact, evidence);
		walWriter?.close();
		for (const writer of symlinkWriters) writer.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
