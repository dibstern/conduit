/*
 * 82tn.10.6 acceptance: one daemon-owned session manager serves every project.
 * Failure catalogue entries covered: 1-5, 17, 18 (recorded on the 82tn.10.6 bead).
 * - create, rename, fork and delete land in the right project with the right
 *   effective working directory (EWD), in two projects through one daemon;
 * - a fork keeps its parent's project and EWD;
 * - a delete in one project leaves the other project's sessions alone;
 * - a fresh browser connection after delete and fork reads the same state;
 * - a delete stops the session's running setup (the run lives in the session's
 *   owner scope, not the relay's).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "-b", "main", directory],
		[
			"-C",
			directory,
			"-c",
			"user.name=Session manager test",
			"-c",
			"user.email=sessions@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
	])
		execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
}

type Row = { id: string; project_id: string; title: string };

function sessionRow(fixture: ProcessHarness, id: string): Row | undefined {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare("SELECT id, project_id, title FROM sessions WHERE id = ?")
			.get(id) as Row | undefined;
	} finally {
		db.close();
	}
}

function setupEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT sequence, type, data FROM events WHERE session_id = ? AND type LIKE 'session.%' ORDER BY sequence",
				)
				.all(sessionId) as { sequence: number; type: string; data: string }[]
		).map(({ sequence, type, data }) => ({
			sequence,
			type,
			data: JSON.parse(data) as Record<string, unknown>,
		}));
	} finally {
		db.close();
	}
}

describe("daemon-owned session manager (82tn.10.6)", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const logs = fixture.logTail;
		const launches = fixture
			.claudeOptions()
			.map(({ prompt, resumeId, options }) => ({
				prompt,
				resumeId,
				cwd: options["cwd"],
			}));
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-10-6-daemon-sessions-${evidence["scenario"]}.json`,
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.6",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						...(task.result?.errors?.length ? { logs } : {}),
						launches,
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	const start = async (scenario: string) => {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		const fixture = ProcessHarness.create();
		harness = fixture;
		evidence = { scenario };
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const projects = [
			{ slug: "process-test", folder: realpathSync(fixture.projectDir) },
			{ slug: saved.savedSlug, folder: realpathSync(projectB) },
		] as const;
		const create = async (
			projectSlug: string,
			title: string,
			newWorktree: boolean,
		) => {
			const { sessionId } = await fixture.requestRpc({
				_tag: "CreateSession",
				projectSlug,
				originId: "daemon-session-manager",
				providerId: "claude",
				model: { providerId: "claude", modelId: "sonnet" },
				permissionMode: "ask",
				title,
				...(newWorktree ? { newWorktree: true } : {}),
			});
			return sessionId;
		};
		const listed = async (projectSlug: string, id: string) =>
			(
				await fixture.requestRpc({
					_tag: "ListDaemonSessions",
					projectSlug,
					scope: projectSlug,
				})
			).sessions.find((session) => session.id === id);
		/** The directory Claude was launched in for this prompt (a fork prepends a context handoff). */
		const cwdOf = (prompt: string) =>
			[...fixture.claudeOptions()]
				.reverse()
				.find((query) => query.prompt?.endsWith(prompt))?.options["cwd"];
		return { fixture, projects, create, listed, cwdOf };
	};

	it("creates, renames, forks and deletes in two projects through one daemon", async () => {
		const { fixture, projects, create, listed, cwdOf } =
			await start("two-projects");
		const observations: Record<string, unknown>[] = [];
		for (const { slug, folder } of projects) {
			const plain = await create(slug, `Plain ${slug}`, false);
			const worktree = await create(slug, `Worktree ${slug}`, true);
			const worktreePath = (await listed(slug, worktree))?.workspace?.worktrees[
				folder
			];
			expect(
				worktreePath,
				`${slug} worktree session has a worktree`,
			).toBeTypeOf("string");
			const browser = await fixture.connect(plain, undefined, slug);
			const plainPrompt = `Plain turn in ${slug}`;
			const worktreePrompt = `Worktree turn in ${slug}`;
			await browser.send(plain, plainPrompt);
			await browser.send(worktree, worktreePrompt);

			await fixture.requestRpc({
				_tag: "RenameSession",
				sessionId: plain,
				title: `Renamed ${slug}`,
			});
			const plainFork = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: plain,
			});
			const worktreeFork = await fixture.requestRpc({
				_tag: "ForkSession",
				originId: browser.originId,
				sessionId: worktree,
			});
			const forkPrompt = `Fork turn in ${slug}`;
			const worktreeForkPrompt = `Worktree fork turn in ${slug}`;
			await browser.send(plainFork.sessionId, forkPrompt);
			await browser.send(worktreeFork.sessionId, worktreeForkPrompt);

			const observation: Record<string, unknown> & {
				cwd: Record<string, unknown>;
			} = {
				slug,
				folder,
				worktreePath,
				rows: Object.fromEntries(
					[plain, worktree, plainFork.sessionId, worktreeFork.sessionId].map(
						(id) => [id, sessionRow(fixture, id)],
					),
				),
				cwd: {
					plain: cwdOf(plainPrompt),
					worktree: cwdOf(worktreePrompt),
					plainFork: cwdOf(forkPrompt),
					worktreeFork: cwdOf(worktreeForkPrompt),
				},
				forkProject: plainFork.projectSlug,
			};
			observations.push(observation);
			evidence["observations"] = observations;
			for (const id of [
				plain,
				worktree,
				plainFork.sessionId,
				worktreeFork.sessionId,
			])
				expect(sessionRow(fixture, id)?.project_id).toBe(slug);
			expect(sessionRow(fixture, plain)?.title).toBe(`Renamed ${slug}`);
			expect((await listed(slug, plain))?.title).toBe(`Renamed ${slug}`);
			expect(plainFork.projectSlug).toBe(slug);
			expect(observation.cwd).toEqual({
				plain: folder,
				worktree: worktreePath,
				plainFork: folder,
				worktreeFork: worktreePath,
			});

			await fixture.requestRpc({
				_tag: "DeleteSession",
				sessionId: plainFork.sessionId,
			});
			expect(sessionRow(fixture, plainFork.sessionId)).toBeUndefined();
			expect(await listed(slug, plainFork.sessionId)).toBeUndefined();
			// A fresh tab after the delete and fork reads the same state.
			const reconnected = await fixture.connect(
				worktreeFork.sessionId,
				undefined,
				slug,
			);
			expect(
				(await reconnected.history(worktreeFork.sessionId)).length,
			).toBeGreaterThan(0);
			observation["afterDelete"] = {
				deletedRow: sessionRow(fixture, plainFork.sessionId) ?? null,
				survivors: [plain, worktree, worktreeFork.sessionId].map((id) =>
					sessionRow(fixture, id),
				),
			};
		}
		// The first project's sessions outlived the second project's delete.
		const first = observations[0]?.["rows"] as Record<string, Row | undefined>;
		const firstDeleted = Object.keys(first)[2];
		for (const id of Object.keys(first).filter((id) => id !== firstDeleted))
			expect(sessionRow(fixture, id)?.project_id).toBe(projects[0].slug);
		evidence["observations"] = observations;
	});

	/**
	 * The setup shell holds `alive` open for writing for its whole life, so a
	 * read of `alive` ends (EOF) exactly when the shell and its children exit.
	 */
	const setupFifos = (fixture: ProcessHarness) => {
		const alive = join(fixture.root, "setup-alive");
		const gate = join(fixture.root, "setup-gate");
		execFileSync("mkfifo", [alive, gate]);
		return {
			alive,
			gate,
			/** Resolves once the setup shell is running. */
			started: () => open(alive, "r"),
			exited: async (handle: FileHandle) => {
				await handle.read(Buffer.alloc(1), 0, 1);
				await handle.close();
			},
		};
	};

	const setupFinished = (browser: ProcessBrowser, sessionId: string) =>
		browser.waitFor((message) => {
			const parts: unknown = message["parts"];
			return (
				message["type"] === "transcript_message" &&
				message["sessionId"] === sessionId &&
				Array.isArray(parts) &&
				parts.some(
					(part: { type?: string; setup?: { status?: string } }) =>
						part.type === "setup" &&
						part.setup?.status !== undefined &&
						part.setup.status !== "running",
				)
			);
		});

	it("keeps a session's running setup through its project's relay rebuild", async () => {
		const { fixture, projects, create } = await start("rebuild-keeps-setup");
		const project = projects[1];
		const marker = join(fixture.root, "setup-finished-after-rebuild");
		const extra = join(fixture.root, "project-b-extra");
		mkdirSync(extra, { recursive: true });
		const fifos = setupFifos(fixture);
		// The shell waits for the test to close the gate, so the rebuild lands mid-run.
		const setupScript = `exec 4> ${JSON.stringify(fifos.alive)} 5< ${JSON.stringify(fifos.gate)}; cat <&5 > /dev/null; echo done > ${JSON.stringify(marker)}`;
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: project.slug,
			folders: [project.folder],
			setupScript,
		});
		const sessionId = await create(project.slug, "Setup across rebuild", true);
		const alive = await fifos.started();
		const gate = await open(fifos.gate, "w");
		// Adding a folder rebuilds the project's relay while the setup runs.
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: project.slug,
			folders: [project.folder, extra],
			setupScript,
		});
		const browser = await fixture.connect(undefined, undefined, project.slug);
		await browser.view(sessionId);
		await gate.close();
		await fifos.exited(alive);
		const markerWritten = existsSync(marker);
		await setupFinished(browser, sessionId);
		const events = setupEvents(fixture, sessionId);
		evidence["setup"] = { events, markerWritten };
		expect(markerWritten).toBe(true);
		expect(
			events.filter(({ type }) => type === "session.setup_finished"),
		).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ status: "succeeded" }),
			}),
		]);
	});

	it("stops a session's running setup when the session is deleted", async () => {
		const { fixture, projects, create } = await start("delete-stops-setup");
		const project = projects[1];
		const marker = join(fixture.root, "setup-outlived-delete");
		const fifos = setupFifos(fixture);
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: project.slug,
			folders: [project.folder],
			setupScript: `exec 4> ${JSON.stringify(fifos.alive)}; sleep 20; echo late > ${JSON.stringify(marker)}`,
		});
		const sessionId = await create(project.slug, "Setup then delete", true);
		const alive = await fifos.started();
		const beforeDelete = setupEvents(fixture, sessionId);
		await fixture.requestRpc({
			_tag: "DeleteSession",
			sessionId,
			removeWorktrees: false,
		});
		// A live shell writes the marker before it exits; a stopped one never does.
		await fifos.exited(alive);
		const after = setupEvents(fixture, sessionId);
		const deletedAt = after.find(
			({ type }) => type === "session.deleted",
		)?.sequence;
		evidence["setup"] = {
			beforeDelete,
			after,
			markerWritten: existsSync(marker),
		};
		expect(deletedAt).toBeTypeOf("number");
		expect(existsSync(marker)).toBe(false);
		expect(
			after.filter(
				({ sequence, type }) =>
					sequence > (deletedAt ?? 0) && type.startsWith("session.setup"),
			),
		).toEqual([]);
	});
});
