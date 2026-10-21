import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	projectStorageDir,
	readProjectStorageOwner,
} from "../../../src/lib/persistence/project-storage.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("project storage migration through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	const storageDb = (fixture: ProcessHarness) => fixture.daemonStorePath();
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

	it("moves legacy history, reclaims migrated free pages, and archives the original", async () => {
		scenario = "migration";
		harness = await ProcessHarness.start();
		const before = await harness.connect();
		const sessionId = await before.createSession("Legacy history");
		await before.send(sessionId, "legacy-history");
		const history = await before.history(sessionId);
		await harness.terminate();
		stageLegacyStore(harness);
		const bloated = new Database(legacyDb(harness));
		try {
			const delta = bloated
				.prepare<
					[string],
					{ data: string; project_id: string; created_at: number }
				>(
					`SELECT data, project_id, created_at FROM events
					WHERE session_id = ? AND type = 'text.delta' ORDER BY sequence LIMIT 1`,
				)
				.get(sessionId);
			const latest = bloated
				.prepare<[string], { version: number }>(
					"SELECT MAX(stream_version) AS version FROM events WHERE session_id = ?",
				)
				.get(sessionId);
			if (!delta || !latest) throw new Error("Missing legacy text fixture");
			const deltaData: Record<string, unknown> = JSON.parse(delta.data);
			const data = JSON.stringify({
				...deltaData,
				text: "",
				padding: "x".repeat(8192),
			});
			bloated.transaction(() => {
				bloated.exec(
					"DELETE FROM effect_sql_migrations WHERE migration_id = 58",
				);
				const insert = bloated.prepare(`INSERT INTO events
					(event_id, session_id, stream_version, type, data, created_at, project_id, provider)
					VALUES (?, ?, ?, 'text.delta', ?, ?, ?, 'claude')`);
				for (let index = 0; index < 80; index++) {
					insert.run(
						`reclaim-fixture-${index}`,
						sessionId,
						latest.version + index + 1,
						data,
						delta.created_at,
						delta.project_id,
					);
				}
			})();
		} finally {
			bloated.close();
		}
		const beforeBytes = statSync(legacyDb(harness)).size;
		// Write the project the way a pre-folders daemon did: directory, no folders.
		const configFile = join(harness.configDir, "daemon.json");
		const config: { projects: { folders: string[] }[] } = JSON.parse(
			readFileSync(configFile, "utf8"),
		);
		writeFileSync(
			configFile,
			JSON.stringify({
				...config,
				configVersion: undefined,
				worktreeCleanup: undefined,
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
		expect(existsSync(harness.legacyProjectStorePath())).toBe(false);
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
		expect(harness.logTail).toContain("Reclaimed event store space");
		const afterBytes = statSync(storageDb(harness)).size;
		expect(afterBytes).toBeLessThan(beforeBytes);
		const compacted = new Database(storageDb(harness), { readonly: true });
		try {
			expect(compacted.pragma("quick_check", { simple: true })).toBe("ok");
			expect(
				compacted
					.prepare<[], { count: number }>(
						"SELECT COUNT(*) AS count FROM events WHERE project_id = 'process-test' AND event_id LIKE 'reclaim-fixture-%'",
					)
					.get()?.count,
			).toBe(1);
			expect(
				compacted
					.prepare<[], { event_id: string }>(
						"SELECT event_id FROM events WHERE project_id = 'process-test' AND event_id LIKE 'reclaim-fixture-%'",
					)
					.get()?.event_id,
			).toBe("reclaim-fixture-79");
		} finally {
			compacted.close();
		}
		evidence = {
			sessionId,
			history,
			archived: true,
			owner: harness.projectDir,
			migratedProjects,
			migrationLog,
			beforeBytes,
			afterBytes,
			quickCheck: "ok",
			redundantEventsRemoved: 79,
		};
	}, 60_000);

	it("blocks legacy history after copy failure and retries on restart", async () => {
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

		await harness.restart({ skipBrowserProbe: true });
		const blocked = await sendRpcRequest(socket(harness), {
			_tag: "ListDaemonSessions",
			scope: "process-test",
		});
		expect(blocked.sessions).toEqual([]);
		expect(blocked.availability).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					projectSlug: "process-test",
					error: expect.stringContaining("Legacy history migration failed"),
				}),
			]),
		);
		expect(existsSync(harness.legacyProjectStorePath())).toBe(false);
		expect(existsSync(legacyDb(harness))).toBe(true);
		await harness.terminate();
		rmSync(ownerFile, { recursive: true });
		await harness.restart();
		const recovered = await harness.connect(sessionId);
		expect(await recovered.history(sessionId)).toEqual(history);
		expect(existsSync(storageDb(harness))).toBe(true);
		expect(existsSync(`${legacyDb(harness)}.migrated`)).toBe(true);
		evidence = {
			sessionId,
			unavailableUntilRestart: true,
			retryMigrated: true,
		};
	}, 60_000);

	it("adopts a preserved Claude runner against migrated history", async () => {
		scenario = "runner-adoption";
		harness = ProcessHarness.create({
			restartProof: true,
			holdRunnerAck: true,
		});
		await harness.restart({ runnerStartupTimeoutMs: 25_000 });
		const before = await harness.connect();
		const sessionId = await before.createSession("Runner migration");
		// The restart fixture lets IPC disconnect settle between chunk marks.
		const prompt = "restart-migration-replay";
		const pending = before
			.send(sessionId, prompt, 30_000)
			.catch(() => undefined);
		await before.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				(message["parts"] as HistoryMessage["parts"])?.some(
					(part) => part.type === "text" && Boolean(part.text),
				) === true,
			0,
			30_000,
		);
		const runner = await harness.waitForMark(
			(mark) => mark.kind === "runner-started",
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Missing preserved runner");
		const pendingStore = new Database(storageDb(harness), { readonly: true });
		try {
			expect(
				pendingStore
					.prepare<[string], { status: string }>(
						"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
					)
					.all(sessionId)
					.map((command) => command.status),
			).toEqual(["running"]);
		} finally {
			pendingStore.close();
		}
		await harness.kill();
		await pending;
		await vi.waitFor(() =>
			expect(statSync(`${runner.socketPath}.spool`).size).toBeGreaterThan(0),
		);
		const spooledBytes = statSync(`${runner.socketPath}.spool`).size;
		stageLegacyStore(harness);
		evidence = { sessionId, preservedRunnerPid: runner.pid, spooledBytes };

		await harness.restart();
		const after = await harness.connect(sessionId);
		await vi.waitFor(
			async () => {
				const history = await after.history(sessionId);
				evidence = {
					...evidence,
					history,
					daemonLog: harness?.logTail,
				};
				expect(history.map((message) => message.role)).toEqual([
					"user",
					"assistant",
				]);
				expect(history[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
					responseChunks(prompt).join(""),
				);
			},
			{ timeout: 15_000 },
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
		).toMatchObject({ pid: runner.pid });
		expect(existsSync(storageDb(harness))).toBe(true);
		expect(existsSync(`${legacyDb(harness)}.migrated`)).toBe(true);
		evidence = { ...evidence, migrated: true };
	}, 90_000);

	it("keeps removed history and reuses it when the same folder returns", async () => {
		scenario = "reuse";
		harness = await ProcessHarness.start();
		const directory = join(harness.root, "reusable-project");
		mkdirSync(directory);
		const added = await sendRpcRequest(socket(harness), {
			_tag: "SaveProject",
			folders: [directory],
		});
		const slug = added.savedSlug;
		if (!slug) throw new Error("SaveProject returned no slug");
		const before = await harness.connect(undefined, undefined, slug);
		const sessionId = await before.createSession("Retained history");
		await before.send(sessionId, "retained-history");
		const history = await before.history(sessionId);
		expect(existsSync(join(directory, ".conduit"))).toBe(false);
		await sendRpcRequest(socket(harness), { _tag: "RemoveProject", slug });
		expect(existsSync(storageDb(harness))).toBe(true);
		const readded = await sendRpcRequest(socket(harness), {
			_tag: "SaveProject",
			folders: [directory],
		});
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
		const firstProject = await sendRpcRequest(socket(harness), {
			_tag: "SaveProject",
			folders: [first],
		});
		const firstSlug = firstProject.savedSlug;
		if (!firstSlug) throw new Error("First SaveProject returned no slug");
		const browser = await harness.connect(undefined, undefined, firstSlug);
		const sessionId = await browser.createSession("Private history");
		await browser.send(sessionId, "first-folder-only");
		await sendRpcRequest(socket(harness), {
			_tag: "RemoveProject",
			slug: firstSlug,
		});

		const secondProject = await sendRpcRequest(socket(harness), {
			_tag: "SaveProject",
			folders: [second],
		});
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
		await expect(other.history(sessionId)).rejects.toMatchObject({
			code: "unknown-session",
		});
		const isolated = await sendRpcRequest(socket(harness), {
			_tag: "ListDaemonSessions",
			scope: secondSlug,
		});
		expect(isolated.sessions).toEqual([]);
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
