// Run outside the socket-restricted sandbox. Every history is written by the
// daemon, and both imports run through the daemon's real startup graph.
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
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
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
	storeUnchangedByRestart: false,
	projectEventStoreFiles: [] as string[],
	passed: false,
};

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });
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
	const sharedEnvironment = { CONDUIT_SHARED_STORE: "1" };
	const destination = daemonStorePath(harness.configDir);
	const sources = () => {
		const projects = join(harness.configDir, "projects");
		return readdirSync(projects, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(projects, entry.name, "events.db"))
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
		const control = await harness.connect();
		const { savedSlug: slugA } = await Effect.runPromise(
			control.rpc.SaveProject({
				slug: "process-test",
				title: "Project A",
				folders: [harness.projectDir],
			}),
		);
		const folderB = join(harness.root, "project-b");
		mkdirSync(folderB);
		const { savedSlug: slugB } = await Effect.runPromise(
			control.rpc.SaveProject({ title: "Project B", folders: [folderB] }),
		);
		if (!slugA || !slugB) throw new Error("SaveProject omitted a project slug");
		const driverA = await harness.connect(undefined, undefined, slugA);
		const driverB = await harness.connect(undefined, undefined, slugB);
		const sessionA = await driverA.createSession("Shared-store project A");
		await driverB.startInstance("opencode");
		const sessionB = await driverB.createSession(
			"Shared-store project B",
			"opencode",
			"opencode",
			{ modelProviderId: "opencode", modelId: "nemotron-3-super-free" },
		);
		const promptA = "shared-store-history-a";
		const promptB = "Hello, reply with just the word pong";
		expect((await driverA.send(sessionA, promptA)).done["status"]).toBe("idle");
		expect((await driverB.send(sessionB, promptB)).done["status"]).toBe("idle");
		expect(existsSync(destination)).toBe(false);
		for (const slug of [slugA, slugB])
			expect(existsSync(harness.projectStorePath(slug))).toBe(true);
		await harness.terminate();
		await harness.restart({ serviceEnvironment: sharedEnvironment });
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
			const source = harness.projectStorePath(slug);
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
					if (String(filename) === "events.db")
						foundSources.add(relative(harness.configDir, source));
				}),
			);
		}
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
		// The HTTP recording contains five prompt segments. The harness retains
		// its mock across daemon restarts, so this replays segment 2 on session B.
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

		// Compare quiescent stores, with every SQLite reader closed before startup.
		await harness.terminate();
		assertNoSources();
		const before = daemonStoreManifest(destination);
		await harness.restart({ serviceEnvironment: sharedEnvironment });
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
	const sharedEnvironment = { CONDUIT_SHARED_STORE: "1" };
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
		const control = await harness.connect();
		const { savedSlug: slugA } = await Effect.runPromise(
			control.rpc.SaveProject({
				slug: "process-test",
				title: "Project A",
				folders: [harness.projectDir],
			}),
		);
		const folderB = join(harness.root, "project-b");
		const folderC = join(harness.root, "project-c");
		mkdirSync(folderB);
		mkdirSync(folderC);
		const { savedSlug: slugB } = await Effect.runPromise(
			control.rpc.SaveProject({ title: "Project B", folders: [folderB] }),
		);
		const { savedSlug: slugC } = await Effect.runPromise(
			control.rpc.SaveProject({ title: "Project C", folders: [folderC] }),
		);
		if (!slugA || !slugB || !slugC)
			throw new Error("SaveProject omitted a project slug");
		const driverA = await harness.connect(undefined, undefined, slugA);
		const driverB = await harness.connect(undefined, undefined, slugB);
		const driverC = await harness.connect(undefined, undefined, slugC);
		const sessionA = await driverA.createSession("Available project A");
		const sessionB = await driverB.createSession("Repairable project B");
		const sessionC = await driverC.createSession("Retained project C");
		const promptA = "shared-store-available-a";
		const promptB = "shared-store-repaired-b";
		const promptC = "shared-store-retained-c";
		for (const [driver, sessionId, prompt] of [
			[driverA, sessionA, promptA],
			[driverB, sessionB, promptB],
			[driverC, sessionC, promptC],
		] as const)
			expect((await driver.send(sessionId, prompt)).done["status"]).toBe(
				"idle",
			);
		expect(existsSync(destination)).toBe(false);
		await Effect.runPromise(control.rpc.RemoveProject({ slug: slugC }));
		await harness.terminate();

		const sourceB = harness.projectStorePath(slugB);
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
		await harness.restart({ serviceEnvironment: sharedEnvironment });

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
		await harness.restart({ serviceEnvironment: sharedEnvironment });
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
