// Legacy fixtures enter through daemon startup; offline copies exercise import failures.
import {
	copyFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
	importRegisteredProjectStores,
	type ProjectStoreImportResult,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
	createLegacyDaemonFixture,
	daemonStoreAssertions,
	daemonStoreManifest,
	type ProjectManifest,
	projectManifest,
	sourceChecksums,
	storeImportPosition,
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const artifact = "test-results/82tn4-daemon-store-import.json";
const failureArtifact = "test-results/82tn5-daemon-store-import.json";
const completedAt = 1_800_000_000_000;
const initial = {
	projects: [],
	sourceChecksums: false,
	idempotency: false,
	invariants: [],
	passed: false,
};

test.use({ startHarness: false });

test.beforeEach(() => {
	writeImportArtifact(artifact, initial);
	writeImportArtifact(failureArtifact, { runs: [], passed: false });
});

test("imports both legacy project histories before the first daemon start", async ({
	harness,
}, testInfo) => {
	const evidence: {
		projects: {
			before: { rows: ProjectManifest["rowCounts"]; hash: string };
			after: { rows: ProjectManifest["rowCounts"]; hash: string };
			equal: boolean;
			versionRestamped: boolean;
		}[];
		sourceChecksums: boolean;
		idempotency: boolean;
		invariants: ReturnType<typeof daemonStoreAssertions>[];
		passed: boolean;
	} = { ...initial, projects: [] };
	const failures: {
		runs: {
			outcomes: unknown[];
			report: string;
			manifestHash: string;
		}[];
		passed: boolean;
	} = { runs: [], passed: false };
	try {
		const savedSlug = "project-b";
		const sessionB = "ses_import_history_b";
		await createLegacyDaemonFixture(harness.configDir, [
			{
				projectId: "process-test",
				folder: harness.projectDir,
				sessionId: "ses_import_history_a",
				prompt: "import-history-a",
				reply: "done(import-history-a)",
			},
			{
				projectId: savedSlug,
				folder: join(harness.root, "project-b"),
				sessionId: sessionB,
				prompt: "Hello, reply with just the word pong",
				reply: "pong",
			},
		]);

		const projects = [
			{ projectId: "process-test", folder: harness.projectDir },
			{ projectId: savedSlug, folder: join(harness.root, "project-b") },
		].map((project) => ({
			...project,
			sourcePath: realpathSync(
				harness.legacyProjectStorePath(project.projectId),
			),
		}));
		const before = projects.map((project) =>
			projectManifest(project.sourcePath, project.projectId),
		);
		const checksums = projects.map((project) =>
			sourceChecksums(project.sourcePath),
		);
		// With two sources the seed's untouched clocks are exactly the
		// destination clocks before the only remaining project is imported.
		const positions = projects.map((project) =>
			storeImportPosition(project.sourcePath),
		);
		const destination = daemonStorePath(harness.configDir);
		expect(existsSync(destination)).toBe(false);
		await harness.restart({ skipBrowserProbe: true });
		await harness.terminate();
		const markerDb = new DatabaseSync(destination, { readOnly: true });
		const results = (() => {
			try {
				return projects.map(({ projectId, sourcePath }) => {
					const marker = markerDb
						.prepare(
							"SELECT method, completed_at, version_offset FROM daemon_store_imports WHERE project_id = ?",
						)
						.get(projectId);
					expect(marker?.["method"]).toMatch(/^(seeded|imported)$/);
					return {
						projectId,
						outcome: String(marker?.["method"]),
						versionOffset: Number(marker?.["version_offset"]),
						backup: `${sourcePath}.imported-${marker?.["completed_at"]}`,
					};
				});
			} finally {
				markerDb.close();
			}
		})();
		expect(results.map((result) => result.outcome).sort()).toEqual([
			"imported",
			"seeded",
		]);
		const seedIndex = projects.findIndex((project) =>
			results.some(
				(result) =>
					result.projectId === project.projectId && result.outcome === "seeded",
			),
		);
		const position = positions[seedIndex];
		if (!position) throw new Error("Missing pre-import seed position");
		const assertLiveHistories = () => {
			const live = new DatabaseSync(destination, { readOnly: true });
			try {
				const publications = live
					.prepare(
						"SELECT directory, git, workspace_missing FROM session_git_published",
					)
					.all();
				for (const publication of publications) {
					expect(
						projects.map((project) => realpathSync(project.folder)),
					).toContain(publication["directory"]);
					expect(publication).toMatchObject({
						git: null,
						workspace_missing: null,
					});
				}
				evidence.invariants = [];
				return projects.map((project, index) => {
					const prior = before[index];
					const sourcePosition = positions[index];
					const result = results.find(
						({ projectId }) => projectId === project.projectId,
					);
					if (!prior || !sourcePosition || !result)
						throw new Error("Missing source import evidence");
					if (result.outcome === "imported") {
						const assertions = daemonStoreAssertions(destination, {
							projectId: result.projectId,
							before: position,
							minimumHorizon:
								result.versionOffset + sourcePosition.readModelVersion,
						});
						evidence.invariants.push(assertions);
						for (const [name, passed] of Object.entries(assertions))
							expect(passed, name).toBe(true);
					}
					const publication = live
						.prepare(
							"SELECT version FROM session_git_published WHERE directory = ?",
						)
						.get(realpathSync(project.folder));
					const publicationVersion = publication
						? Number(publication["version"])
						: undefined;
					const restampedVersion =
						publicationVersion !== undefined &&
						publicationVersion >
							result.versionOffset + sourcePosition.readModelVersion
							? publicationVersion
							: undefined;
					const source = new DatabaseSync(result.backup, { readOnly: true });
					try {
						const familyVersions = `SELECT session.id, session.version,
							sidebar.version AS sidebar_version, json_extract(sidebar.row, '$.version') AS row_version
							FROM sessions session JOIN session_sidebar sidebar ON sidebar.session_id = session.root_id`;
						const families = source.prepare(familyVersions).all();
						expect(families).toHaveLength(
							prior.tables["sessions"]?.length ?? 0,
						);
						expect(families.length).toBeGreaterThan(0);
						for (const family of families) {
							const expected = { ...family };
							for (const field of ["version", "sidebar_version", "row_version"])
								expected[field] =
									restampedVersion ??
									Number(family[field]) + result.versionOffset;
							expect(
								live
									.prepare(`${familyVersions} WHERE session.id = ?`)
									.get(String(family["id"])),
							).toEqual(expected);
						}
					} finally {
						source.close();
					}
					const after = projectManifest(destination, project.projectId, prior);
					// Live Git publication restamps the family without changing its history.
					// The raw check above proves those exact stamps before comparing every other cell.
					const [priorHistory, afterHistory] = [prior, after].map(
						({ tables }) => {
							const content = structuredClone(tables);
							for (const row of content["sessions"] ?? [])
								delete row["version"];
							for (const row of content["session_sidebar"] ?? []) {
								delete row["version"];
								delete (row["row"] as Record<string, unknown>)["version"];
							}
							return content;
						},
					);
					expect(afterHistory).toEqual(priorHistory);
					return {
						before: { rows: prior.rowCounts, hash: prior.hash },
						after: { rows: after.rowCounts, hash: after.hash },
						equal: true,
						versionRestamped: restampedVersion !== undefined,
					};
				});
			} finally {
				live.close();
			}
		};
		evidence.projects = assertLiveHistories();
		evidence.sourceChecksums = projects.every((project, index) => {
			const backup = results.find(
				(result) => result.projectId === project.projectId,
			)?.backup;
			expect(existsSync(project.sourcePath)).toBe(false);
			expect(backup?.startsWith(`${project.sourcePath}.imported-`)).toBe(true);
			return (
				backup !== undefined &&
				JSON.stringify(sourceChecksums(backup)) ===
					JSON.stringify(checksums[index])
			);
		});
		expect(evidence.sourceChecksums).toBe(true);
		const counts = storeTableCounts(destination);
		const beforeSkippedImport = daemonStoreManifest(destination);
		const again = await Effect.runPromise(
			importRegisteredProjectStores(harness.configDir, projects, {
				now: () => completedAt,
			}),
		);
		expect(again.every((result) => result.outcome === "skipped")).toBe(true);
		expect(storeTableCounts(destination)).toEqual(counts);
		expect(daemonStoreManifest(destination)).toEqual(beforeSkippedImport);
		evidence.idempotency = true;
		const beforeRestart = daemonStoreManifest(destination);
		await harness.restart({ skipBrowserProbe: true });
		await harness.terminate();
		const afterRestart = daemonStoreManifest(destination);
		const newPublications =
			(afterRestart.tables["session_git_published"]?.length ?? 0) -
			(beforeRestart.tables["session_git_published"]?.length ?? 0);
		expect(newPublications).toBeGreaterThanOrEqual(0);
		expect(
			Number(afterRestart.tables["read_model_counter"]?.[0]?.["value"]),
		).toBe(
			Number(beforeRestart.tables["read_model_counter"]?.[0]?.["value"]) +
				newPublications,
		);
		const [beforeStableTables, afterStableTables] = [
			beforeRestart,
			afterRestart,
		].map(({ tables }) =>
			Object.fromEntries(
				Object.entries(tables).filter(
					([table]) =>
						![
							"sessions",
							"session_sidebar",
							"session_git_published",
							"read_model_counter",
						].includes(table),
				),
			),
		);
		expect(afterStableTables).toEqual(beforeStableTables);
		evidence.projects = assertLiveHistories();
		for (const { sourcePath } of projects)
			for (const suffix of ["", "-wal", "-shm"])
				expect(existsSync(`${sourcePath}${suffix}`)).toBe(false);
		evidence.passed = true;

		// Keep the independent copied source byte-for-byte identical to B.
		// Transcript fixtures have no store-wide runner cursor to collide.
		const originalBackup = results.find(
			(result) => result.projectId === savedSlug,
		)?.backup;
		if (!originalBackup) throw new Error("Project B has no backup");
		expect(storeTableCounts(originalBackup)["claude_runner_cursors"] ?? 0).toBe(
			0,
		);
		const copied = {
			projectId: "copied-project",
			sourcePath: join(realpathSync(harness.configDir), "copied-project.db"),
		};
		for (const suffix of ["-wal", "-shm", "-journal", ""])
			if (existsSync(`${originalBackup}${suffix}`))
				copyFileSync(
					`${originalBackup}${suffix}`,
					`${copied.sourcePath}${suffix}`,
				);
		expect(sourceChecksums(copied.sourcePath)).toEqual(checksums[1]);
		const garbage = {
			projectId: "garbage-project",
			sourcePath: join(realpathSync(harness.configDir), "garbage-project.db"),
		};
		writeFileSync(garbage.sourcePath, "not a SQLite store\n");
		const registered = [...projects, copied, garbage];
		const shared = (before[1]?.tables["sessions"] ?? [])
			.map((row) => String(row["id"]))
			.sort();
		expect(shared).toContain(sessionB);
		const normalize = (value: string) => {
			let normalized = value
				.replaceAll(realpathSync(harness.configDir), "<config>")
				.replaceAll(harness.configDir, "<config>")
				.replace(/\.imported-\d+/g, ".imported-<timestamp>")
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>");
			for (const [index, id] of shared.entries())
				normalized = normalized.replaceAll(id, `<shared-session-${index + 1}>`);
			return normalized;
		};
		const outcome = (result: ProjectStoreImportResult) => ({
			projectId: result.projectId,
			outcome: result.outcome,
			importedEvents: result.importedEvents ?? null,
			sharedSessions: (result.sharedSessions ?? []).map(normalize),
			error: result.error
				? { kind: result.error.kind, message: normalize(result.error.message) }
				: null,
			backup: result.backup
				? normalize(relative(realpathSync(harness.configDir), result.backup))
				: null,
			backupError: result.backupError
				? normalize(result.backupError.message)
				: null,
		});
		// Raw hashes cover live session ids, so the artifact names each distinct
		// manifest by first appearance to keep its bytes repeatable.
		const hashes: string[] = [];
		for (const run of [0, 1]) {
			const imported = await Effect.runPromise(
				importRegisteredProjectStores(harness.configDir, registered, {
					now: () => completedAt,
				}),
			);
			failures.runs.push({
				outcomes: imported.map(outcome),
				report: normalize(
					readFileSync(
						join(harness.configDir, "daemon-store-import-report.txt"),
						"utf8",
					),
				),
				manifestHash: (() => {
					const hash = daemonStoreManifest(destination).hash;
					if (!hashes.includes(hash)) hashes.push(hash);
					return `<manifest-${hashes.indexOf(hash) + 1}>`;
				})(),
			});
			expect(imported.slice(0, 2).map((result) => result.outcome)).toEqual([
				"skipped",
				"skipped",
			]);
			expect(imported[2]).toMatchObject(
				run === 0
					? { outcome: "imported", importedEvents: 0, sharedSessions: shared }
					: { outcome: "skipped" },
			);
			expect(imported[3]).toMatchObject({
				outcome: "failed",
				error: { kind: "corrupt" },
			});
			expect(existsSync(copied.sourcePath)).toBe(false);
			expect(
				sourceChecksums(`${copied.sourcePath}.imported-${completedAt}`),
			).toEqual(checksums[1]);
			expect(readFileSync(garbage.sourcePath, "utf8")).toBe(
				"not a SQLite store\n",
			);
		}
		expect(hashes).toHaveLength(1);
		failures.passed = true;
	} finally {
		writeImportArtifact(artifact, evidence);
		writeImportArtifact(failureArtifact, failures);
		await testInfo.attach("daemon-store-import", {
			path: artifact,
			contentType: "application/json",
		});
		await testInfo.attach("daemon-store-import-failures", {
			path: failureArtifact,
			contentType: "application/json",
		});
	}
});
