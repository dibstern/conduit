// This must run outside the socket-restricted sandbox. The real daemon writes
// both histories; only after shutdown does the test process run the import.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import {
	importRegisteredProjectStores,
	type ProjectStoreImportResult,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
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

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

test.beforeEach(() => {
	writeImportArtifact(artifact, initial);
	writeImportArtifact(failureArtifact, { runs: [], passed: false });
});

test("imports both daemon-written project histories after shutdown", async ({
	harness,
}, testInfo) => {
	const evidence: {
		projects: {
			before: { rows: ProjectManifest["rowCounts"]; hash: string };
			after: { rows: ProjectManifest["rowCounts"]; hash: string };
			equal: boolean;
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
		const driverA = await harness.connect();
		const sessionA = await driverA.createSession("Import project A");
		const folderB = join(harness.root, "project-b");
		mkdirSync(folderB);
		const { savedSlug } = await Effect.runPromise(
			driverA.rpc.SaveProject({ title: "Project B", folders: [folderB] }),
		);
		if (!savedSlug) throw new Error("Project B has no slug");
		const driverB = await harness.connect(undefined, undefined, savedSlug);
		await driverB.startInstance("opencode");
		const sessionB = await driverB.createSession(
			"Import project B",
			"opencode",
			"opencode",
		);
		const a = await driverA.send(sessionA, "import-history-a");
		const b = await driverB.send(
			sessionB,
			"Hello, reply with just the word pong",
		);
		expect(a.done["status"]).toBe("idle");
		expect(b.done["status"]).toBe("idle");
		await harness.terminate();

		const projects = ["process-test", savedSlug].map((projectId) => ({
			projectId,
			sourcePath: realpathSync(harness.projectStorePath(projectId)),
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
		const results = await Effect.runPromise(
			importRegisteredProjectStores(harness.configDir, projects, {
				now: () => completedAt,
			}),
		);
		expect(results.map((result) => result.outcome).sort()).toEqual([
			"imported",
			"seeded",
		]);
		const destination = daemonStorePath(harness.configDir);
		const seedIndex = projects.findIndex((project) =>
			results.some(
				(result) =>
					result.projectId === project.projectId && result.outcome === "seeded",
			),
		);
		const position = positions[seedIndex];
		if (!position) throw new Error("Missing pre-import seed position");
		for (const result of results.filter(
			(result) => result.outcome === "imported",
		)) {
			const assertions = daemonStoreAssertions(destination, {
				projectId: result.projectId,
				before: position,
			});
			evidence.invariants.push(assertions);
			for (const [name, passed] of Object.entries(assertions))
				expect(passed, name).toBe(true);
		}
		for (const [index, project] of projects.entries()) {
			const prior = before[index];
			if (!prior) throw new Error("Missing source manifest");
			const after = projectManifest(destination, project.projectId, prior);
			evidence.projects.push({
				before: { rows: prior.rowCounts, hash: prior.hash },
				after: { rows: after.rowCounts, hash: after.hash },
				equal: after.hash === prior.hash,
			});
			expect(after.tables).toEqual(prior.tables);
		}
		evidence.sourceChecksums = projects.every((project, index) => {
			const backup = results.find(
				(result) => result.projectId === project.projectId,
			)?.backup;
			expect(existsSync(project.sourcePath)).toBe(false);
			expect(backup).toBe(`${project.sourcePath}.imported-${completedAt}`);
			return (
				backup !== undefined &&
				JSON.stringify(sourceChecksums(backup)) ===
					JSON.stringify(checksums[index])
			);
		});
		expect(evidence.sourceChecksums).toBe(true);
		const counts = storeTableCounts(destination);
		const again = await Effect.runPromise(
			importRegisteredProjectStores(harness.configDir, projects, {
				now: () => completedAt,
			}),
		);
		expect(again.every((result) => result.outcome === "skipped")).toBe(true);
		expect(storeTableCounts(destination)).toEqual(counts);
		for (const [index, project] of projects.entries())
			expect(
				projectManifest(destination, project.projectId, before[index]).tables,
			).toEqual(before[index]?.tables);
		evidence.idempotency = true;
		evidence.passed = true;

		// Keep the copied source byte-for-byte identical to a daemon-written
		// project. OpenCode has no store-wide Claude runner cursor to collide.
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
				manifestHash: daemonStoreManifest(destination).hash,
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
		expect(failures.runs[1]?.manifestHash).toBe(failures.runs[0]?.manifestHash);
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
