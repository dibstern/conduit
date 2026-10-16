// Run outside the socket-restricted sandbox. Legacy history is seeded before
// the first daemon start; imports run through the real startup graph.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	watch,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { isProcessAlive } from "../../../src/lib/instance/managed-opencode-process.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
	createLegacyDaemonFixture,
	daemonStoreManifest,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const artifact = "test-results/82tn6-shared-store.json";
const initial = {
	importReport: null as string | null,
	projects: [] as { project: string; outcome: string; backup: string }[],
	coldLinks: [] as { project: string; transcriptRendered: boolean }[],
	list: [] as { project: string; ownsSession: boolean }[],
	prompt: {
		completed: false,
		responseRendered: false,
		newRowsOwnedByB: false,
		secondUserMessage: false,
	},
	// Live hashes carry run-specific payloads, so only their equality is stable.
	coldStartImportedLegacySources: false,
	removedRelayDisposed: false,
	removedHistoryRetained: false,
	postRestartSessionOwnedByB: false,
	storeUnchangedByRestart: false,
	projectEventStoreFiles: [] as string[],
	passed: false,
};

test.use({ startHarness: false });
test.beforeEach(({ isMobile }) => {
	test.skip(isMobile, "The daemon store cutover is checked on desktop");
});

test("the daemon imports project histories and keeps using its shared store across restarts", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	writeImportArtifact(artifact, initial);
	const evidence: typeof initial = {
		...initial,
		projects: [],
		coldLinks: [],
		list: [],
		prompt: { ...initial.prompt },
		projectEventStoreFiles: [],
	};
	const foundSources = new Set<string>();
	const sourceWatchers: ReturnType<typeof watch>[] = [];
	const legacySources = new Set<string>();
	const destination = daemonStorePath(harness.configDir);
	const sources = () => {
		const projects = join(harness.configDir, "projects");
		return [
			...readdirSync(projects, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => harness.legacyProjectStorePath(entry.name)),
			...legacySources,
		]
			.flatMap((path) =>
				["", "-wal", "-shm"].map((suffix) => `${path}${suffix}`),
			)
			.filter(existsSync)
			.map((path) => relative(harness.configDir, path))
			.sort();
	};
	const assertNoSources = () => {
		for (const path of sources()) foundSources.add(path);
		expect([...foundSources]).toEqual([]);
	};
	const readStore = <A>(read: (db: DatabaseSync) => A): A => {
		const db = new DatabaseSync(destination, { readOnly: true });
		try {
			return read(db);
		} finally {
			db.close();
		}
	};
	try {
		const slugA = "process-test";
		const slugB = "project-b";
		const sessionA = "ses_shared_store_a";
		const sessionB = "ses_shared_store_b";
		const folderB = join(harness.root, "project-b");
		legacySources.add(join(harness.projectDir, ".conduit", "events.db"));
		legacySources.add(join(folderB, ".conduit", "events.db"));
		const promptA = "shared-store-history-a";
		const promptB = "Hello, reply with just the word pong";
		await createLegacyDaemonFixture(harness.configDir, [
			{
				projectId: slugA,
				folder: harness.projectDir,
				sessionId: sessionA,
				prompt: promptA,
				reply: `done(${promptA})`,
			},
			{
				projectId: slugB,
				folder: folderB,
				sessionId: sessionB,
				prompt: promptB,
				reply: "pong",
				legacy: true,
			},
		]);
		expect(existsSync(destination)).toBe(false);
		expect(existsSync(harness.legacyProjectStorePath(slugA))).toBe(true);
		expect(existsSync(join(folderB, ".conduit", "events.db"))).toBe(true);
		await harness.restart();
		evidence.coldStartImportedLegacySources = true;
		expect(existsSync(destination)).toBe(true);
		assertNoSources();

		const normalize = (value: string) => {
			let result = value;
			for (const path of [realpathSync(harness.configDir), harness.configDir])
				result = result.replaceAll(path, "<config>");
			for (const path of [realpathSync(harness.root), harness.root])
				result = result.replaceAll(path, "<root>");
			return result
				.replaceAll(sessionA, "<session-a>")
				.replaceAll(sessionB, "<session-b>")
				.replaceAll(slugA, "<project-a>")
				.replaceAll(slugB, "<project-b>")
				.replace(/\.imported-\d+/g, ".imported-<timestamp>")
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>");
		};
		const report = readFileSync(
			join(harness.configDir, "daemon-store-import-report.txt"),
			"utf8",
		);
		evidence.importReport = normalize(report);
		for (const [project, slug] of [
			["A", slugA],
			["B", slugB],
		] as const) {
			const line = report
				.split("\n")
				.find((item) => item.startsWith(`${slug}: `));
			const outcome = line?.slice(slug.length + 2).split(",")[0];
			expect(outcome).toMatch(/^(seeded|imported)$/);
			const source = harness.legacyProjectStorePath(slug);
			const backups = readdirSync(dirname(source)).filter((name) =>
				/^events\.db\.imported-\d+$/.test(name),
			);
			expect(backups).toHaveLength(1);
			const backup = backups[0];
			if (!outcome || !backup)
				throw new Error("Missing import outcome or backup");
			expect(line).toContain(`backup ${join(dirname(source), backup)}`);
			evidence.projects.push({
				project,
				outcome,
				backup: normalize(
					relative(harness.configDir, join(dirname(source), backup)),
				),
			});
			// Sources no longer exist. Observe their directory throughout the live
			// reads, prompt, shutdown and restart to catch even transient recreation.
			sourceWatchers.push(
				watch(dirname(source), (_event, filename) => {
					if (/^events\.db(?:-wal|-shm)?$/.test(String(filename)))
						foundSources.add(
							relative(
								harness.configDir,
								join(dirname(source), String(filename)),
							),
						);
				}),
			);
		}
		for (const source of [...legacySources].filter((source) =>
			existsSync(dirname(source)),
		))
			sourceWatchers.push(
				watch(dirname(source), (_event, filename) => {
					if (/^events\.db(?:-wal|-shm)?$/.test(String(filename)))
						foundSources.add(
							relative(
								harness.configDir,
								join(dirname(source), String(filename)),
							),
						);
				}),
			);
		expect(evidence.projects.map(({ outcome }) => outcome).sort()).toEqual([
			"imported",
			"seeded",
		]);

		for (const [project, sessionId, prompt, reply] of [
			["A", sessionA, promptA, `done(${promptA})`],
			["B", sessionB, promptB, "pong"],
		] as const) {
			// A separate browser context has no project selection or client cache.
			const context = await browser.newContext();
			try {
				const page = await context.newPage();
				await new AppPage(page).goto(`${harness.baseUrl}/s/${sessionId}`);
				await expect(page.locator("#messages")).toContainText(prompt);
				await expect(page.locator("#messages")).toContainText(reply);
				evidence.coldLinks.push({ project, transcriptRendered: true });
			} finally {
				await context.close();
			}
			assertNoSources();
		}

		const reader = await harness.connect(undefined, undefined, slugA);
		const listed = await Effect.runPromise(
			reader.rpc.ListDaemonSessions({ projectSlug: slugA }),
		);
		for (const [project, slug, sessionId] of [
			["A", slugA, sessionA],
			["B", slugB, sessionB],
		] as const) {
			const rows = listed.sessions.filter(
				(session) => session.id === sessionId,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.projectSlug).toBe(slug);
			evidence.list.push({ project, ownsSession: true });
		}
		assertNoSources();

		const beforePrompt = readStore((db) =>
			Number(
				db.prepare("SELECT max(sequence) AS sequence FROM events").get()?.[
					"sequence"
				],
			),
		);
		const resumedB = await harness.connect(undefined, undefined, slugB);
		const secondPrompt = "Reply with just the word 'pong'. Nothing else.";
		const response = await resumedB.send(sessionB, secondPrompt);
		expect(response.done["status"]).toBe("idle");
		evidence.prompt.completed = true;
		expect(response.chunks.join("")).toContain("pong");
		const promptContext = await browser.newContext();
		try {
			const page = await promptContext.newPage();
			await new AppPage(page).goto(`${harness.baseUrl}/s/${sessionB}`);
			await expect(page.locator("#messages")).toContainText(secondPrompt);
			await expect(page.locator("#messages")).toContainText("pong");
			evidence.prompt.responseRendered = true;
		} finally {
			await promptContext.close();
		}
		readStore((db) => {
			const events = db
				.prepare(
					"SELECT project_id FROM events WHERE sequence > ? AND session_id = ?",
				)
				.all(beforePrompt, sessionB);
			expect(events.length).toBeGreaterThan(0);
			expect(events.every((event) => event["project_id"] === slugB)).toBe(true);
			evidence.prompt.newRowsOwnedByB = true;
			expect(
				Number(
					db
						.prepare(
							"SELECT count(*) AS count FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ? AND s.project_id = ? AND m.role = 'user'",
						)
						.get(sessionB, slugB)?.["count"],
				),
			).toBe(2);
			evidence.prompt.secondUserMessage = true;
		});
		assertNoSources();

		await harness.terminate();
		await harness.restart();
		assertNoSources();
		const afterRestartB = await harness.connect(undefined, undefined, slugB);
		const createdAfterRestart = await afterRestartB.createSession(
			"Created after restart",
		);
		readStore((db) => {
			expect(
				db
					.prepare("SELECT project_id FROM sessions WHERE id = ?")
					.get(createdAfterRestart)?.["project_id"],
			).toBe(slugB);
		});
		evidence.postRestartSessionOwnedByB = true;
		const removedA = await harness.connect(undefined, undefined, slugA);
		expect(
			(await removedA.send(sessionA, "remove-project-relay-proof")).done[
				"status"
			],
		).toBe("idle");
		const aRunnerPids = harness
			.claudeOptions()
			.filter(
				({ pid, options }) =>
					harness.runnerPids().includes(pid) &&
					options["cwd"] === harness.projectDir &&
					options["maxTurns"] !== 0,
			)
			.map(({ pid }) => pid);
		expect(aRunnerPids.length).toBeGreaterThan(0);
		await Effect.runPromise(afterRestartB.rpc.RemoveProject({ slug: slugA }));
		await expect.poll(() => aRunnerPids.some(isProcessAlive)).toBe(false);
		await expect.poll(() => removedA.connected).toBe(false);
		await expect(
			harness.connect(undefined, undefined, slugA),
		).rejects.toThrow();
		evidence.removedRelayDisposed = true;
		readStore((db) => {
			expect(
				db
					.prepare("SELECT project_id FROM sessions WHERE id = ?")
					.get(sessionA)?.["project_id"],
			).toBe(slugA);
			expect(
				Number(
					db
						.prepare(
							"SELECT count(*) AS count FROM messages WHERE session_id = ?",
						)
						.get(sessionA)?.["count"],
				),
			).toBeGreaterThan(0);
		});
		evidence.removedHistoryRetained = true;
		// Removing A must not close the store borrowed by B.
		const afterRemoval = await afterRestartB.createSession(
			"Store survives relay disposal",
		);
		readStore((db) =>
			expect(
				db
					.prepare("SELECT project_id FROM sessions WHERE id = ?")
					.get(afterRemoval)?.["project_id"],
			).toBe(slugB),
		);
		assertNoSources();

		// Compare quiescent stores, with every SQLite reader closed before startup.
		await harness.terminate();
		assertNoSources();
		const before = daemonStoreManifest(destination);
		// A was removed; the default browser probe would attach to its old slug.
		await harness.restart({ skipBrowserProbe: true });
		assertNoSources();
		await harness.terminate();
		assertNoSources();
		const after = daemonStoreManifest(destination);
		// Each daemon start fences earlier runner writers with a fresh attachment id.
		const durable = ({ tables }: typeof before) => ({
			...tables,
			claude_runner_cursors: tables["claude_runner_cursors"]?.map(
				({ attachment_id: _attachment, ...row }) => row,
			),
		});
		expect(durable(after)).toEqual(durable(before));
		expect(after.hash).toBe(before.hash);
		evidence.storeUnchangedByRestart = true;
		evidence.passed = true;
	} finally {
		for (const watcher of sourceWatchers) watcher.close();
		evidence.projectEventStoreFiles = [...foundSources].sort();
		writeImportArtifact(artifact, evidence);
		await testInfo.attach(basename(artifact), {
			path: artifact,
			contentType: "application/json",
		});
	}
});

