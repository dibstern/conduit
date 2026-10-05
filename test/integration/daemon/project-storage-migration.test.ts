import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RemoveProject,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	projectStorageDir,
	readProjectStorageOwner,
} from "../../../src/lib/persistence/project-storage.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("project storage migration through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	const storageDb = (fixture: ProcessHarness, slug = "process-test") =>
		join(projectStorageDir(fixture.configDir, slug), "events.db");
	const legacyDb = (fixture: ProcessHarness) =>
		join(fixture.projectDir, ".conduit", "events.db");
	const socket = (fixture: ProcessHarness) =>
		join(fixture.configDir, "relay.sock");

	function stageLegacyStore(fixture: ProcessHarness): void {
		const current = storageDb(fixture);
		const legacy = legacyDb(fixture);
		mkdirSync(join(fixture.projectDir, ".conduit"), { recursive: true });
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(`${current}${suffix}`))
				renameSync(`${current}${suffix}`, `${legacy}${suffix}`);
		}
		expect(existsSync(legacy)).toBe(true);
		expect(existsSync(current)).toBe(false);
	}

	afterEach(async () => {
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/usg5-4-${scenario}.json`,
				JSON.stringify(
					{
						...evidence,
						generations: harness.generations,
						remainingRunnerPids: harness.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
			scenario = "setup";
			evidence = {};
		}
	});

	it("moves legacy history before serving it and archives the original", async () => {
		scenario = "migration";
		harness = await ProcessHarness.start();
		const before = await harness.connect();
		const sessionId = await before.createSession("Legacy history");
		await before.send(sessionId, "legacy-history");
		const history = await before.history(sessionId);
		await harness.terminate();
		stageLegacyStore(harness);
		// Write the project the way a pre-folders daemon did: directory, no folders.
		const configFile = join(harness.configDir, "daemon.json");
		const config: { projects: { folders: string[] }[] } = JSON.parse(
			readFileSync(configFile, "utf8"),
		);
		writeFileSync(
			configFile,
			JSON.stringify({
				...config,
				projects: config.projects.map(({ folders, ...project }) => ({
					...project,
					directory: folders[0],
				})),
			}),
		);

		await harness.restart();
		const after = await harness.connect(sessionId);
		expect(await after.history(sessionId)).toEqual(history);
		expect(existsSync(storageDb(harness))).toBe(true);
		expect(existsSync(legacyDb(harness))).toBe(false);
		expect(existsSync(`${legacyDb(harness)}.migrated`)).toBe(true);
		expect(readProjectStorageOwner(harness.configDir, "process-test")).toBe(
			harness.projectDir,
		);
		const migratedProjects: Record<string, unknown>[] = JSON.parse(
			readFileSync(configFile, "utf8"),
		).projects;
		expect(migratedProjects).toEqual([
			expect.objectContaining({
				slug: "process-test",
				folders: [harness.projectDir],
			}),
		]);
		expect(migratedProjects[0]).not.toHaveProperty("directory");
		// The log entry spans lines, so match from its message to the project slug.
		const migrationLog = harness.logTail.match(
			/Migrated project history[\s\S]*?process-test/g,
		);
		expect(migrationLog).toHaveLength(1);
		evidence = {
			sessionId,
			history,
			archived: true,
			owner: harness.projectDir,
			migratedProjects,
			migrationLog,
		};
	}, 60_000);

	it("serves legacy history after copy failure and retries on restart", async () => {
		scenario = "failure-retry";
		harness = await ProcessHarness.start();
		const before = await harness.connect();
		const sessionId = await before.createSession("Retry history");
		await before.send(sessionId, "retry-history");
		const history = await before.history(sessionId);
		await harness.terminate();
		stageLegacyStore(harness);
		const ownerFile = join(
			projectStorageDir(harness.configDir, "process-test"),
			"project.json",
		);
		rmSync(ownerFile);
		mkdirSync(ownerFile);

		await harness.restart();
		const fallback = await harness.connect(sessionId);
		expect(await fallback.history(sessionId)).toEqual(history);
		expect(existsSync(storageDb(harness))).toBe(false);
		expect(existsSync(legacyDb(harness))).toBe(true);
		await harness.terminate();
		rmSync(ownerFile, { recursive: true });
		await harness.restart();
		const recovered = await harness.connect(sessionId);
		expect(await recovered.history(sessionId)).toEqual(history);
		expect(existsSync(storageDb(harness))).toBe(true);
		expect(existsSync(`${legacyDb(harness)}.migrated`)).toBe(true);
		evidence = { sessionId, fallbackRead: true, retryMigrated: true };
	}, 60_000);

	it("adopts a preserved Claude runner against migrated history", async () => {
		scenario = "runner-adoption";
		harness = await ProcessHarness.start({
			restartProof: true,
			holdRunnerAck: true,
		});
		const before = await harness.connect();
		const sessionId = await before.createSession("Runner migration");
		const pending = before
			.send(sessionId, "migration-replay")
			.catch(() => undefined);
		await before.waitFor((message) => message["type"] === "delta");
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing preserved runner");
		await harness.kill();
		await pending;
		stageLegacyStore(harness);

		await harness.restart();
		const after = await harness.connect(sessionId);
		await vi.waitFor(
			async () => {
				const history = await after.history(sessionId);
				expect(history.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(history[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
					responseChunks("migration-replay").join(""),
				);
			},
			{ timeout: 15_000 },
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
		).toMatchObject({ pid: runner.pid });
		expect(existsSync(storageDb(harness))).toBe(true);
		expect(existsSync(`${legacyDb(harness)}.migrated`)).toBe(true);
		evidence = { sessionId, preservedRunnerPid: runner.pid, migrated: true };
	}, 60_000);

	it("keeps removed history and reuses it when the same folder returns", async () => {
		scenario = "reuse";
		harness = await ProcessHarness.start();
		const directory = join(harness.root, "reusable-project");
		mkdirSync(directory);
		const added = await sendRpcRequest(
			socket(harness),
			new SaveProject({ folders: [directory] }),
		);
		const slug = added.savedSlug;
		if (!slug) throw new Error("SaveProject returned no slug");
		const before = await harness.connect(undefined, undefined, slug);
		const sessionId = await before.createSession("Retained history");
		await before.send(sessionId, "retained-history");
		const history = await before.history(sessionId);
		expect(existsSync(join(directory, ".conduit"))).toBe(false);
		await sendRpcRequest(socket(harness), new RemoveProject({ slug }));
		expect(existsSync(storageDb(harness, slug))).toBe(true);
		const readded = await sendRpcRequest(
			socket(harness),
			new SaveProject({ folders: [directory] }),
		);
		expect(readded.savedSlug).toBe(slug);
		const after = await harness.connect(sessionId, undefined, slug);
		expect(await after.history(sessionId)).toEqual(history);
		expect(existsSync(join(directory, ".conduit"))).toBe(false);
		evidence = { directory, slug, sessionId, historyRetained: true };
	}, 60_000);

	it("reserves a removed project's slug for another folder with the same name", async () => {
		scenario = "same-name-isolation";
		harness = await ProcessHarness.start();
		const first = join(harness.root, "first", "shared");
		const second = join(harness.root, "second", "shared");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });
		const firstProject = await sendRpcRequest(
			socket(harness),
			new SaveProject({ folders: [first] }),
		);
		const firstSlug = firstProject.savedSlug;
		if (!firstSlug) throw new Error("First SaveProject returned no slug");
		const browser = await harness.connect(undefined, undefined, firstSlug);
		const sessionId = await browser.createSession("Private history");
		await browser.send(sessionId, "first-folder-only");
		await sendRpcRequest(
			socket(harness),
			new RemoveProject({ slug: firstSlug }),
		);

		const secondProject = await sendRpcRequest(
			socket(harness),
			new SaveProject({ folders: [second] }),
		);
		const secondSlug = secondProject.savedSlug;
		if (!secondSlug) throw new Error("Second SaveProject returned no slug");
		expect(secondSlug).not.toBe(firstSlug);
		expect(readProjectStorageOwner(harness.configDir, firstSlug)).toBe(first);
		const other = await harness.connect(undefined, undefined, secondSlug);
		// The WS opens before the new project's relay finishes starting and writes its owner.
		const { configDir } = harness;
		await vi.waitFor(
			() => expect(readProjectStorageOwner(configDir, secondSlug)).toBe(second),
			{ timeout: 15_000 },
		);
		expect(await other.history(sessionId)).toEqual([]);
		expect(existsSync(join(second, ".conduit"))).toBe(false);
		evidence = {
			first,
			second,
			firstSlug,
			secondSlug,
			originalSessionId: sessionId,
			isolated: true,
		};
	}, 60_000);
});
