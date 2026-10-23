/*
 * Failure modes: cleanup loses a branch or prevents the next turn; a policy
 * removes unsettled work, local files, a shared checkout or a viewed session;
 * deleted ownership disappears or deletion never requests cleanup; deferred
 * removal becomes a permanent Keep; settled age reads the wrong clock; defaults or
 * settings disappear across restart; automatic requests race the manual result;
 * project overrides leak into global or repository settings, skip cold Custom
 * projects, clean Off projects, or fail to protect a mid-run switch to Off.
 * Exercise the daemon RPCs, real owned checkouts and the next provider turn.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ProjectWorktreeCleanup,
	WorktreeCleanup,
} from "../../../src/lib/contracts/worktree.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { PtyHostClient } from "../../../src/lib/terminal/pty-host-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function commit(directory: string, message: string) {
	git(
		directory,
		"-c",
		"user.name=Cleanup test",
		"-c",
		"user.email=cleanup@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-am",
		message,
	);
}

type CleanupSetting = WorktreeCleanup;

const defaults: CleanupSetting = {
	onSettle: "nothing-missing",
	onDelete: false,
	settledAfterDays: null,
	keepWhen: "uncommitted-changes",
};
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const artifactPath = `test-results/worktree-cleanup-${timestamp}.json`;
const outcomes: Record<string, unknown>[] = [];

describe("Daemon-wide worktree cleanup through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const owned = new Map<
		string,
		{ title: string; path: string; branch: string; projectDir: string }
	>();

	async function start(
		worktreeCleanup: Partial<CleanupSetting> | null = { onSettle: "keep" },
		legacy?: {
			version: 1 | undefined;
			rules: Record<string, unknown> | undefined;
		},
	) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { sweeps: [] };
		owned.clear();
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		harness = fixture;
		// Settings-only cases never create a session or inspect a repository.
		const settingsOnly = worktreeCleanup === null;
		if (!settingsOnly) {
			git(fixture.projectDir, "init", "-b", "main");
			writeFileSync(join(fixture.projectDir, "base.txt"), "committed base\n");
			writeFileSync(
				join(fixture.projectDir, ".gitignore"),
				"ignored.txt\nnode_modules/\n",
			);
			git(fixture.projectDir, "add", "base.txt", ".gitignore");
			commit(fixture.projectDir, "Initial commit");
		}
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				...(legacy
					? legacy.version === undefined
						? {}
						: { configVersion: legacy.version }
					: { configVersion: 2 }),
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				autoSettleAfterDays: null,
				projects: [],
				instances: [
					{
						id: "claude",
						name: "Test Claude",
						driver: "claude",
						port: 0,
						managed: false,
						configDir: join(fixture.root, "claude"),
					},
				],
				accountDefaults: { claude: "claude" },
				...(legacy
					? legacy.rules === undefined
						? {}
						: { worktreeCleanup: legacy.rules }
					: worktreeCleanup === null
						? {}
						: { worktreeCleanup }),
			}),
		);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			skipBrowserProbe: settingsOnly,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const sessions = (projectSlug = "process-test") =>
			sendRpcRequest(socket, {
				_tag: "ListDaemonSessions",
				projectSlug,
				scope: projectSlug,
			});
		const create = async (
			title: string,
			newWorktree = true,
			project = { slug: "process-test", directory: fixture.projectDir },
		) => {
			const result = await sendRpcRequest(socket, {
				_tag: "CreateSession",
				projectSlug: project.slug,
				originId: "cleanup-test",
				providerId: "claude",
				permissionMode: "ask",
				model: { providerId: "claude", modelId: "sonnet" },
				title,
				...(newWorktree ? { newWorktree: true } : {}),
			});
			const session = (await sessions(project.slug)).sessions.find(
				({ id }) => id === result.sessionId,
			);
			const path = session?.workspace?.worktrees[project.directory];
			if (newWorktree && !path)
				throw new Error("Conduit did not publish an owned worktree");
			const branch = path ? git(path, "branch", "--show-current") : "main";
			if (path)
				owned.set(result.sessionId, {
					title,
					path,
					branch,
					projectDir: project.directory,
				});
			return { id: result.sessionId, path: path ?? project.directory, branch };
		};
		const settle = (sessionId: string) =>
			sendRpcRequest(socket, {
				_tag: "SetSessionSettled",
				sessionId,
				settled: true,
			});
		const sweep = async (label: string, projectSlug?: string) => {
			const result = await sendRpcRequest(
				socket,
				{
					_tag: "CleanUpWorktreesNow",
					...(projectSlug === undefined ? {} : { projectSlug }),
				},
				{ requestTimeoutMs: 30_000 },
			);
			(evidence["sweeps"] as unknown[]).push({ label, ...result });
			expect(result.failed).toEqual([]);
			for (const entry of [...result.removed, ...result.kept]) {
				expect(Object.keys(entry).sort()).toEqual([
					"path",
					"projectSlug",
					"reason",
					"sessionId",
				]);
				expect(entry.reason.trim()).not.toBe("");
			}
			return result;
		};
		const setting = (projectSlug?: string) =>
			sendRpcRequest(socket, {
				_tag: "GetWorktreeCleanupSetting",
				...(projectSlug === undefined ? {} : { projectSlug }),
			});
		const set = async (value: Partial<CleanupSetting>) => {
			const worktreeCleanup = { ...defaults, ...value };
			expect(
				await sendRpcRequest(socket, {
					_tag: "SetWorktreeCleanupSetting",
					scope: "global",
					rules: worktreeCleanup,
				}),
			).toEqual({ global: worktreeCleanup });
			return worktreeCleanup;
		};
		const setProject = async (
			override: ProjectWorktreeCleanup | null,
			projectSlug = "process-test",
		) => {
			const result = await sendRpcRequest(socket, {
				_tag: "SetWorktreeCleanupSetting",
				scope: "project",
				projectSlug,
				override,
			});
			expect(result.project).toEqual(override);
			return result;
		};
		// A tracked edit keeps automatic requests harmless until the manual run.
		// Drain those requests before restoring it so result assertions are repeatable.
		const enable = async (
			session: { path: string },
			value: Partial<CleanupSetting>,
		) => {
			writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
			await set(value);
			await sweep("drain setting request", "process-test");
			git(session.path, "restore", "base.txt");
		};
		return {
			fixture,
			socket,
			sessions,
			create,
			settle,
			sweep,
			setting,
			set,
			setProject,
			enable,
		};
	}

	afterEach(async ({ task }) => {
		const fixture = harness;
		evidence["scenario"] = task.name;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (fixture && task.result?.errors?.length)
			evidence["logs"] = fixture.logTail.slice(-4_000);
		try {
			if (fixture) {
				try {
					evidence["checkouts"] = [...owned].map(([sessionId, checkout]) => ({
						sessionId,
						...checkout,
						exists: existsSync(checkout.path),
						branchHead: git(
							checkout.projectDir,
							"rev-parse",
							`refs/heads/${checkout.branch}`,
						),
					}));
				} finally {
					await fixture.dispose();
					fixture.assertNoRunners();
				}
			}
		} finally {
			const serialized = JSON.stringify(evidence);
			outcomes.push(
				JSON.parse(
					fixture ? serialized.replaceAll(fixture.root, "<root>") : serialized,
				) as Record<string, unknown>,
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				artifactPath,
				`${JSON.stringify({ command: "pnpm vitest run --config vitest.integration.config.ts test/integration/daemon/worktree-cleanup.test.ts", outcomes }, null, 2)}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("removes settled merged work, preserves its branch and recreates it on the next message", async () => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const session = await create("merged recovery");
		writeFileSync(join(session.path, "base.txt"), "feature commit\n");
		commit(session.path, "Feature work");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		await enable(session, { onSettle: "nothing-missing" });
		git(fixture.projectDir, "merge", "--ff-only", session.branch);
		const result = await sweep("settled and merged", "process-test");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/nothing.*missing/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
		const rows = await sendRpcRequest(socket, {
			_tag: "ListDaemonSessions",
			projectSlug: "process-test",
			scope: "process-test",
		});
		expect(
			rows.sessions.find(({ id }) => id === session.id)?.workspace?.worktrees[
				fixture.projectDir
			],
		).toBe(session.path);
		const browser = await fixture.connect();
		await browser.send(session.id, "Use the recreated checkout.", 120_000);
		expect(existsSync(session.path)).toBe(true);
		expect(git(session.path, "branch", "--show-current")).toBe(session.branch);
		expect(git(session.path, "rev-parse", "HEAD")).toBe(head);
		expect(
			fixture
				.claudeOptions()
				.filter(({ prompt }) => prompt !== undefined)
				.at(-1),
		).toMatchObject({
			prompt: "Use the recreated checkout.",
			options: { cwd: session.path },
		});
		evidence["recovered"] = {
			path: session.path,
			branch: session.branch,
			head,
		};
	}, 300_000);

	it("keeps settled unmerged work under nothing-missing and removes it right away", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("unmerged policies");
		writeFileSync(join(session.path, "base.txt"), "unmerged commit\n");
		commit(session.path, "Unmerged work");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		await enable(session, { onSettle: "nothing-missing" });
		const kept = await sweep("unmerged policy");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/merged|rule/i),
		});
		expect(existsSync(session.path)).toBe(true);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		const removed = await sweep("right away");
		expect(removed.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/settled/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it.each([
		"origin-default",
		"zero-commit",
	] as const)("removes settled %s work when nothing is missing", async (kind) => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create(kind);
		if (kind === "origin-default") {
			writeFileSync(join(session.path, "base.txt"), "remote feature\n");
			commit(session.path, "Remote feature");
			git(
				fixture.projectDir,
				"update-ref",
				"refs/remotes/origin/trunk",
				git(session.path, "rev-parse", "HEAD"),
			);
			git(
				fixture.projectDir,
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
				"refs/remotes/origin/trunk",
			);
			expect(git(fixture.projectDir, "rev-parse", "main")).not.toBe(
				git(session.path, "rev-parse", "HEAD"),
			);
		}
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		await enable(session, { onSettle: "nothing-missing" });
		const result = await sweep(kind);
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/nothing.*missing/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it.each([
		"dirty-zero-commit",
		"squash-merged",
		"untracked-only",
	] as const)("keeps settled %s work under nothing-missing even with tracked-changes", async (kind) => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create(kind);
		if (kind === "squash-merged") {
			writeFileSync(join(session.path, "base.txt"), "squashed feature\n");
			commit(session.path, "Feature before squash");
			git(fixture.projectDir, "merge", "--squash", session.branch);
			commit(fixture.projectDir, "Squashed feature");
		} else if (kind === "untracked-only") {
			writeFileSync(join(session.path, "untracked.txt"), "untracked work\n");
		}
		await settle(session.id);
		await enable(session, {
			onSettle: "nothing-missing",
			keepWhen: "tracked-changes",
		});
		if (kind === "dirty-zero-commit")
			writeFileSync(join(session.path, "base.txt"), "uncommitted work\n");
		const result = await sweep(kind);
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(
				kind === "squash-merged" ? /rule|missing|ancestor/i : /uncommitted/i,
			),
		});
		expect(existsSync(session.path)).toBe(true);
		if (kind === "untracked-only")
			expect(readFileSync(join(session.path, "untracked.txt"), "utf8")).toBe(
				"untracked work\n",
			);
	}, 300_000);

	it("nothing-missing respects the stricter any-local-files level", async () => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("ignored local work");
		await settle(session.id);
		writeFileSync(join(session.path, "ignored.txt"), "ignored local work\n");
		await enable(session, {
			onSettle: "nothing-missing",
			keepWhen: "any-local-files",
		});
		const result = await sweep("nothing-missing with ignored local files");
		expect(result.kept.some(({ sessionId }) => sessionId === session.id)).toBe(
			true,
		);
		expect(readFileSync(join(session.path, "ignored.txt"), "utf8")).toBe(
			"ignored local work\n",
		);
	}, 300_000);

	it("keeps uncommitted files under the default keepWhen and reports the count", async () => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("uncommitted files");
		await settle(session.id);
		writeFileSync(join(session.path, "untracked.txt"), "local work\n");
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		const result = await sweep("local edits");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/uncommitted changes.*1 files?/i),
		});
		expect(existsSync(join(session.path, "untracked.txt"))).toBe(true);
	}, 300_000);

	it.each([
		["uncommitted-changes", "ignored.txt", false],
		["any-local-files", "ignored.txt", true],
		["any-local-files", "node_modules/cache.txt", false],
	] as const)(
		"%s keeps ignored %s: %s",
		async (keepWhen, file, keep) => {
			const { fixture, create, settle, enable, sweep } = await start();
			const session = await create("ignored files");
			const head = git(session.path, "rev-parse", "HEAD");
			await settle(session.id);
			mkdirSync(join(session.path, "node_modules"), { recursive: true });
			writeFileSync(join(session.path, file), "ignored local data\n");
			await enable(session, {
				onSettle: "keep",
				settledAfterDays: 0,
				keepWhen,
			});
			const result = await sweep("ignored files");
			const entry = {
				projectSlug: "process-test",
				sessionId: session.id,
				path: session.path,
				reason: expect.stringMatching(
					keep ? /ignored|local files/i : /settled/i,
				),
			};
			expect(keep ? result.kept : result.removed).toContainEqual(entry);
			expect(existsSync(session.path)).toBe(keep);
			expect(
				git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
			).toBe(head);
		},
		300_000,
	);

	it("tracked-changes removes untracked and ignored files while retaining the branch", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("tracked policy");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		writeFileSync(join(session.path, "untracked.txt"), "disposable\n");
		writeFileSync(join(session.path, "ignored.txt"), "ignored disposable\n");
		await enable(session, {
			onSettle: "keep",
			settledAfterDays: 0,
			keepWhen: "tracked-changes",
		});
		const result = await sweep("tracked-only policy");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/settled/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it.each(
		(
			["any-local-files", "uncommitted-changes", "tracked-changes"] as const
		).flatMap((keepWhen) =>
			(["skip-worktree", "assume-unchanged"] as const).map((flag) => ({
				keepWhen,
				flag,
			})),
		),
	)("$keepWhen keeps tracked files marked $flag", async ({
		keepWhen,
		flag,
	}) => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("hidden tracked changes");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0, keepWhen });
		git(session.path, "update-index", `--${flag}`, "base.txt");
		writeFileSync(
			join(session.path, "base.txt"),
			"hidden local configuration\n",
		);
		expect(git(session.path, "status", "--porcelain=v1")).toBe("");
		const result = await sweep("hidden tracked changes");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Has files Git is told to ignore changes in",
		});
		expect(readFileSync(join(session.path, "base.txt"), "utf8")).toBe(
			"hidden local configuration\n",
		);
	}, 300_000);

	it.each(
		(
			["any-local-files", "uncommitted-changes", "tracked-changes"] as const
		).flatMap((keepWhen) =>
			(["repository", "worktree"] as const).map((kind) => ({ keepWhen, kind })),
		),
	)("$keepWhen keeps an ignored nested Git $kind", async ({
		keepWhen,
		kind,
	}) => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("nested Git data");
		const nested = join(session.path, "ignored.txt", "deep", "nested");
		const source =
			kind === "repository" ? nested : join(fixture.root, "nested-source");
		mkdirSync(source, { recursive: true });
		git(source, "init", "-b", "main");
		writeFileSync(join(source, "unpublished.txt"), "unpublished nested work\n");
		git(source, "add", "unpublished.txt");
		commit(source, "Unpublished nested commit");
		if (kind === "worktree")
			git(source, "worktree", "add", "-b", "nested", nested);
		const head = git(nested, "rev-parse", "HEAD");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0, keepWhen });
		const result = await sweep("nested Git data");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Contains a nested Git repository",
		});
		expect(git(nested, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(nested, "unpublished.txt"), "utf8")).toBe(
			"unpublished nested work\n",
		);
	}, 300_000);

	it("keeps a checkout with a hosted terminal after daemon restart until it closes", async () => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const session = await create("terminal ownership");
		await sendRpcRequest(socket, {
			_tag: "CreatePty",
			sessionId: session.id,
			originId: "cleanup-test",
		});
		const { ptys } = await sendRpcRequest(socket, {
			_tag: "ListPtys",
			projectSlug: "process-test",
			originId: "cleanup-test",
		});
		const pty = ptys.find(({ cwd }) => cwd === session.path);
		expect(pty?.status).toBe("running");
		if (!pty) throw new Error("Worktree terminal was not created");
		await settle(session.id);
		await fixture.kill();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			skipBrowserProbe: true,
		});
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		const kept = await sweep("hosted terminal survives restart");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Has an open terminal",
		});
		expect(existsSync(session.path)).toBe(true);
		evidence["terminal"] = { id: pty.id, cwd: pty.cwd, pid: pty.pid };
		await sendRpcRequest(socket, {
			_tag: "ClosePty",
			projectSlug: "process-test",
			ptyId: pty.id,
		});
		const removed = await sweep("terminal closed");
		expect(
			removed.removed.some(({ sessionId }) => sessionId === session.id),
		).toBe(true);
		expect(existsSync(session.path)).toBe(false);
	}, 300_000);

	it.each([
		"running",
		"retryable_failed",
	] as const)("keeps an idle checkout with a %s send_turn handoff", async (outboxStatus) => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("admitted handoff");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		const db = new Database(fixture.daemonStorePath());
		try {
			// Reproduce admission's durable handoff before normal turn/status events.
			// A future retry is not dispatched by the fixture's background reactor.
			db.prepare(`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, next_attempt_at, requested_at, updated_at)
					VALUES (-1, 'cleanup-handoff', ?, ?, 'claude', 'send_turn', '{}', ?, ?, ?, ?)`).run(
				// Admission keys durable commands by project slug.
				"process-test",
				session.id,
				outboxStatus,
				Date.now() + 86_400_000,
				Date.now(),
				Date.now(),
			);
			const kept = await sweep("admitted turn before status events");
			expect(kept.kept).toContainEqual({
				projectSlug: "process-test",
				sessionId: session.id,
				path: session.path,
				reason: "Session is running",
			});
			expect(existsSync(session.path)).toBe(true);
			db.prepare(
				"DELETE FROM provider_command_outbox WHERE command_id = 'cleanup-handoff'",
			).run();
			const removed = await sweep("handoff completed");
			expect(
				removed.removed.some(({ sessionId }) => sessionId === session.id),
			).toBe(true);
		} finally {
			db.close();
		}
	}, 300_000);

	it.each([
		false,
		true,
	])("keeps a checkout used by a terminal owned by another project, symlink: %s", async (throughSymlink) => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const session = await create("cross-project terminal");
		// Start the fixture host, then retain a terminal whose owning project
		// differs from its cwd through the host's public protocol.
		await sendRpcRequest(socket, {
			_tag: "CreatePty",
			projectSlug: "process-test",
			originId: "cleanup-test",
		});
		const host = await PtyHostClient.connect({
			configDir: fixture.configDir,
			start: false,
		});
		try {
			const cwd = throughSymlink
				? join(fixture.root, "terminal-alias")
				: session.path;
			if (throughSymlink) symlinkSync(session.path, cwd, "dir");
			const terminal = await host.create({
				cwd,
				projectDir: fixture.root,
				shell: "/bin/sh",
				env: {
					HOME: join(fixture.root, "home"),
					PATH: process.env["PATH"] ?? "/usr/bin:/bin",
				},
			});
			await settle(session.id);
			await enable(session, { onSettle: "keep", settledAfterDays: 0 });
			const kept = await sweep("another project's terminal");
			expect(kept.kept).toContainEqual({
				projectSlug: "process-test",
				sessionId: session.id,
				path: session.path,
				reason: "Has an open terminal",
			});
			expect(existsSync(session.path)).toBe(true);
			terminal.upstream.close();
			expect(
				(await sweep("other terminal closed")).removed.some(
					({ sessionId }) => sessionId === session.id,
				),
			).toBe(true);
		} finally {
			host.disconnect();
		}
	}, 300_000);

	it.each([
		"missing-symlink",
		"symlink-loop",
	] as const)("Clean up now resets a failed checkout's retry budget: %s", async (failure) => {
		const { fixture, socket, create, settle, set } = await start();
		const session = await create("manual retry");
		await sendRpcRequest(socket, {
			_tag: "CreatePty",
			projectSlug: "process-test",
			originId: "cleanup-test",
		});
		const host = await PtyHostClient.connect({
			configDir: fixture.configDir,
			start: false,
		});
		const cwd = join(fixture.root, "stale-terminal");
		if (failure === "missing-symlink") symlinkSync(session.path, cwd, "dir");
		else mkdirSync(cwd);
		try {
			const terminal = await host.create({
				cwd,
				projectDir: fixture.root,
				shell: "/bin/sh",
				env: {
					HOME: join(fixture.root, "home"),
					PATH: process.env["PATH"] ?? "/usr/bin:/bin",
				},
			});
			let output = "";
			terminal.onData((data) => {
				output = (output + data).slice(-2000);
			});
			terminal.upstream.send("printf 'cleanup-ready\\n'\r");
			// The host publishes creation before the child has entered its cwd.
			await vi.waitFor(() => expect(output).toContain("cleanup-ready\r\n"), {
				timeout: 10_000,
			});
			// The shell can still occupy the checkout after its cwd alias is gone.
			// Missing and unresolvable cwd paths must both keep cleanup conservative.
			if (failure === "missing-symlink") rmSync(cwd);
			else {
				renameSync(cwd, `${cwd}-retained`);
				symlinkSync(cwd, cwd, "dir");
			}
			await settle(session.id);
			await set({ onSettle: "keep", settledAfterDays: 0 });
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await sendRpcRequest(socket, {
					_tag: "CleanUpWorktreesNow",
					projectSlug: "process-test",
				});
				expect(result.failed).toContainEqual(
					expect.objectContaining({ sessionId: session.id }),
				);
				expect(result.kept).toEqual([]);
				expect(existsSync(session.path)).toBe(true);
				(evidence["sweeps"] as unknown[]).push({
					label: `manual retry ${attempt}`,
					...result,
				});
			}
			terminal.upstream.close();
			await vi.waitFor(
				async () => {
					const result = await sendRpcRequest(socket, {
						_tag: "CleanUpWorktreesNow",
						projectSlug: "process-test",
					});
					expect(result.failed).toEqual([]);
					expect(existsSync(session.path)).toBe(false);
				},
				{ timeout: 10_000 },
			);
		} finally {
			host.disconnect();
		}
	}, 300_000);

	it("keeps an owned checkout shared with another live session", async () => {
		const { socket, create, settle, enable, sweep } = await start();
		const owner = await create("shared owner");
		const other = await create("shared user", false);
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: other.id,
			path: owner.path,
		});
		await settle(owner.id);
		await enable(owner, { onSettle: "keep", settledAfterDays: 0 });
		const result = await sweep("shared checkout");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: owner.id,
			path: owner.path,
			reason: expect.stringMatching(/shared.*2 sessions/i),
		});
		expect(existsSync(owner.path)).toBe(true);
	}, 300_000);

	it("keeps an owned checkout used as another registered project's main folder", async () => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const owner = await create("registered project owner");
		const projectSlug = "historical-checkout-user";
		await fixture.shutdown();
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			projects: unknown[];
		};
		// Public registration rejects owned paths. Preserve the cleanup guard for
		// configurations saved before that restriction by restoring one at startup.
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					...config.projects,
					{
						path: owner.path,
						folders: [owner.path],
						slug: projectSlug,
						title: "Historical checkout user",
						addedAt: Date.now(),
					},
				],
			}),
		);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const other = await sendRpcRequest(socket, {
			_tag: "CreateSession",
			projectSlug,
			originId: "cleanup-test",
			providerId: "claude",
			permissionMode: "ask",
			model: { providerId: "claude", modelId: "sonnet" },
			title: "Registered project session",
		});
		const rows = await sendRpcRequest(socket, {
			_tag: "ListDaemonSessions",
			projectSlug,
			scope: projectSlug,
		});
		const row = rows.sessions.find(({ id }) => id === other.sessionId);
		expect(row).toBeDefined();
		expect(row?.workspace ?? null).toBeNull();
		evidence["registeredProjectUser"] = {
			projectSlug,
			sessionId: other.sessionId,
			folder: owner.path,
			workspace: row?.workspace ?? null,
		};
		await settle(owner.id);
		await enable(owner, { onSettle: "keep", settledAfterDays: 0 });
		const result = await sweep("registered project checkout", "process-test");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: owner.id,
			path: owner.path,
			reason: expect.stringMatching(
				/registered project|project folder|project checkout|shared/i,
			),
		});
		expect(existsSync(owner.path)).toBe(true);
	}, 300_000);

	it("counts N days from persisted settled_at rather than activity and keeps unmerged branches", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const old = await create("settled eight days ago");
		const recent = await create("settled today");
		for (const session of [old, recent]) {
			writeFileSync(
				join(session.path, "base.txt"),
				`${session.id} unmerged work\n`,
			);
			commit(session.path, "Unmerged work");
			await settle(session.id);
		}
		const oldHead = git(old.path, "rev-parse", "HEAD");
		await enable(old, { onSettle: "keep", settledAfterDays: 7 });
		const now = Date.now();
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(
				"UPDATE sessions SET settled_at = ?, last_message_at = ? WHERE id = ?",
			).run(now - 8 * 86_400_000, now, old.id);
			db.prepare(
				"UPDATE sessions SET settled_at = ?, last_message_at = ? WHERE id = ?",
			).run(now, now - 30 * 86_400_000, recent.id);
		} finally {
			db.close();
		}
		evidence["seededSettledAt"] = { old: now - 8 * 86_400_000, recent: now };
		const result = await sweep("persisted settled age");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: old.id,
			path: old.path,
			reason: expect.stringMatching(/settled for the set time/i),
		});
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: recent.id,
			path: recent.path,
			reason: expect.stringMatching(/rule|settled|recent/i),
		});
		expect(existsSync(old.path)).toBe(false);
		expect(existsSync(recent.path)).toBe(true);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${old.branch}`),
		).toBe(oldHead);
	}, 300_000);

	it("retains deleted ownership and only removes a deleted session through onDelete", async () => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const session = await create("deleted ownership");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
		await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: session.id,
		});
		expect(existsSync(session.path)).toBe(true);
		await enable(session, { onSettle: "nothing-missing", settledAfterDays: 0 });
		const kept = await sweep("deleted without onDelete");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/deleted|onDelete|rule/i),
		});
		await enable(session, { onSettle: "keep", onDelete: true });
		const removed = await sweep("deleted with onDelete");
		expect(removed.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/deleted/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it("inspects and deletes sessions across Custom and Off projects using each session's current rule", async () => {
		const { fixture, socket, create, setProject, setting, sessions, sweep } =
			await start();
		const directory = join(fixture.root, "off-project");
		mkdirSync(directory);
		git(directory, "init", "-b", "main");
		writeFileSync(join(directory, "base.txt"), "Off project base\n");
		git(directory, "add", "base.txt");
		commit(directory, "Off project base");
		const { savedSlug: slug } = await sendRpcRequest(socket, {
			_tag: "SaveProject",
			folders: [directory],
		});
		const remove = await create("Custom delete rule");
		const ask = await create("Off delete rule", true, { slug, directory });
		const inspect = (sessionId: string) =>
			sendRpcRequest(socket, { _tag: "InspectSessionWorktrees", sessionId });
		// Both relays are already loaded. Changes must be read at inspection time.
		for (const session of [remove, ask]) {
			expect((await inspect(session.id)).onDelete).toBe("ask");
		}
		await setProject({ ...defaults, onSettle: "keep", onDelete: true });
		await setProject("off", slug);
		expect((await setting()).global.onDelete).toBe(false);
		const inspections = await Promise.all([
			inspect(remove.id),
			inspect(ask.id),
		]);
		expect(inspections[0]).toMatchObject({
			onDelete: "remove",
			removeWorktrees: true,
			worktrees: [{ path: remove.path }],
		});
		expect(inspections[1]).toMatchObject({
			onDelete: "ask",
			removeWorktrees: true,
			worktrees: [{ path: ask.path }],
		});
		const payloads = [remove, ask].map(({ id }) => ({
			sessionId: id,
			removeWorktrees: false,
		}));
		const deletions = await Promise.all(
			payloads.map((payload) =>
				sendRpcRequest(socket, { _tag: "DeleteSession", ...payload }),
			),
		);
		for (const deletion of deletions) {
			expect(deletion.ok).toBe(true);
			expect(deletion.worktreeWarnings ?? []).toEqual([]);
		}
		await vi.waitFor(() => expect(existsSync(remove.path)).toBe(false), {
			timeout: 30_000,
		});
		expect(existsSync(ask.path)).toBe(true);
		// Drain all queued deletion runs before asserting that Off remains untouched.
		await sweep("cross-project deletion completed");
		expect(existsSync(ask.path)).toBe(true);
		for (const projectSlug of ["process-test", slug]) {
			expect((await sessions(projectSlug)).sessions).toEqual([]);
		}
		for (const [projectDir, session] of [
			[fixture.projectDir, remove],
			[directory, ask],
		] as const) {
			expect(
				git(projectDir, "rev-parse", `refs/heads/${session.branch}`),
			).toBeTruthy();
		}
		evidence["crossProjectDelete"] = {
			inspections,
			payloads,
			deletions,
			customRemoved: !existsSync(remove.path),
			offKept: existsSync(ask.path),
		};
	}, 300_000);

	it("requests cleanup after deletion without a cleanup RPC", async () => {
		const { fixture, socket, create, sessions } = await start({
			onSettle: "keep",
			onDelete: true,
		});
		const session = await create("delete trigger");
		const head = git(session.path, "rev-parse", "HEAD");
		const payload = {
			projectSlug: "process-test",
			sessionId: session.id,
			removeWorktrees: false,
		};
		evidence["deletion"] = {
			payload,
			head,
			checkoutExists: existsSync(session.path),
		};
		expect(existsSync(session.path)).toBe(true);
		const deletion = await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			...payload,
		});
		evidence["deletionResponse"] = deletion;
		expect(deletion.ok).toBe(true);
		expect(deletion.worktreeWarnings ?? []).toEqual([]);
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 60_000,
			interval: 100,
		});
		expect(
			(await sessions()).sessions.some(({ id }) => id === session.id),
		).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it("retries requested deletion cleanup once a dirty checkout is clean", async () => {
		const { fixture, socket, create, sweep } = await start({
			onSettle: "keep",
			onDelete: true,
		});
		const session = await create("deferred removal");
		const head = git(session.path, "rev-parse", "HEAD");
		writeFileSync(join(session.path, "base.txt"), "unfinished work\n");
		const deletion = await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: session.id,
			removeWorktrees: true,
		});
		evidence["deletion"] = deletion;
		expect(deletion.worktreeWarnings?.join(" ")).toMatch(/uncommitted/i);
		expect(existsSync(session.path)).toBe(true);
		await sweep("drain dirty deletion request", "process-test");
		git(session.path, "restore", "base.txt");
		const result = await sweep("retry requested removal", "process-test");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Session was deleted",
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it.each(
		(
			["any-local-files", "uncommitted-changes", "tracked-changes"] as const
		).flatMap((keepWhen) =>
			(["base.txt", "untracked.txt", "ignored.txt"] as const).map((file) => ({
				keepWhen,
				file,
			})),
		),
	)("delete cleanup with $keepWhen handles $file", async ({
		keepWhen,
		file,
	}) => {
		const { fixture, socket, create, enable, sweep } = await start();
		const session = await create("delete keep level");
		const head = git(session.path, "rev-parse", "HEAD");
		await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: session.id,
			removeWorktrees: false,
		});
		await enable(session, { onSettle: "keep", onDelete: true, keepWhen });
		writeFileSync(join(session.path, file), "local work\n");
		const keep =
			file === "base.txt" ||
			keepWhen === "any-local-files" ||
			(file === "untracked.txt" && keepWhen === "uncommitted-changes");
		const result = await sweep("delete keep level");
		expect(keep ? result.kept : result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(
				keep ? /uncommitted|ignored|local files/i : /deleted/i,
			),
		});
		expect(existsSync(session.path)).toBe(keep);
		if (keep)
			expect(readFileSync(join(session.path, file), "utf8")).toBe(
				"local work\n",
			);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it("keeps unsettled merged and zero-commit work with both settle rules enabled", async () => {
		const { fixture, create, enable, sweep } = await start();
		const merged = await create("unsettled merged");
		writeFileSync(join(merged.path, "base.txt"), "merged feature\n");
		commit(merged.path, "Merged feature");
		git(fixture.projectDir, "merge", "--ff-only", merged.branch);
		const zero = await create("unsettled zero commits");
		await enable(merged, { onSettle: "nothing-missing", settledAfterDays: 0 });
		const result = await sweep("unsettled sessions");
		for (const session of [merged, zero]) {
			expect(result.kept).toContainEqual({
				projectSlug: "process-test",
				sessionId: session.id,
				path: session.path,
				reason: expect.stringMatching(/rule/i),
			});
			expect(existsSync(session.path)).toBe(true);
		}
	}, 300_000);

	it("Never keeps settled unmerged work regardless of settled age", async () => {
		const { fixture, create, settle, sweep } = await start({
			onSettle: "nothing-missing",
			settledAfterDays: null,
		});
		const session = await create("Never");
		writeFileSync(join(session.path, "base.txt"), "unmerged work\n");
		commit(session.path, "Unmerged work");
		await settle(session.id);
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare("UPDATE sessions SET settled_at = ? WHERE id = ?").run(
				Date.now() - 3_000 * 86_400_000,
				session.id,
			);
		} finally {
			db.close();
		}
		const result = await sweep("Never after 3000 days");
		expect(result.removed).toEqual([]);
		expect(existsSync(session.path)).toBe(true);
	}, 300_000);

	it("keeps a checkout while the session has a viewer", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("viewed session");
		await settle(session.id);
		const browser = await fixture.connect(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		const kept = await sweep("viewer guard");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/viewer|viewed|viewing/i),
		});
		expect(existsSync(session.path)).toBe(true);
		await browser.close();
		await vi.waitFor(
			async () => {
				const result = await sweep("viewer disconnected");
				expect(
					result.removed.some(({ sessionId }) => sessionId === session.id),
				).toBe(true);
			},
			{ timeout: 15_000, interval: 100 },
		);
		expect(existsSync(session.path)).toBe(false);
	}, 300_000);

	it("keeps a checkout whose current branch differs from recorded ownership", async () => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("branch mismatch");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		git(session.path, "checkout", "-b", "fixture/replacement");
		const result = await sweep("branch guard");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/branch/i),
		});
		expect(existsSync(session.path)).toBe(true);
	}, 300_000);

	it("requests cleanup after a manual settle without a cleanup RPC", async () => {
		const { fixture, create, enable, settle, sessions } = await start();
		const session = await create("settle trigger");
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		await settle(session.id);
		const row = (await sessions()).sessions.find(({ id }) => id === session.id);
		expect(row?.settledAt).toBeDefined();
		evidence["settledRow"] = {
			sessionId: row?.id,
			settledAt: row?.settledAt,
			status: row?.status,
		};
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 15_000,
		});
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBeTruthy();
		evidence["trigger"] = "manual settle";
	}, 300_000);

	it("requests cleanup after the setting changes without a cleanup RPC", async () => {
		const { fixture, create, settle, set } = await start();
		const session = await create("setting trigger");
		await settle(session.id);
		await set({ onSettle: "keep", settledAfterDays: 0 });
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 15_000,
		});
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBeTruthy();
		evidence["trigger"] = "setting change";
	}, 300_000);

	it.each([
		"loaded",
		"cold",
	] as const)("cleans a %s Custom project under its own rules when global rules remove nothing", async (state) => {
		const { fixture, create, settle, setProject, setting, sweep } =
			await start();
		const session = await create("custom rules");
		writeFileSync(join(session.path, "base.txt"), "unmerged work\n");
		commit(session.path, "Unmerged custom work");
		const head = git(session.path, "rev-parse", "HEAD");
		writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
		writeFileSync(
			join(session.path, "untracked.txt"),
			"custom allows removal\n",
		);
		await settle(session.id);
		const custom: CleanupSetting = {
			...defaults,
			onSettle: "keep",
			settledAfterDays: 0,
			keepWhen: "tracked-changes",
		};
		await setProject(custom);
		await sweep("drain custom request");
		expect(await setting("process-test")).toEqual({
			global: { ...defaults, onSettle: "keep" },
			project: custom,
		});
		if (state === "cold") await fixture.shutdown();
		git(session.path, "restore", "base.txt");
		if (state === "cold") {
			await fixture.restart({
				startupTimeoutMs: 120_000,
				skipBrowserProbe: true,
			});
			await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
				timeout: 30_000,
			});
		} else {
			const result = await sweep("custom rules");
			expect(result.removed).toContainEqual({
				projectSlug: "process-test",
				sessionId: session.id,
				path: session.path,
				reason: expect.stringMatching(/settled/i),
			});
		}
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
		evidence["custom"] = {
			state,
			rules: custom,
			global: (await setting()).global,
		};
	}, 300_000);

	it.each([
		"loaded",
		"cold",
	] as const)("skips a %s Off project without reporting its worktrees in Clean up now", async (state) => {
		const { fixture, create, settle, setProject, sweep } = await start({
			onSettle: "keep",
			settledAfterDays: 0,
		});
		await setProject("off");
		const session = await create("off project");
		await settle(session.id);
		if (state === "cold") {
			await fixture.shutdown();
			await fixture.restart({
				startupTimeoutMs: 120_000,
				skipBrowserProbe: true,
			});
		}
		expect(await sweep("off project")).toEqual({
			removed: [],
			kept: [],
			failed: [],
		});
		expect(existsSync(session.path)).toBe(true);
		if (state === "cold")
			expect(fixture.generations.at(-1)?.fakeSdkActive).toBe(false);
		evidence["off"] = { state, pathExists: true };
	}, 300_000);

	it("a Use global project follows a global rules change", async () => {
		const { create, settle, setProject, enable, setting, sweep } =
			await start();
		await setProject("off");
		await setProject(null);
		const session = await create("use global");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		expect(await setting("process-test")).toEqual({
			global: { ...defaults, onSettle: "keep", settledAfterDays: 0 },
			project: null,
		});
		expect(
			(await sweep("use global")).removed.map(({ sessionId }) => sessionId),
		).toContain(session.id);
		expect(existsSync(session.path)).toBe(false);
	}, 300_000);

	it("a project switched to Off during cleanup keeps its worktree", async () => {
		const { fixture, create, settle, setProject, sweep } = await start();
		const session = await create("off during cleanup");
		await settle(session.id);
		writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
		await setProject({ ...defaults, onSettle: "keep", settledAfterDays: 0 });
		await sweep("drain custom request before pause");
		await fixture.shutdown();
		const gate = join(fixture.root, "cleanup-inspection");
		const preload = join(fixture.root, "pause-cleanup-inspection.mjs");
		// Pause the real filesystem inspection after the sweep has read its rules.
		// The process harness already accepts a test-only NODE_OPTIONS preload.
		writeFileSync(
			preload,
			`
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const gate = ${JSON.stringify(gate)};
const readdir = fs.readdir;
fs.readdir = async (directory, options) => {
  if (existsSync(gate) && String(directory) === readFileSync(gate, "utf8")) {
    writeFileSync(gate + "-started", String(directory));
    while (!existsSync(gate + "-release")) await new Promise(done => setTimeout(done, 10));
  }
  return readdir(directory, options);
};
syncBuiltinESMExports();
`,
		);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			serviceEnvironment: {
				NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
			},
		});
		await sweep("drain startup before pause");
		git(session.path, "restore", "base.txt");
		writeFileSync(gate, session.path);
		const running = sweep("switch Off during inspection", "process-test");
		try {
			await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true), {
				timeout: 15_000,
			});
			await setProject("off");
		} finally {
			writeFileSync(`${gate}-release`, "continue");
		}
		const result = await running;
		expect(result.removed).toEqual([]);
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Changed during check",
		});
		expect(existsSync(session.path)).toBe(true);
		expect(await sweep("Off after paused run")).toEqual({
			removed: [],
			kept: [],
			failed: [],
		});
		evidence["pausedRun"] = {
			inspectedPath: readFileSync(`${gate}-started`, "utf8"),
			switchedTo: "off",
		};
	}, 300_000);

	it("changing a project override requests only that project, while a global change requests all", async () => {
		const { fixture, socket, create, settle, set, setProject, sweep } =
			await start();
		const directory = join(fixture.root, "other-project");
		mkdirSync(directory);
		git(directory, "init", "-b", "main");
		writeFileSync(join(directory, "base.txt"), "other project\n");
		git(directory, "add", "base.txt");
		commit(directory, "Other project base");
		const { savedSlug: slug } = await sendRpcRequest(socket, {
			_tag: "SaveProject",
			folders: [directory],
		});
		const first = await create("project request");
		const second = await create("global request", true, { slug, directory });
		for (const session of [first, second]) {
			writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
			await settle(session.id);
		}
		await set({ onSettle: "keep", settledAfterDays: 0 });
		await sweep("drain global request with both guards");
		for (const session of [first, second])
			git(session.path, "restore", "base.txt");
		await setProject({
			...defaults,
			onSettle: "keep",
			settledAfterDays: 0,
			keepWhen: "any-local-files",
		});
		await vi.waitFor(() => expect(existsSync(first.path)).toBe(false), {
			timeout: 30_000,
		});
		expect(existsSync(second.path)).toBe(true);
		expect(
			(await sweep("drain project-only request", "process-test")).removed,
		).toEqual([]);
		expect(existsSync(second.path)).toBe(true);
		await set({ onSettle: "keep", settledAfterDays: 0, onDelete: true });
		await vi.waitFor(() => expect(existsSync(second.path)).toBe(false), {
			timeout: 30_000,
		});
		evidence["requestScopes"] = {
			projectOnly: "process-test",
			globalAlsoCleaned: slug,
		};
	}, 300_000);

	it("persists raw project overrides only in daemon.json and Use global removes the entry", async () => {
		const { fixture, socket, setting, setProject } = await start();
		const projectFile = join(fixture.projectDir, "conduit.json");
		const original = "{}\n";
		writeFileSync(projectFile, original);
		const custom: CleanupSetting = {
			...defaults,
			onSettle: "keep",
			settledAfterDays: 42,
			keepWhen: "any-local-files",
		};
		await setProject(custom);
		// Ordinary project edits must preserve an override supplied through Settings.
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir],
			title: "Renamed project",
		});
		expect((await setting("process-test")).project).toEqual(custom);
		for (const override of [custom, "off"] as const) {
			await setProject(override);
			await fixture.shutdown();
			const persisted = JSON.parse(
				readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
			) as {
				worktreeCleanup: CleanupSetting;
				projects: Array<{
					slug: string;
					worktreeCleanup?: ProjectWorktreeCleanup;
				}>;
			};
			expect(
				persisted.projects.find(({ slug }) => slug === "process-test")
					?.worktreeCleanup,
			).toEqual(override);
			expect(persisted.worktreeCleanup).toEqual({
				...defaults,
				onSettle: "keep",
			});
			expect(readFileSync(projectFile, "utf8")).toBe(original);
			await fixture.restart({ startupTimeoutMs: 120_000 });
			expect(await setting("process-test")).toEqual({
				global: persisted.worktreeCleanup,
				project: override,
			});
		}
		await setProject(null);
		await fixture.shutdown();
		const persisted = JSON.parse(
			readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
		) as {
			projects: Array<{
				slug: string;
				worktreeCleanup?: ProjectWorktreeCleanup;
			}>;
		};
		expect(
			persisted.projects.find(({ slug }) => slug === "process-test"),
		).not.toHaveProperty("worktreeCleanup");
		expect(readFileSync(projectFile, "utf8")).toBe(original);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect((await setting("process-test")).project).toBeNull();
		evidence["projectSettings"] = {
			custom,
			offPersisted: true,
			useGlobalRemovedOverride: true,
			projectFileUnchanged: true,
		};
	}, 300_000);

	it("rejects cleanup setting reads and overrides for an unknown project", async () => {
		const { setting, setProject } = await start();
		await expect(setting("unknown-project")).rejects.toThrow(
			/not found|not registered|unknown/i,
		);
		await expect(setProject("off", "unknown-project")).rejects.toThrow(
			/not found|not registered|unknown/i,
		);
		expect(await setting()).toEqual({
			global: { ...defaults, onSettle: "keep" },
		});
	}, 300_000);

	it("cleans a cold project's candidate at startup", async () => {
		const { fixture, create, settle } = await start();
		const session = await create("startup trigger");
		await settle(session.id);
		await fixture.shutdown();
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				worktreeCleanup: { ...defaults, onSettle: "keep", settledAfterDays: 0 },
			}),
		);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 15_000,
		});
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBeTruthy();
		evidence["trigger"] = "startup";
	}, 300_000);

	it.each([
		"disabled",
		"too-young",
		"unsettled",
	] as const)("does not boot a cold project whose session is %s", async (kind) => {
		const { fixture, create, settle, sweep } = await start();
		const session = await create(`cold ${kind}`);
		if (kind !== "unsettled") await settle(session.id);
		await fixture.shutdown();
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				worktreeCleanup: {
					...defaults,
					onSettle: "keep",
					settledAfterDays: kind === "disabled" ? null : 7,
				},
			}),
		);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			skipBrowserProbe: true,
		});
		expect(await sweep(`cold ${kind}`)).toEqual({
			removed: [],
			kept: [],
			failed: [],
		});
		expect(fixture.generations.at(-1)?.fakeSdkActive).toBe(false);
		expect(existsSync(session.path)).toBe(true);
		evidence["coldGeneration"] = fixture.generations.at(-1);
		if (kind === "too-young") {
			const db = new Database(fixture.daemonStorePath());
			try {
				db.prepare("UPDATE sessions SET settled_at = ? WHERE id = ?").run(
					Date.now() - 8 * 86_400_000,
					session.id,
				);
			} finally {
				db.close();
			}
			const result = await sweep("cold session now old enough");
			expect(
				result.removed.some(({ sessionId }) => sessionId === session.id),
			).toBe(true);
			expect(fixture.generations.at(-1)?.fakeSdkActive).toBe(true);
			expect(existsSync(session.path)).toBe(false);
		}
	}, 300_000);

	it.each([
		"symlink",
		"git-directory",
	] as const)("keeps an owned path replaced with a %s", async (replacement) => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("path guard");
		await settle(session.id);
		await enable(session, { onSettle: "keep", settledAfterDays: 0 });
		if (replacement === "symlink") {
			const destination = `${session.path}-moved`;
			renameSync(session.path, destination);
			symlinkSync(destination, session.path, "dir");
		} else {
			renameSync(join(session.path, ".git"), join(session.path, ".git-link"));
			mkdirSync(join(session.path, ".git"));
		}
		const result = await sweep("path identity guard");
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(
				replacement === "symlink" ? /symlink/i : /linked worktree|\.git/i,
			),
		});
		expect(existsSync(session.path)).toBe(true);
	}, 300_000);

	it("persists all setting fields across daemon restart and decodes missing fields to defaults", async () => {
		const { fixture, setting, set } = await start(null);
		expect(await setting()).toEqual({ global: defaults });
		const saved = await set({
			onSettle: "keep",
			onDelete: true,
			settledAfterDays: 42,
			keepWhen: "tracked-changes",
		});
		await fixture.shutdown();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(await setting()).toEqual({ global: saved });
		await fixture.shutdown();
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		expect(config["worktreeCleanup"]).toEqual(saved);
		writeFileSync(
			configPath,
			JSON.stringify({ ...config, worktreeCleanup: { onDelete: true } }),
		);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(await setting()).toEqual({
			global: { ...defaults, onDelete: true },
		});
		evidence["settings"] = {
			defaults,
			saved,
			partial: { ...defaults, onDelete: true },
		};
	}, 300_000);

	it.each(
		(
			[
				{ name: "missing cleanup", rules: undefined, expected: {} },
				{ name: "empty cleanup", rules: {}, expected: {} },
				{ name: "old merged", rules: { onSettle: "merged" }, expected: {} },
				{
					name: "old off",
					rules: { onSettle: "off" },
					expected: { onSettle: "keep" },
				},
				{
					name: "old any",
					rules: { onSettle: "any" },
					expected: { settledAfterDays: 0 },
				},
				{
					name: "idle only",
					rules: { onSettle: "off", afterInactiveDays: 42 },
					expected: { onSettle: "keep", settledAfterDays: 42 },
				},
				{
					name: "idle with default settle",
					rules: { afterInactiveDays: 3650 },
					expected: { settledAfterDays: 3650 },
				},
				{
					name: "merged switch",
					rules: { onSettle: "off", whenMerged: true },
					expected: {},
				},
				{
					name: "zero-commit switch",
					rules: { onSettle: "off", noCommitsBeyondDefault: true },
					expected: {},
				},
				{
					name: "only delete",
					rules: { onDelete: true },
					expected: { onDelete: true },
				},
				{
					name: "all local files",
					rules: { keepWhen: "any-local-files" },
					expected: { keepWhen: "any-local-files" },
				},
				{
					name: "all old fields",
					rules: {
						onSettle: "any",
						onDelete: true,
						afterInactiveDays: 42,
						whenMerged: true,
						noCommitsBeyondDefault: true,
						keepWhen: "tracked-changes",
					},
					expected: {
						settledAfterDays: 0,
						onDelete: true,
						keepWhen: "tracked-changes",
					},
				},
				{
					name: "version chooses old defaults",
					rules: { onSettle: "off", settledAfterDays: 0 },
					expected: { onSettle: "keep" },
				},
			] satisfies Array<{
				name: string;
				rules: Record<string, unknown> | undefined;
				expected: Partial<CleanupSetting>;
			}>
		).flatMap((scenario) =>
			([undefined, 1] as const).map((version) => ({
				...scenario,
				version,
				versionName: version === undefined ? "legacy" : "version 1",
			})),
		),
	)("migrates $versionName $name once across daemon restart", async ({
		rules,
		expected,
		version,
	}) => {
		const { fixture, setting } = await start(null, { rules, version });
		const migrated = { ...defaults, ...expected };
		expect(await setting()).toEqual({ global: migrated });
		const configPath = join(fixture.configDir, "daemon.json");
		await fixture.shutdown();
		const persisted = readFileSync(configPath, "utf8");
		const config = JSON.parse(persisted) as Record<string, unknown>;
		expect(config["configVersion"]).toBe(2);
		expect(config["worktreeCleanup"]).toEqual(migrated);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			skipBrowserProbe: true,
		});
		expect(await setting()).toEqual({ global: migrated });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			...config,
			pid: fixture.generations.at(-1)?.pid,
			port: fixture.generations.at(-1)?.port,
		});
		evidence["migration"] = {
			version: version ?? "legacy",
			rules,
			migrated,
			settingsUnchangedOnSecondStart: true,
		};
	}, 300_000);
});