test("a failed import blocks its project until restart and retained history reappears on registration", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const unavailableArtifact =
		"test-results/82tn6-shared-store-unavailable.json";
	const evidence = {
		unavailable: {
			projectBReason: null as string | null,
			projectAAvailable: false,
			sessionListReportsReason: false,
			relayRefused: false,
			sessionCreationRefused: false,
			mainFolderChangeRefused: false,
			projectBRows: null as number | null,
			aTranscriptRendered: false,
		},
		repaired: {
			available: false,
			transcriptRendered: false,
			userMessagesBefore: null as number | null,
			userMessagesAfter: null as number | null,
		},
		retained: {
			hiddenFromSessionList: false,
			rowsImportedWithSlug: false,
			originalSlugReused: false,
			sessionListed: false,
			transcriptRendered: false,
		},
		passed: false,
	};
	writeImportArtifact(unavailableArtifact, evidence);
	const destination = daemonStorePath(harness.configDir);
	const readStore = <A>(filename: string, read: (db: DatabaseSync) => A): A => {
		const db = new DatabaseSync(filename, { readOnly: true });
		try {
			return read(db);
		} finally {
			db.close();
		}
	};
	const coldTranscript = async (sessionId: string, prompt: string) => {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			await new AppPage(page).goto(`${harness.baseUrl}/s/${sessionId}`);
			await expect(page.locator("#messages")).toContainText(prompt);
			await expect(page.locator("#messages")).toContainText(`done(${prompt})`);
		} finally {
			await context.close();
		}
	};
	try {
		const slugA = "process-test";
		const slugB = "project-b";
		const slugC = "project-c";
		const sessionA = "ses_available_a";
		const sessionB = "ses_repaired_b";
		const sessionC = "ses_retained_c";
		const folderB = join(harness.root, "project-b");
		const folderC = join(harness.root, "project-c");
		const promptA = "shared-store-available-a";
		const promptB = "shared-store-repaired-b";
		const promptC = "shared-store-retained-c";
		await createLegacyDaemonFixture(harness.configDir, [
			{
				projectId: slugA,
				folder: harness.projectDir,
				sessionId: sessionA,
				prompt: promptA,
				reply: `done(${promptA})`,
			},
			{
				projectId: slugB,
				folder: folderB,
				sessionId: sessionB,
				prompt: promptB,
				reply: `done(${promptB})`,
			},
			{
				projectId: slugC,
				folder: folderC,
				sessionId: sessionC,
				prompt: promptC,
				reply: `done(${promptC})`,
				retained: true,
			},
		]);
		expect(existsSync(destination)).toBe(false);

		const sourceB = harness.legacyProjectStorePath(slugB);
		const originalB = readFileSync(sourceB);
		evidence.repaired.userMessagesBefore = readStore(sourceB, (db) =>
			Number(
				db
					.prepare(
						"SELECT count(*) AS count FROM messages WHERE session_id = ? AND role = 'user'",
					)
					.get(sessionB)?.["count"],
			),
		);
		expect(evidence.repaired.userMessagesBefore).toBe(1);
		writeFileSync(sourceB, "not a SQLite database\n");
		await harness.restart();

		const reader = await harness.connect(undefined, undefined, slugA);
		const projects = await Effect.runPromise(reader.rpc.GetProjects({}));
		const projectA = projects.projects.find(
			(project) => project.slug === slugA,
		);
		const projectB = projects.projects.find(
			(project) => project.slug === slugB,
		);
		expect(projectA).toBeDefined();
		expect(projectA?.unavailableReason).toBeUndefined();
		expect(projectB?.unavailableReason).toEqual(expect.any(String));
		const reason = projectB?.unavailableReason;
		if (!reason)
			throw new Error("Failed import omitted its availability reason");
		let normalizedReason = reason;
		for (const [value, replacement] of [
			[realpathSync(harness.configDir), "<config>"],
			[harness.configDir, "<config>"],
			[realpathSync(harness.root), "<root>"],
			[harness.root, "<root>"],
			[sessionA, "<session-a>"],
			[sessionB, "<session-b>"],
			[sessionC, "<session-c>"],
			[slugA, "<project-a>"],
			[slugB, "<project-b>"],
			[slugC, "<project-c>"],
		] as const)
			normalizedReason = normalizedReason.replaceAll(value, replacement);
		evidence.unavailable.projectBReason = normalizedReason
			.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "<id>")
			.replace(/\.imported-\d+/g, ".imported-<timestamp>")
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>");
		evidence.unavailable.projectAAvailable = true;
		const listed = await Effect.runPromise(
			reader.rpc.ListDaemonSessions({ projectSlug: slugA }),
		);
		expect(
			listed.availability.find((project) => project.projectSlug === slugB),
		).toEqual({ projectSlug: slugB, available: false, error: reason });
		evidence.unavailable.sessionListReportsReason = true;
		expect(listed.sessions.some((session) => session.id === sessionC)).toBe(
			false,
		);
		expect(
			listed.availability.some((project) => project.projectSlug === slugC),
		).toBe(false);
		evidence.retained.hiddenFromSessionList = true;
		await expect(
			harness.connect(undefined, undefined, slugB),
		).rejects.toThrow();
		evidence.unavailable.relayRefused = true;
		await expect(
			Effect.runPromise(
				reader.rpc.CreateSession({
					projectSlug: slugB,
					originId: "failed-import-create",
					providerId: "claude",
					permissionMode: "ask",
					model: {
						providerId: "claude",
						modelId: "sonnet",
						variant: "",
						contextWindow: "200k",
					},
				}),
			),
		).rejects.toThrow();
		evidence.unavailable.sessionCreationRefused = true;
		// Startup finds legacy history through the main folder; moving it would orphan B.
		const movedB = join(harness.root, "project-b-moved");
		mkdirSync(movedB, { recursive: true });
		await expect(
			Effect.runPromise(
				reader.rpc.SaveProject({ slug: slugB, folders: [movedB] }),
			),
		).rejects.toThrow(/before changing its main folder/);
		const afterMove = await Effect.runPromise(reader.rpc.GetProjects({}));
		expect(
			JSON.stringify(
				afterMove.projects.find((project) => project.slug === slugB)?.folders,
			),
		).not.toContain("project-b-moved");
		evidence.unavailable.mainFolderChangeRefused = true;
		readStore(destination, (db) => {
			const tables = db
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
				.all();
			let projectBRows = 0;
			for (const table of tables) {
				const name = String(table["name"]).replaceAll('"', '""');
				const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
				if (!columns.some((column) => column["name"] === "project_id"))
					continue;
				projectBRows += Number(
					db
						.prepare(
							`SELECT count(*) AS count FROM "${name}" WHERE project_id = ?`,
						)
						.get(slugB)?.["count"],
				);
			}
			expect(projectBRows).toBe(0);
			evidence.unavailable.projectBRows = projectBRows;
			expect(
				db
					.prepare("SELECT project_id FROM sessions WHERE id = ?")
					.get(sessionC)?.["project_id"],
			).toBe(slugC);
			expect(
				Number(
					db
						.prepare(
							"SELECT count(*) AS count FROM events WHERE session_id = ? AND project_id = ?",
						)
						.get(sessionC, slugC)?.["count"],
				),
			).toBeGreaterThan(0);
			evidence.retained.rowsImportedWithSlug = true;
		});
		await coldTranscript(sessionA, promptA);
		evidence.unavailable.aTranscriptRendered = true;

		await harness.terminate();
		writeFileSync(sourceB, originalB);
		await harness.restart();
		const repairedReader = await harness.connect(undefined, undefined, slugA);
		const repairedProjects = await Effect.runPromise(
			repairedReader.rpc.GetProjects({}),
		);
		const repairedB = repairedProjects.projects.find(
			(project) => project.slug === slugB,
		);
		expect(repairedB).toBeDefined();
		expect(repairedB?.unavailableReason).toBeUndefined();
		const repairedList = await Effect.runPromise(
			repairedReader.rpc.ListDaemonSessions({ projectSlug: slugA }),
		);
		expect(
			repairedList.availability.find(
				(project) => project.projectSlug === slugB,
			),
		).toEqual({ projectSlug: slugB, available: true });
		evidence.repaired.available = true;
		await coldTranscript(sessionB, promptB);
		evidence.repaired.transcriptRendered = true;
		evidence.repaired.userMessagesAfter = readStore(destination, (db) =>
			Number(
				db
					.prepare(
						"SELECT count(*) AS count FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ? AND s.project_id = ? AND m.role = 'user'",
					)
					.get(sessionB, slugB)?.["count"],
			),
		);
		expect(evidence.repaired.userMessagesAfter).toBe(
			evidence.repaired.userMessagesBefore,
		);
		const { savedSlug: restoredSlugC } = await Effect.runPromise(
			repairedReader.rpc.SaveProject({
				title: "Project C",
				folders: [folderC],
			}),
		);
		expect(restoredSlugC).toBe(slugC);
		evidence.retained.originalSlugReused = true;
		const restoredList = await Effect.runPromise(
			repairedReader.rpc.ListDaemonSessions({ projectSlug: slugA }),
		);
		expect(
			restoredList.sessions
				.filter((session) => session.id === sessionC)
				.map((session) => session.projectSlug),
		).toEqual([slugC]);
		evidence.retained.sessionListed = true;
		await coldTranscript(sessionC, promptC);
		evidence.retained.transcriptRendered = true;
		evidence.passed = true;
	} finally {
		writeImportArtifact(unavailableArtifact, evidence);
		await testInfo.attach(basename(unavailableArtifact), {
			path: unavailableArtifact,
			contentType: "application/json",
		});
	}
});
