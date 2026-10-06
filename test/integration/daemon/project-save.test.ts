import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetProjects,
	GetStatus,
	type ProjectInfo,
	ProjectSaveRejected,
	SaveProject,
	type SaveProjectInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { FolderIssue } from "../../../src/lib/project-folders.js";
import { discoverClaudeRunners } from "../../../src/lib/provider/claude/claude-runner-registry.js";
import { testRunnerAlive } from "../../helpers/claude-runner-cleanup.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const socket = (harness: ProcessHarness) =>
	join(harness.configDir, "relay.sock");

const readConfig = (harness: ProcessHarness): DaemonConfig =>
	JSON.parse(readFileSync(join(harness.configDir, "daemon.json"), "utf8"));

async function projectFolders(harness: ProcessHarness) {
	const { projects } = await sendRpcRequest(
		socket(harness),
		new GetProjects({}),
	);
	return projects.map(({ slug, folders, title }) => ({
		slug,
		folders,
		title,
	}));
}

function persistedTurn(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{ state: string }>,
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('text.delta', 'turn.completed', 'turn.error', 'turn.interrupted', 'session.status') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{ command_id: string; status: string }>,
		};
	} finally {
		db.close();
	}
}

describe("SaveProject through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	let operations: Array<Record<string, unknown>> = [];
	const folders = new Set<string>();

	async function start(
		name: string,
		options: Parameters<typeof ProcessHarness.create>[0] = {},
	) {
		scenario = name;
		operations = [];
		evidence = { operations };
		folders.clear();
		harness = ProcessHarness.create(options);
		folders.add(harness.projectDir);
		evidence["configDir"] = harness.configDir;
		await harness.restart();
		evidence["projectsBefore"] = await projectFolders(harness);
		evidence["runnerRegistrationsBefore"] = discoverClaudeRunners(
			harness.projectDir,
			harness.configDir,
		);
		return harness;
	}

	async function save(fixture: ProcessHarness, input: SaveProjectInput) {
		for (const folder of input.folders)
			folders.add(typeof folder === "string" ? folder : folder.path);
		try {
			const result = await sendRpcRequest(
				socket(fixture),
				new SaveProject(input),
			);
			operations.push({ input, result });
			return result;
		} catch (error) {
			operations.push({
				input,
				error:
					error instanceof ProjectSaveRejected
						? { _tag: error._tag, issues: error.issues }
						: String(error),
			});
			throw error;
		}
	}

	async function rejected(
		fixture: ProcessHarness,
		input: SaveProjectInput,
		issue: {
			kind: FolderIssue["kind"];
			path?: string;
			slug?: string;
			count?: number;
		},
	) {
		const error = await save(fixture, input).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(ProjectSaveRejected);
		if (!(error instanceof ProjectSaveRejected))
			throw new Error(`Expected ProjectSaveRejected, got ${String(error)}`);
		expect(error._tag).toBe("ProjectSaveRejected");
		expect(error.issues).toHaveLength(1);
		expect(error.issues).toMatchObject([issue]);
		return error.issues;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["failures"] =
				task.result?.errors?.map(({ message, stack }) => ({
					message,
					stack,
				})) ?? [];
			evidence["folderState"] = [...folders].map((path) => ({
				path,
				exists: existsSync(path),
				gitExists: existsSync(join(path, ".git")),
			}));
			evidence["runnerRegistrationsAfter"] = discoverClaudeRunners(
				fixture.projectDir,
				fixture.configDir,
			);
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/usg5-5-${scenario}.json`,
					JSON.stringify(
						{
							...evidence,
							generations: fixture.generations,
							process: fixture.proof(),
							runnerPids: fixture.runnerPids(),
							remainingRunnerPids: fixture.remainingRunnerPids(),
						},
						null,
						2,
					),
				);
				harness = undefined;
			}
		}
	});

	it("migrates a config without folders and persists its main folder", async () => {
		const fixture = await start("config-migration");
		await fixture.terminate();
		const legacy = readConfig(fixture);
		const project = legacy.projects.find(({ slug }) => slug === "process-test");
		if (!project) throw new Error("Missing initial project in daemon.json");
		delete (project as { folders?: unknown }).folders;
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify(legacy),
		);
		evidence["legacyConfig"] = legacy;
		expect(readConfig(fixture).projects[0]?.folders).toBeUndefined();

		await fixture.restart();
		const projects = await projectFolders(fixture);
		evidence["projectsAfter"] = projects;
		expect(projects).toMatchObject([
			{
				slug: "process-test",
				folders: [fixture.projectDir],
			},
		]);
		await vi.waitFor(() => {
			const rewritten = readConfig(fixture);
			evidence["rewrittenConfig"] = rewritten;
			const migrated = rewritten.projects.find(
				({ slug }) => slug === project.slug,
			);
			expect(migrated?.folders).toEqual([fixture.projectDir]);
			expect(migrated).not.toHaveProperty("directory");
		});
	}, 60_000);

	it("returns every folder rejection over RPC and a nested warning on success", async () => {
		const fixture = await start("rejections");
		const other = join(fixture.root, "other-project");
		const valid = join(fixture.root, "valid-folder");
		const file = join(fixture.root, "regular-file");
		const missing = join(fixture.root, "missing-folder");
		const unknownCreate = join(fixture.root, "unknown-create");
		const failedCreate = join(fixture.root, "missing-parent", "child");
		mkdirSync(other);
		mkdirSync(valid);
		writeFileSync(file, "not a directory");
		const otherProject = await save(fixture, { folders: [other] });
		const before = await projectFolders(fixture);
		const cases = [
			{ input: { folders: [] }, issue: { kind: "empty" } },
			{
				input: { folders: [valid, valid] },
				issue: { kind: "duplicate", path: valid },
			},
			{
				input: { slug: "process-test", folders: [other] },
				issue: {
					kind: "main-taken",
					path: other,
					slug: otherProject.savedSlug,
				},
			},
			{
				input: {
					slug: "unknown-project",
					folders: [{ path: unknownCreate, create: { gitInit: true } }],
				},
				issue: { kind: "unknown-project", slug: "unknown-project" },
			},
			{
				input: { folders: [missing] },
				issue: { kind: "missing", path: missing },
			},
			{
				input: { folders: [file] },
				issue: { kind: "not-a-folder", path: file },
			},
			{
				input: { folders: [{ path: valid, create: { gitInit: false } }] },
				issue: { kind: "create-exists", path: valid },
			},
			{
				input: {
					folders: [{ path: failedCreate, create: { gitInit: false } }],
				},
				issue: { kind: "mkdir-failed", path: failedCreate },
			},
		] satisfies Array<{
			input: SaveProjectInput;
			issue: { kind: FolderIssue["kind"]; path?: string; slug?: string };
		}>;
		for (const { input, issue } of cases) {
			const issues = await rejected(fixture, input, issue);
			if (issue.kind === "mkdir-failed")
				expect(issues[0]).toMatchObject({
					message: expect.stringContaining("ENOENT"),
				});
			expect(await projectFolders(fixture)).toEqual(before);
			expect(existsSync(unknownCreate)).toBe(false);
		}
		evidence["projectsAfterRejections"] = await projectFolders(fixture);
		expect(
			existsSync(join(fixture.configDir, "projects", "unknown-project")),
		).toBe(false);
		expect(existsSync(failedCreate)).toBe(false);

		const nested = join(valid, "nested");
		mkdirSync(nested);
		const saved = await save(fixture, { folders: [valid, nested] });
		expect(saved.warnings).toEqual([
			{ kind: "nested", path: nested, parent: valid },
		]);
		expect(
			saved.projects.find(({ slug }) => slug === saved.savedSlug),
		).toMatchObject({
			folders: [valid, nested],
		});
		evidence["projectsAfter"] = await projectFolders(fixture);
	}, 60_000);

	it("rolls back an earlier create when a later mkdir fails", async () => {
		const fixture = await start("rollback");
		const first = join(fixture.root, "rollback-first");
		const second = join(fixture.root, "absent-parent", "rollback-second");
		const before = await projectFolders(fixture);
		expect(existsSync(first)).toBe(false);
		await rejected(
			fixture,
			{
				folders: [
					{ path: first, create: { gitInit: true } },
					{ path: second, create: { gitInit: false } },
				],
			},
			{ kind: "mkdir-failed", path: second },
		);
		evidence["projectsAfter"] = await projectFolders(fixture);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(join(first, ".git"))).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(evidence["projectsAfter"]).toEqual(before);
		expect(
			readConfig(fixture).projects.some(({ path }) => path === first),
		).toBe(false);
	}, 60_000);

	it("creates folders with git init enabled and disabled", async () => {
		const fixture = await start("git-init");
		const git = join(fixture.root, "with-git");
		const plain = join(fixture.root, "without-git");
		const saved = await save(fixture, {
			folders: [
				{ path: git, create: { gitInit: true } },
				{ path: plain, create: { gitInit: false } },
			],
		});
		expect(saved.warnings).toEqual([]);
		expect(existsSync(git)).toBe(true);
		expect(existsSync(join(git, ".git"))).toBe(true);
		expect(existsSync(plain)).toBe(true);
		expect(existsSync(join(plain, ".git"))).toBe(false);
		const projects = await projectFolders(fixture);
		evidence["projectsAfter"] = projects;
		expect(projects.find(({ slug }) => slug === saved.savedSlug)).toMatchObject(
			{
				folders: [git, plain],
			},
		);
	}, 60_000);

	it("broadcasts saves and removals to a second browser connection", async () => {
		const fixture = await start("broadcast");
		const first = await fixture.connect();
		const observer = await fixture.connect();
		const directory = join(fixture.root, "broadcast-project");
		mkdirSync(directory);
		folders.add(directory);
		const lists: (readonly ProjectInfo[])[] = [];
		const following = Effect.runFork(
			Stream.runForEach(observer.rpc.SubscribeProjects({}), ({ projects }) =>
				Effect.sync(() => lists.push(projects)),
			),
		);
		const latest = () => lists.at(-1) ?? [];
		const input = { folders: [directory] };
		const saved = await Effect.runPromise(first.rpc.SaveProject(input));
		operations.push({ input, result: saved });
		await vi.waitFor(
			() =>
				expect(latest()).toContainEqual(
					expect.objectContaining({
						slug: saved.savedSlug,
						folders: [directory],
					}),
				),
			{ timeout: 15_000 },
		);
		evidence["saveBroadcast"] = latest();

		const removed = await Effect.runPromise(
			first.rpc.RemoveProject({ slug: saved.savedSlug }),
		);
		evidence["removeResponse"] = removed;
		await vi.waitFor(
			() =>
				expect(latest().some(({ slug }) => slug === saved.savedSlug)).toBe(
					false,
				),
			{ timeout: 15_000 },
		);
		evidence["removeBroadcast"] = latest();
		await Effect.runPromise(Fiber.interrupt(following));
		expect(latest()).toContainEqual(
			expect.objectContaining({ slug: "process-test" }),
		);
		expect(removed.projects.some(({ slug }) => slug === saved.savedSlug)).toBe(
			false,
		);
		evidence["projectsAfter"] = await projectFolders(fixture);
	}, 60_000);

	it("replaces the relay for extra folders without duplicating a held turn and rejects a running main change", async () => {
		const fixture = await start("running-turn-folders", { restartProof: true });
		const before = await fixture.connect();
		const sessionId = await before.createSession("Folder change during a turn");
		const prompt = "upgrade-long-turn";
		const extra = join(fixture.root, "extra-folder");
		const newMain = join(fixture.root, "running-new-main");
		mkdirSync(extra);
		mkdirSync(newMain);
		const input = {
			projectSlug: "process-test",
			sessionId,
			originId: before.originId,
			commandId: randomUUID(),
			text: prompt,
		};
		evidence["sendInput"] = input;
		const release = join(fixture.root, "release-upgrade-turn");
		try {
			await Effect.runPromise(before.rpc.SendMessage(input));
			await before.waitFor(
				(message) =>
					message["type"] === "delta" && message["sessionId"] === sessionId,
			);
			await vi.waitFor(() => {
				const state = persistedTurn(fixture, sessionId);
				evidence["heldTurnBeforeReplacement"] = state;
				expect(state.session.status).toBe("busy");
			});
			const registrations = discoverClaudeRunners(
				fixture.projectDir,
				fixture.configDir,
			);
			evidence["runnerRegistrationsBefore"] = registrations;
			expect(registrations).toHaveLength(1);
			const runner = registrations[0];
			if (!runner) throw new Error("Missing held runner");
			const markCursor = fixture.marks.length;
			evidence["readinessBefore"] = await sendRpcRequest(
				socket(fixture),
				new GetStatus({}),
			);
			const saved = await save(fixture, {
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			});
			expect(saved.savedSlug).toBe("process-test");
			expect(saved.warnings).toEqual([]);
			await vi.waitFor(() => {
				const adoptions = fixture.marks
					.slice(markCursor)
					.filter((mark) => mark.kind === "runner-started");
				evidence["relayReplacementAdoptions"] = adoptions;
				expect(adoptions).toContainEqual(
					expect.objectContaining({ sessionId, pid: runner.pid }),
				);
			});
			const status = await sendRpcRequest(socket(fixture), new GetStatus({}));
			evidence["readinessAfter"] = status;
			expect(
				status.projects.find(({ slug }) => slug === "process-test")?.status,
			).toBe("ready");
			expect(fixture.generations).toHaveLength(1);
			evidence["heldTurnAfterReplacement"] = persistedTurn(fixture, sessionId);
			expect(persistedTurn(fixture, sessionId).session.status).toBe("busy");
			expect(
				discoverClaudeRunners(fixture.projectDir, fixture.configDir),
			).toEqual(registrations);
			await rejected(
				fixture,
				{ slug: "process-test", folders: [newMain, extra] },
				{ kind: "sessions-running", count: 1 },
			);
			const projects = await projectFolders(fixture);
			evidence["projectsAfter"] = projects;
			expect(projects).toMatchObject([
				{
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				},
			]);

			const after = await fixture.connect(sessionId);
			const cursor = after.frames.length;
			writeFileSync(release, "finish held turn");
			const done = await after.waitFor(
				(message) =>
					message["type"] === "done" && message["sessionId"] === sessionId,
				cursor,
			);
			evidence["done"] = done;
			expect(done["code"]).toBe(0);
			await vi.waitFor(() => {
				const state = persistedTurn(fixture, sessionId);
				evidence["persisted"] = state;
				expect(state.session.status).toBe("idle");
				expect(state.turns).toEqual([{ state: "completed" }]);
				expect(state.commands.map(({ status }) => status)).toEqual([
					"completed",
				]);
			});
			const state = persistedTurn(fixture, sessionId);
			expect(
				state.events.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(1);
			expect(
				state.events.some(
					({ type }) => type === "turn.error" || type === "turn.interrupted",
				),
			).toBe(false);
			expect(
				state.events
					.filter(({ type }) => type === "text.delta")
					.map(({ data }) => (JSON.parse(data) as { text: string }).text),
			).toEqual([prompt, ...responseChunks(prompt)]);
			const history = await after.history(sessionId);
			evidence["history"] = history;
			expect(history.map(({ role }) => role)).toEqual(["user", "assistant"]);
			expect(history[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
				responseChunks(prompt).join(""),
			);
			const sdk = readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const enqueues = sdk.filter(
				(mark) => mark["kind"] === "enqueue" && mark["prompt"] === prompt,
			);
			evidence["sdkEnqueues"] = enqueues;
			expect(enqueues).toHaveLength(1);
			expect(
				after.frames
					.slice(cursor)
					.filter(
						({ message }) =>
							message["type"] === "done" && message["sessionId"] === sessionId,
					),
			).toHaveLength(1);
			evidence["runnerRegistrationsAfter"] = discoverClaudeRunners(
				fixture.projectDir,
				fixture.configDir,
			);
		} finally {
			writeFileSync(release, "cleanup");
		}
	}, 60_000);

	it("keeps the slug and stops old-main runners when changing an idle project's main folder", async () => {
		const fixture = await start("idle-main-folder", { restartProof: true });
		const before = await fixture.connect();
		const sessionId = await before.createSession("Idle main folder change");
		await before.send(sessionId, "idle-folder-history");
		await vi.waitFor(() => {
			const state = persistedTurn(fixture, sessionId);
			expect(state.session.status).toBe("idle");
			expect(state.commands.map(({ status }) => status)).toEqual(["completed"]);
		});
		const history = await before.history(sessionId);
		const registrations = discoverClaudeRunners(
			fixture.projectDir,
			fixture.configDir,
		);
		evidence["runnerRegistrationsBefore"] = registrations;
		expect(registrations).toHaveLength(1);
		for (const { pid } of registrations)
			expect(testRunnerAlive(pid)).toBe(true);
		const newMain = join(fixture.root, "idle-new-main");
		mkdirSync(newMain);
		const saved = await save(fixture, {
			slug: "process-test",
			folders: [newMain],
		});
		expect(saved.savedSlug).toBe("process-test");
		await vi.waitFor(() => {
			const after = discoverClaudeRunners(
				fixture.projectDir,
				fixture.configDir,
			);
			evidence["oldMainRunnerRegistrationsAfter"] = after;
			expect(after).toEqual([]);
			for (const { pid } of registrations)
				expect(testRunnerAlive(pid)).toBe(false);
		});
		evidence["newMainRunnerRegistrationsAfter"] = discoverClaudeRunners(
			newMain,
			fixture.configDir,
		);
		const projects = await projectFolders(fixture);
		evidence["projectsAfter"] = projects;
		expect(projects).toMatchObject([
			{ slug: "process-test", folders: [newMain] },
		]);
		const after = await fixture.connect(sessionId);
		const retained = await after.history(sessionId);
		evidence["historyAfter"] = retained;
		expect(retained).toEqual(history);
	}, 60_000);

	it("adds a folder through the built CLI using the harness socket", async () => {
		const fixture = await start("cli");
		const directory = join(fixture.root, "cli-project");
		mkdirSync(directory);
		folders.add(directory);
		// package.json's bin and the process harness use dist/src/bin/cli.js.
		const cli = resolve(
			process.env["CONDUIT_TEST_DIST"] ?? "dist",
			"src/bin/cli.js",
		);
		const args = [cli, "--add", directory];
		evidence["cliInput"] = {
			executable: process.execPath,
			args,
			configDir: fixture.configDir,
			socket: socket(fixture),
		};
		const result = await promisify(execFile)(process.execPath, args, {
			cwd: fixture.projectDir,
			env: {
				PATH: process.env["PATH"],
				HOME: join(fixture.root, "home"),
				XDG_CONFIG_HOME: join(fixture.root, "config"),
				XDG_CACHE_HOME: join(fixture.root, "cache"),
				XDG_DATA_HOME: join(fixture.root, "data"),
				CONDUIT_CONFIG_DIR: fixture.configDir,
				CLAUDE_CONFIG_DIR: join(fixture.root, "claude"),
			},
			timeout: 15_000,
			maxBuffer: 8000,
		});
		evidence["cliResult"] = { exitCode: 0, ...result };
		const projects = await projectFolders(fixture);
		evidence["projectsAfter"] = projects;
		const added = projects.filter(
			(project) => project.folders[0] === directory,
		);
		expect(added).toHaveLength(1);
		expect(added[0]?.folders).toEqual([directory]);
		expect(result.stdout).toContain(`Project added: ${added[0]?.slug}`);
	}, 60_000);
});
