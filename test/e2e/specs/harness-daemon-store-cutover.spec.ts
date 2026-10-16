// Run outside the socket-restricted sandbox. Every history is written by the
// daemon, and both imports run through the daemon's real startup graph.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	watch,
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
	writeImportArtifact(artifact, initial);
});

test("the daemon imports project histories and keeps using its shared store across restarts", async ({
	browser,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
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
