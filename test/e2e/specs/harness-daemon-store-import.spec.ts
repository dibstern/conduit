// This must run outside the socket-restricted sandbox. The real daemon writes
// both histories; only after shutdown does the test process run the import.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { importRegisteredProjectStores } from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
	daemonStoreAssertions,
	type ProjectManifest,
	projectManifest,
	sourceChecksums,
	storeImportPosition,
	storeTableCounts,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const artifact = "test-results/82tn4-daemon-store-import.json";
const initial = {
	projects: [],
	sourceChecksums: false,
	idempotency: false,
	invariants: [],
	passed: false,
};

test.beforeEach(() => writeImportArtifact(artifact, initial));

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
		const sessionB = await driverB.createSession("Import project B");
		const a = await driverA.send(sessionA, "import-history-a");
		const b = await driverB.send(sessionB, "import-history-b");
		expect(a.done["status"]).toBe("idle");
		expect(b.done["status"]).toBe("idle");
		await harness.terminate();

		const projects = ["process-test", savedSlug].map((projectId) => ({
			projectId,
			sourcePath: harness.projectStorePath(projectId),
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
			importRegisteredProjectStores(harness.configDir, projects),
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
		evidence.sourceChecksums = projects.every(
			(project, index) =>
				JSON.stringify(sourceChecksums(project.sourcePath)) ===
				JSON.stringify(checksums[index]),
		);
		expect(evidence.sourceChecksums).toBe(true);
		const counts = storeTableCounts(destination);
		const again = await Effect.runPromise(
			importRegisteredProjectStores(harness.configDir, projects),
		);
		expect(again.every((result) => result.outcome === "skipped")).toBe(true);
		expect(storeTableCounts(destination)).toEqual(counts);
		for (const [index, project] of projects.entries())
			expect(
				projectManifest(destination, project.projectId, before[index]).tables,
			).toEqual(before[index]?.tables);
		evidence.idempotency = true;
		evidence.passed = true;
	} finally {
		writeImportArtifact(artifact, evidence);
		await testInfo.attach("daemon-store-import", {
			path: artifact,
			contentType: "application/json",
		});
	}
});
