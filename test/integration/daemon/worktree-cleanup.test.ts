/*
 * Failure modes: cleanup loses a branch or prevents the next turn; a policy
 * removes unmerged work, local files, a shared checkout or a viewed session;
 * deleted ownership disappears; inactivity reads the wrong clock; defaults or
 * settings disappear across restart; automatic requests race the manual result.
 * Exercise the daemon RPCs, real owned checkouts and the next provider turn.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CleanUpWorktreesNow,
	ClosePty,
	CreatePty,
	CreateSession,
	DeleteSession,
	GetWorktreeCleanupSetting,
	ListDaemonSessions,
	ListPtys,
	MoveSessionWorkspace,
	SetSessionSettled,
	SetWorktreeCleanupSetting,
} from "../../../src/lib/contracts/ws-rpc.js";
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

type CleanupSetting = {
	onSettle: "off" | "merged" | "any";
	onDelete: boolean;
	afterInactiveDays: number | null;
	whenMerged: boolean;
	noCommitsBeyondDefault: boolean;
	keepWhen: "any-local-files" | "uncommitted-changes" | "tracked-changes";
};

const defaults: CleanupSetting = {
	onSettle: "merged",
	onDelete: false,
	afterInactiveDays: null,
	whenMerged: false,
	noCommitsBeyondDefault: false,
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
		{ title: string; path: string; branch: string }
	>();

	async function start(
		worktreeCleanup: Partial<CleanupSetting> | null = { onSettle: "off" },
	) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { sweeps: [] };
		owned.clear();
		const fixture = ProcessHarness.create();
		harness = fixture;
		git(fixture.projectDir, "init", "-b", "main");
		writeFileSync(join(fixture.projectDir, "base.txt"), "committed base\n");
		writeFileSync(
			join(fixture.projectDir, ".gitignore"),
			"ignored.txt\nnode_modules/\n",
		);
		git(fixture.projectDir, "add", "base.txt", ".gitignore");
		commit(fixture.projectDir, "Initial commit");
		writeFileSync(
			join(fixture.configDir, "daemon.json"),
			JSON.stringify({
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				autoSettleAfterDays: null,
				projects: [],
				...(worktreeCleanup === null ? {} : { worktreeCleanup }),
			}),
		);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const socket = join(fixture.configDir, "relay.sock");
		const sessions = () =>
			sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
		const create = async (title: string, newWorktree = true) => {
			const result = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "cleanup-test",
					providerId: "claude",
					title,
					...(newWorktree ? { newWorktree: true } : {}),
				}),
			);
			const session = (await sessions()).sessions.find(
				({ id }) => id === result.sessionId,
			);
			const path = session?.workspace?.worktrees[fixture.projectDir];
			if (newWorktree && !path)
				throw new Error("Conduit did not publish an owned worktree");
			const branch = path ? git(path, "branch", "--show-current") : "main";
			if (path) owned.set(result.sessionId, { title, path, branch });
			return { id: result.sessionId, path: path ?? fixture.projectDir, branch };
		};
		const settle = (sessionId: string) =>
			sendRpcRequest(
				socket,
				new SetSessionSettled({
					projectSlug: "process-test",
					sessionId,
					settled: true,
				}),
			);
		const sweep = async (label: string, projectSlug?: string) => {
			const result = await sendRpcRequest(
				socket,
				new CleanUpWorktreesNow(
					projectSlug === undefined ? {} : { projectSlug },
				),
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
		const setting = () =>
			sendRpcRequest(socket, new GetWorktreeCleanupSetting({}));
		const set = async (value: Partial<CleanupSetting>) => {
			const worktreeCleanup = { ...defaults, ...value };
			expect(
				await sendRpcRequest(
					socket,
					new SetWorktreeCleanupSetting({ worktreeCleanup }),
				),
			).toEqual({ worktreeCleanup });
			return worktreeCleanup;
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
							fixture.projectDir,
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
		await enable(session, { onSettle: "merged" });
		git(fixture.projectDir, "merge", "--ff-only", session.branch);
		const result = await sweep("settled and merged", "process-test");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/settled.*merged/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
		const rows = await sendRpcRequest(
			socket,
			new ListDaemonSessions({
				projectSlug: "process-test",
				scope: "process-test",
			}),
		);
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

	it("keeps settled unmerged work under merged and removes it under any", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("unmerged policies");
		writeFileSync(join(session.path, "base.txt"), "unmerged commit\n");
		commit(session.path, "Unmerged work");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		await enable(session, { onSettle: "merged" });
		const kept = await sweep("unmerged policy");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/merged|rule/i),
		});
		expect(existsSync(session.path)).toBe(true);
		await enable(session, { onSettle: "any" });
		const removed = await sweep("any policy");
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

	it("keeps uncommitted files under the default keepWhen and reports the count", async () => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("uncommitted files");
		await settle(session.id);
		writeFileSync(join(session.path, "untracked.txt"), "local work\n");
		await enable(session, { onSettle: "any" });
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
			await enable(session, { onSettle: "any", keepWhen });
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
		await enable(session, { onSettle: "any", keepWhen: "tracked-changes" });
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
		await enable(session, { onSettle: "any", keepWhen });
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
		await enable(session, { onSettle: "any", keepWhen });
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
		await sendRpcRequest(
			socket,
			new CreatePty({
				projectSlug: "process-test",
				sessionId: session.id,
				originId: "cleanup-test",
			}),
		);
		const { ptys } = await sendRpcRequest(
			socket,
			new ListPtys({ projectSlug: "process-test", originId: "cleanup-test" }),
		);
		const pty = ptys.find(({ cwd }) => cwd === session.path);
		expect(pty?.status).toBe("running");
		if (!pty) throw new Error("Worktree terminal was not created");
		await settle(session.id);
		await fixture.kill();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			skipBrowserProbe: true,
		});
		await enable(session, { onSettle: "any" });
		const kept = await sweep("hosted terminal survives restart");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: "Has an open terminal",
		});
		expect(existsSync(session.path)).toBe(true);
		evidence["terminal"] = { id: pty.id, cwd: pty.cwd, pid: pty.pid };
		await sendRpcRequest(
			socket,
			new ClosePty({ projectSlug: "process-test", ptyId: pty.id }),
		);
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
		await enable(session, { onSettle: "any" });
		const db = new Database(
			join(fixture.configDir, "projects", "process-test", "events.db"),
		);
		try {
			// Reproduce admission's durable handoff before normal turn/status events.
			// A future retry is not dispatched by the fixture's background reactor.
			db.prepare(`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id,
					effect_type, payload_json, status, next_attempt_at, requested_at, updated_at)
					VALUES (-1, 'cleanup-handoff', ?, ?, 'claude', 'send_turn', '{}', ?, ?, ?, ?)`).run(
				fixture.projectDir,
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
		await sendRpcRequest(
			socket,
			new CreatePty({ projectSlug: "process-test", originId: "cleanup-test" }),
		);
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
			await enable(session, { onSettle: "any" });
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

	it("keeps an owned checkout shared with another live session", async () => {
		const { socket, create, settle, enable, sweep } = await start();
		const owner = await create("shared owner");
		const other = await create("shared user", false);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: other.id,
				path: owner.path,
			}),
		);
		await settle(owner.id);
		await enable(owner, { onSettle: "any" });
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
		const other = await sendRpcRequest(
			socket,
			new CreateSession({
				projectSlug,
				originId: "cleanup-test",
				providerId: "claude",
				title: "Registered project session",
			}),
		);
		const rows = await sendRpcRequest(
			socket,
			new ListDaemonSessions({
				projectSlug,
				scope: projectSlug,
			}),
		);
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
		await enable(owner, { onSettle: "any" });
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

	it("uses persisted activity for afterInactiveDays and keeps recent activity", async () => {
		const { fixture, create, enable, sweep } = await start();
		const old = await create("inactive");
		const recent = await create("recent");
		await enable(old, { onSettle: "off", afterInactiveDays: 7 });
		const now = Date.now();
		const db = new Database(fixture.projectStorePath());
		try {
			db.prepare("UPDATE sessions SET last_message_at = ? WHERE id = ?").run(
				now - 8 * 86_400_000,
				old.id,
			);
			db.prepare("UPDATE sessions SET last_message_at = ? WHERE id = ?").run(
				now,
				recent.id,
			);
		} finally {
			db.close();
		}
		evidence["seededActivity"] = { old: now - 8 * 86_400_000, recent: now };
		const result = await sweep("persisted inactivity");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: old.id,
			path: old.path,
			reason: expect.stringMatching(/inactiv|activity/i),
		});
		expect(result.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: recent.id,
			path: recent.path,
			reason: expect.stringMatching(/rule|inactiv|recent/i),
		});
		expect(existsSync(old.path)).toBe(false);
		expect(existsSync(recent.path)).toBe(true);
	}, 300_000);

	it("retains deleted ownership and only removes a deleted session through onDelete", async () => {
		const { fixture, socket, create, settle, enable, sweep } = await start();
		const session = await create("deleted ownership");
		const head = git(session.path, "rev-parse", "HEAD");
		await settle(session.id);
		writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
		await sendRpcRequest(
			socket,
			new DeleteSession({
				projectSlug: "process-test",
				sessionId: session.id,
				removeWorktrees: false,
			}),
		);
		expect(existsSync(session.path)).toBe(true);
		await enable(session, { onSettle: "any", noCommitsBeyondDefault: true });
		const kept = await sweep("deleted without onDelete");
		expect(kept.kept).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/deleted|onDelete|rule/i),
		});
		await enable(session, { onSettle: "off", onDelete: true });
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

	it("removes merged work while unsettled when whenMerged is enabled", async () => {
		const { fixture, create, enable, sweep } = await start();
		const session = await create("merged while unsettled");
		writeFileSync(join(session.path, "base.txt"), "merged feature\n");
		commit(session.path, "Merged feature");
		await enable(session, { onSettle: "off", whenMerged: true });
		git(fixture.projectDir, "merge", "--ff-only", session.branch);
		const result = await sweep("merged unsettled");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/merged/i),
		});
		expect(existsSync(session.path)).toBe(false);
	}, 300_000);

	it("removes a fresh branch only when noCommitsBeyondDefault is enabled", async () => {
		const { fixture, create, enable, sweep } = await start();
		const session = await create("ancestor of default");
		const head = git(session.path, "rev-parse", "HEAD");
		const kept = await sweep("no matching rule");
		expect(kept).toEqual({ removed: [], kept: [], failed: [] });
		expect(existsSync(session.path)).toBe(true);
		await enable(session, { onSettle: "off", noCommitsBeyondDefault: true });
		const removed = await sweep("default ancestor");
		expect(removed.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.id,
			path: session.path,
			reason: expect.stringMatching(/commits.*default|ancestor/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBe(head);
	}, 300_000);

	it("keeps a checkout while the session has a viewer", async () => {
		const { fixture, create, settle, enable, sweep } = await start();
		const session = await create("viewed session");
		await settle(session.id);
		const browser = await fixture.connect(session.id);
		await enable(session, { onSettle: "any" });
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
		await enable(session, { onSettle: "any" });
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
		await enable(session, { onSettle: "any" });
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
		await set({ onSettle: "any" });
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 15_000,
		});
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBeTruthy();
		evidence["trigger"] = "setting change";
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
				worktreeCleanup: { ...defaults, onSettle: "any" },
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
		"symlink",
		"git-directory",
	] as const)("keeps an owned path replaced with a %s", async (replacement) => {
		const { create, settle, enable, sweep } = await start();
		const session = await create("path guard");
		await settle(session.id);
		await enable(session, { onSettle: "any" });
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
		expect(await setting()).toEqual({ worktreeCleanup: defaults });
		const saved = await set({
			onSettle: "any",
			onDelete: true,
			afterInactiveDays: 42,
			whenMerged: true,
			noCommitsBeyondDefault: true,
			keepWhen: "tracked-changes",
		});
		await fixture.shutdown();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(await setting()).toEqual({ worktreeCleanup: saved });
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
			worktreeCleanup: { ...defaults, onDelete: true },
		});
		evidence["settings"] = {
			defaults,
			saved,
			partial: { ...defaults, onDelete: true },
		};
	}, 300_000);
});
