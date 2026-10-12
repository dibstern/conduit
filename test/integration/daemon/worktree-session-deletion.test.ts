/*
 * Deletion failure cases, recorded before implementation:
 * - A missing remote HEAD falls back to local main, then master. If none
 *   resolves, inspection reports unknown default branch and defaults to Keep.
 * - Uncommitted changes, unpushed commits, and unmerged commits each name the
 *   folder and default to Keep. A branch without upstream is unpushed only
 *   when commits go beyond the launch base, including a chosen base branch.
 * - A dirty checkout, including one dirtied after inspection, is never removed
 *   with --force. Canonical session deletion still succeeds and reports a warning.
 * - An already-gone checkout is a no-op and does not cause deletion to fail.
 * - A fork sharing a parent's checkout makes it kept-in-use. Recheck current
 *   usage before removal, including another live session created after inspection.
 * - User/agent moves into existing worktrees never offer those for removal.
 *   Launch-created checkouts remain owned after moves, folder detach, or restart.
 * - One removal failing keeps its branch, reports/logs the failure, and leaves
 *   session.deleted committed; other owned checkouts may still be removed.
 * - Explicit Remove on an unmerged checkout keeps its branch. Delete a branch
 *   only after successful removal, proof of Conduit ownership, and a merged check.
 * - Detached commits have no branch to preserve after removal. Keep the checkout
 *   unless its HEAD is merged into a resolved default branch, even on explicit Remove.
 * - Multi-folder sessions inspect all owned checkouts, deduplicate shared Git
 *   roots, and keep all by default when any folder has a reason.
 * Every deletion writes before/after state manifests as repeatable evidence.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreateSession,
	DeleteSession,
	ForkSession,
	InspectSessionWorktrees,
	ListDaemonSessions,
	MoveSessionWorkspace,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
for (const key of gitOverrides) delete gitEnv[key];
function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function commit(directory: string, message = "Session work") {
	git(directory, "add", ".");
	git(
		directory,
		"-c",
		"user.name=Deletion test",
		"-c",
		"user.email=delete@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--allow-empty",
		"-m",
		message,
	);
}

describe("Worktree session deletion through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	let folders: string[] = [];
	const owned = new Map<
		string,
		{ folder: string; branch: string; sessionId: string }
	>();
	const names = new Map<string, string>();

	function seed(fixture: ProcessHarness, directory: string, branch = "main") {
		git(directory, "init", "-b", branch);
		mkdirSync(join(directory, "subfolder"), { recursive: true });
		writeFileSync(join(directory, "subfolder", "base.txt"), "committed base\n");
		commit(directory, "Initial commit");
		const remote = `${directory}-origin.git`;
		git(fixture.root, "init", "--bare", remote);
		git(directory, "remote", "add", "origin", remote);
		git(directory, "push", "-u", "origin", branch);
		git(remote, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			`refs/remotes/origin/${branch}`,
		);
	}

	async function start(
		name: string,
		options: {
			branch?: string;
			shim?: boolean;
			multi?: boolean;
			shared?: boolean;
			agent?: boolean;
		} = {},
	) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = { deletions: [] };
		owned.clear();
		names.clear();
		harness = ProcessHarness.create({
			...(options.shim ? { logLevel: "warn" } : {}),
			...(options.agent
				? {
						claudeReplay: {
							turns: ["enter-worktree-turn"],
							enterPath: ".claude/worktrees/contract",
						},
					}
				: {}),
		});
		const fixture = harness;
		writeFileSync(
			join(fixture.root, "claude", "conduit-test-record-forks"),
			"record\n",
		);
		seed(fixture, fixture.projectDir, options.branch);
		if (options.agent)
			git(
				fixture.projectDir,
				"worktree",
				"add",
				"-b",
				"agent/existing",
				join(fixture.projectDir, ".claude", "worktrees", "contract"),
			);
		folders = [fixture.projectDir];
		if (options.multi) {
			const secondary = join(fixture.root, "library");
			mkdirSync(secondary);
			seed(fixture, secondary, options.branch);
			folders.push(secondary);
		}
		if (options.shared) folders.push(join(fixture.projectDir, "subfolder"));
		if (options.shim) {
			const shim = join(fixture.root, "git-shim");
			mkdirSync(shim);
			const realGit = execFileSync("/usr/bin/which", ["git"], {
				env: gitEnv,
				encoding: "utf8",
			}).trim();
			writeFileSync(
				join(shim, "git"),
				`#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { appendFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("remove")) {
  appendFileSync(${JSON.stringify(join(fixture.root, "git-removals.jsonl"))}, JSON.stringify(args) + "\\n");
  if (existsSync(${JSON.stringify(join(fixture.root, "fail-remove"))})) {
    process.stderr.write("forced worktree removal failure\\n");
    process.exit(1);
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
				{ mode: 0o755 },
			);
			vi.stubEnv("PATH", `${shim}:${gitEnv["PATH"] ?? ""}`);
		}
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const socket = join(fixture.configDir, "relay.sock");
		if (folders.length > 1)
			await sendRpcRequest(
				socket,
				new SaveProject({ slug: "process-test", folders }),
			);
		const sessions = async () =>
			(await sendRpcRequest(socket, new ListDaemonSessions({ roots: false })))
				.sessions;
		const create = async (
			title: string,
			newWorktree = true,
			worktreeBase?: string,
			projectSlug = "process-test",
		) => {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug,
					originId: "delete-worktree-test",
					providerId: "claude",
					title,
					...(newWorktree ? { newWorktree: true } : {}),
					...(worktreeBase ? { worktreeBase } : {}),
				}),
			);
			names.set(sessionId, title);
			const session = (await sessions()).find(({ id }) => id === sessionId);
			if (!session) throw new Error("Created session was not listed");
			for (const [folder, path] of Object.entries(
				session.workspace?.worktrees ?? {},
			)) {
				const root = git(path, "rev-parse", "--show-toplevel");
				if (!owned.has(root))
					owned.set(root, {
						folder,
						branch: git(root, "branch", "--show-current"),
						sessionId,
					});
			}
			return {
				id: sessionId,
				path: session.workspace?.worktrees[fixture.projectDir],
				session,
			};
		};
		const inspect = async (id: string, projectSlug = "process-test") => {
			const refs = folders.map((folder) => git(folder, "show-ref"));
			const result = await sendRpcRequest(
				socket,
				new InspectSessionWorktrees({ projectSlug, sessionId: id }),
			);
			expect(folders.map((folder) => git(folder, "show-ref"))).toEqual(refs);
			evidence["inspection"] = result;
			return result;
		};
		const state = () => {
			const db = new Database(fixture.projectStorePath(), { readonly: true });
			try {
				return {
					sessions: db
						.prepare("SELECT id, title, workspace FROM sessions ORDER BY id")
						.all(),
					deletions: db
						.prepare(
							"SELECT session_id, data FROM events WHERE type = 'session.deleted' ORDER BY sequence",
						)
						.all(),
					worktrees: [...owned].map(([path, { folder, branch }]) => ({
						folder,
						path,
						branch,
						exists: existsSync(path),
						...(existsSync(path)
							? {
									dirty: git(path, "status", "--porcelain"),
									checkedOutBranch: git(path, "branch", "--show-current"),
								}
							: {}),
						refs: git(folder, "show-ref"),
						registered: git(folder, "worktree", "list", "--porcelain"),
					})),
				};
			} finally {
				db.close();
			}
		};
		const remove = async (id: string, removeWorktrees?: boolean) => {
			const manifest = {
				payload: {
					_tag: "DeleteSession",
					projectSlug: "process-test",
					sessionId: id,
					...(removeWorktrees === undefined ? {} : { removeWorktrees }),
				},
				before: state(),
				response: undefined as unknown,
				after: undefined as unknown,
			};
			(evidence["deletions"] as unknown[]).push(manifest);
			mkdirSync("test-results", { recursive: true });
			const artifact = `test-results/q5u6-9-delete-${scenario}-${(evidence["deletions"] as unknown[]).length}`;
			writeFileSync(
				`${artifact}-before.json`,
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			const response = await sendRpcRequest(
				socket,
				new DeleteSession(manifest.payload),
			);
			manifest.response = response;
			manifest.after = state();
			writeFileSync(
				`${artifact}-after.json`,
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			expect(response.ok).toBe(true);
			expect(
				(await sessions()).some(({ id: sessionId }) => sessionId === id),
			).toBe(false);
			const db = new Database(fixture.projectStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM events WHERE type = 'session.deleted' AND session_id = ?",
						)
						.get(id),
				).toEqual({ count: 1 });
			} finally {
				db.close();
			}
			return response;
		};
		return { fixture, socket, create, inspect, remove, sessions };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length)
			evidence["logs"] = fixture.logTail.slice(-4_000);
		try {
			await fixture.dispose();
			fixture.assertNoRunners();
		} finally {
			mkdirSync("test-results", { recursive: true });
			let artifact = JSON.stringify(evidence, null, 2)
				.replaceAll(fixture.root.replace(/^\/tmp\//, "/private/tmp/"), "<root>")
				.replaceAll(fixture.root, "<root>");
			for (const [id, title] of names)
				artifact = artifact.replaceAll(id, `<session:${title}>`);
			for (const { branch, sessionId } of owned.values())
				artifact = artifact.replaceAll(
					branch,
					`<branch:${names.get(sessionId) ?? sessionId}>`,
				);
			writeFileSync(
				`test-results/q5u6-9-delete-${scenario}.json`,
				`${artifact}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("removes clean merged launch worktrees and their branches by default", async () => {
		const { fixture, create, inspect, remove } = await start("clean");
		const session = await create("Clean");
		if (!session.path) throw new Error("Missing worktree");
		const branch = git(session.path, "branch", "--show-current");
		expect(await inspect(session.id)).toEqual({
			worktrees: [
				{
					folder: fixture.projectDir,
					path: session.path,
					reasons: [],
					inUse: false,
				},
			],
			removeWorktrees: true,
		});
		await remove(session.id);
		expect(existsSync(session.path)).toBe(false);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toBe("");
	});

	it.each([
		"uncommitted",
		"unpushed",
		"unmerged",
	] as const)("defaults to Keep for independent %s work, naming its folder and reason", async (reason) => {
		const { fixture, create, inspect, remove } = await start(reason);
		const session = await create(reason);
		if (!session.path) throw new Error("Missing worktree");
		if (reason === "uncommitted")
			writeFileSync(join(session.path, "unfinished.txt"), "unfinished\n");
		else {
			commit(session.path);
			const branch = git(session.path, "branch", "--show-current");
			// Work merged into a default branch is safe to remove, so "unpushed"
			// means commits that exist only on the session branch.
			if (reason === "unmerged")
				git(session.path, "push", "-u", "origin", branch);
		}
		const result = await inspect(session.id);
		expect(result.removeWorktrees).toBe(false);
		expect(result.worktrees).toEqual([
			{
				folder: fixture.projectDir,
				path: session.path,
				reasons:
					reason === "uncommitted"
						? ["Uncommitted changes"]
						: reason === "unpushed"
							? [
									"Unpushed commits",
									"Commits not merged into the default branch",
								]
							: ["Commits not merged into the default branch"],
				inUse: false,
			},
		]);
		await remove(session.id);
		expect(existsSync(session.path)).toBe(true);
	});

	it("does not count an unchanged chosen launch base without an upstream as unpushed", async () => {
		const { fixture, create, inspect, remove } = await start("chosen-base");
		git(fixture.projectDir, "branch", "chosen-base");
		commit(fixture.projectDir, "New main commit");
		const session = await create("Chosen", true, "chosen-base");
		expect((await inspect(session.id)).removeWorktrees).toBe(true);
		await remove(session.id);
		expect(session.path && existsSync(session.path)).toBe(false);
	});

	it.each([
		"main",
		"master",
	])("falls back to local %s without a remote HEAD", async (branch) => {
		const { fixture, create, inspect, remove } = await start(
			`fallback-${branch}`,
			{ branch },
		);
		git(
			fixture.projectDir,
			"symbolic-ref",
			"--delete",
			"refs/remotes/origin/HEAD",
		);
		const session = await create("Fallback");
		expect((await inspect(session.id)).removeWorktrees).toBe(true);
		await remove(session.id);
		expect(session.path && existsSync(session.path)).toBe(false);
	});

	it("keeps when no default branch resolves", async () => {
		const { fixture, create, inspect, remove } = await start(
			"unknown-default",
			{ branch: "trunk" },
		);
		git(
			fixture.projectDir,
			"symbolic-ref",
			"--delete",
			"refs/remotes/origin/HEAD",
		);
		const session = await create("Unknown");
		expect(await inspect(session.id)).toMatchObject({
			removeWorktrees: false,
			worktrees: [{ reasons: ["Unknown default branch"] }],
		});
		await remove(session.id);
		expect(session.path && existsSync(session.path)).toBe(true);
	});

	it.each([
		false,
		true,
	])("refuses dirty explicit removal without force, dirtied after inspection: %s", async (afterInspection) => {
		const { fixture, create, inspect, remove } = await start(
			`dirty-${afterInspection}`,
			{ shim: true },
		);
		const session = await create("Dirty");
		if (!session.path) throw new Error("Missing worktree");
		if (afterInspection)
			expect((await inspect(session.id)).removeWorktrees).toBe(true);
		writeFileSync(join(session.path, "unfinished.txt"), "keep this\n");
		if (!afterInspection) await inspect(session.id);
		const response = await remove(session.id, true);
		expect(response.worktreeWarnings?.join(" ")).toMatch(/uncommitted/i);
		expect(readFileSync(join(session.path, "unfinished.txt"), "utf8")).toBe(
			"keep this\n",
		);
		const calls = join(fixture.root, "git-removals.jsonl");
		expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").not.toContain(
			"--force",
		);
	});

	it("treats a checkout already removed through Git as a no-op", async () => {
		const { fixture, create, inspect, remove } = await start("gone");
		const session = await create("Gone");
		if (!session.path) throw new Error("Missing worktree");
		await inspect(session.id);
		git(fixture.projectDir, "worktree", "remove", session.path);
		expect((await remove(session.id, true)).worktreeWarnings ?? []).toEqual([]);
	});

	it("keeps a parent's checkout shared by its fork even after the deletion cascade", async () => {
		const { fixture, socket, create, inspect, remove } =
			await start("fork-in-use");
		const parent = await create("Parent");
		await inspect(parent.id);
		const browser = await fixture.connect(parent.id);
		await browser.send(parent.id, "Reply with pong.");
		const fork = await sendRpcRequest(
			socket,
			new ForkSession({
				projectSlug: "process-test",
				sessionId: parent.id,
				originId: browser.originId,
			}),
		);
		names.set(fork.sessionId, "Fork");
		expect(await inspect(parent.id)).toMatchObject({
			removeWorktrees: false,
			worktrees: [{ inUse: true }],
		});
		expect(await inspect(fork.sessionId)).toEqual({
			worktrees: [],
			removeWorktrees: true,
		});
		await remove(parent.id, true);
		expect(parent.path && existsSync(parent.path)).toBe(true);
	});

	it("rechecks usage from a session in another project before cleanup", async () => {
		const { fixture, socket, create, inspect, remove, sessions } = await start(
			"cross-project-in-use",
		);
		const session = await create("Owner");
		if (!session.path) throw new Error("Missing worktree");
		expect((await inspect(session.id)).removeWorktrees).toBe(true);
		const secondary = join(fixture.root, "other-project");
		mkdirSync(secondary);
		seed(fixture, secondary);
		const project = await sendRpcRequest(
			socket,
			new SaveProject({
				folders: [secondary, fixture.projectDir],
			}),
		);
		const other = await create("Other", false, undefined, project.savedSlug);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: project.savedSlug,
				sessionId: other.id,
				path: session.path,
			}),
		);
		expect(await inspect(session.id)).toMatchObject({
			removeWorktrees: false,
			worktrees: [{ inUse: true }],
		});
		await remove(session.id, true);
		expect(existsSync(session.path)).toBe(true);
		expect((await sessions()).some(({ id }) => id === other.id)).toBe(true);
	});

	it("never offers an existing checkout entered by a user", async () => {
		const { fixture, socket, create, inspect, remove } =
			await start("existing-user");
		const existing = join(fixture.root, "existing");
		git(fixture.projectDir, "worktree", "add", "-b", "user/branch", existing);
		const session = await create("Existing", false);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: session.id,
				path: realpathSync(existing),
			}),
		);
		expect(await inspect(session.id)).toEqual({
			worktrees: [],
			removeWorktrees: true,
		});
		await remove(session.id, true);
		expect(existsSync(existing)).toBe(true);
	});

	it("never offers an existing checkout entered by the agent", async () => {
		const { fixture, create, inspect, remove, sessions } = await start(
			"existing-agent",
			{ agent: true },
		);
		const session = await create("Agent", false);
		const browser = await fixture.connect(session.id);
		await browser.send(session.id, "Enter a worktree.");
		const path = join(fixture.projectDir, ".claude", "worktrees", "contract");
		expect(
			(await sessions()).find(({ id }) => id === session.id)?.workspace
				?.worktrees[fixture.projectDir],
		).toBe(path);
		expect(await inspect(session.id)).toEqual({
			worktrees: [],
			removeWorktrees: true,
		});
		await remove(session.id, true);
		expect(existsSync(path)).toBe(true);
	});

	it("retains launch ownership after the agent enters an existing checkout", async () => {
		const { fixture, create, inspect, remove, sessions } = await start(
			"owned-agent-move",
			{ agent: true },
		);
		const session = await create("Agent moved");
		const browser = await fixture.connect(session.id);
		await browser.send(session.id, "Enter a worktree.");
		const existing = join(
			fixture.projectDir,
			".claude",
			"worktrees",
			"contract",
		);
		expect(
			(await sessions()).find(({ id }) => id === session.id)?.workspace
				?.worktrees[fixture.projectDir],
		).toBe(existing);
		expect(
			(await inspect(session.id)).worktrees.map(({ path }) => path),
		).toEqual([session.path]);
		await remove(session.id, true);
		expect(session.path && existsSync(session.path)).toBe(false);
		expect(existsSync(existing)).toBe(true);
	});

	it("conservatively recovers legacy launch ownership from the exact path and creation reflog", async () => {
		const { fixture, create, inspect, remove } = await start("legacy");
		const session = await create("Legacy");
		await fixture.kill();
		const db = new Database(fixture.projectStorePath());
		try {
			db.prepare(
				"UPDATE events SET data = json_remove(data, '$.ownership') WHERE type = 'session.workspace_changed' AND session_id = ?",
			).run(session.id);
		} finally {
			db.close();
		}
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect((await inspect(session.id)).worktrees).toHaveLength(1);
		await remove(session.id);
		expect(session.path && existsSync(session.path)).toBe(false);
	});

	it("retains original launch ownership after a move, folder detach, and restart", async () => {
		const { fixture, socket, create, inspect, remove } = await start(
			"move-detach-restart",
			{ multi: true },
		);
		const session = await create("Moved");
		const original = [...owned.keys()];
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: session.id,
				path: fixture.projectDir,
			}),
		);
		await sendRpcRequest(
			socket,
			new SaveProject({ slug: "process-test", folders: [fixture.projectDir] }),
		);
		await fixture.kill();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(
			(await inspect(session.id)).worktrees.map(({ path }) => path).sort(),
		).toEqual(original.sort());
		await remove(session.id);
		for (const path of original) expect(existsSync(path)).toBe(false);
	});

	it("inspects every independent folder and deduplicates a shared root", async () => {
		const { fixture, create, inspect, remove } = await start("multi-shared", {
			multi: true,
			shared: true,
		});
		const session = await create("Multi");
		const paths = [...owned.keys()];
		expect(paths).toHaveLength(2);
		const library = paths.find(
			(path) => owned.get(path)?.folder !== fixture.projectDir,
		);
		if (!library) throw new Error("Missing library checkout");
		writeFileSync(join(library, "unfinished.txt"), "unfinished\n");
		const result = await inspect(session.id);
		expect(result.worktrees).toHaveLength(2);
		expect(result.removeWorktrees).toBe(false);
		expect(result.worktrees.find(({ path }) => path === library)).toMatchObject(
			{
				folder: join(fixture.root, "library"),
				reasons: ["Uncommitted changes"],
			},
		);
		await remove(session.id);
		for (const path of paths) expect(existsSync(path)).toBe(true);
	});

	it("reports and logs failed Git removal after committing deletion and keeps the branch", async () => {
		const { fixture, create, inspect, remove } = await start("remove-failure", {
			shim: true,
		});
		const session = await create("Failure");
		if (!session.path) throw new Error("Missing worktree");
		const branch = git(session.path, "branch", "--show-current");
		await inspect(session.id);
		writeFileSync(join(fixture.root, "fail-remove"), "fail\n");
		expect((await remove(session.id)).worktreeWarnings?.join(" ")).toMatch(
			/forced worktree removal failure/,
		);
		expect(fixture.logTail).toContain("forced worktree removal failure");
		expect(existsSync(session.path)).toBe(true);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toContain(
			branch,
		);
	});

	it("keeps an unmerged Conduit branch after explicit checkout removal", async () => {
		const { fixture, create, inspect, remove } =
			await start("unmerged-explicit");
		const session = await create("Unmerged");
		if (!session.path) throw new Error("Missing worktree");
		commit(session.path);
		const branch = git(session.path, "branch", "--show-current");
		await inspect(session.id);
		await remove(session.id, true);
		expect(existsSync(session.path)).toBe(false);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toContain(
			branch,
		);
	});

	it("keeps detached unmerged commits on explicit removal and reports them after canonical deletion", async () => {
		const { fixture, create, inspect, remove } =
			await start("detached-unmerged");
		const session = await create("Detached unmerged");
		if (!session.path) throw new Error("Missing worktree");
		const branch = git(session.path, "branch", "--show-current");
		git(session.path, "switch", "--detach");
		commit(session.path, "Detached unfinished work");
		const head = git(session.path, "rev-parse", "HEAD");
		expect(git(session.path, "status", "--porcelain")).toBe("");
		expect(git(session.path, "branch", "--show-current")).toBe("");
		expect((await inspect(session.id)).removeWorktrees).toBe(false);
		const response = await remove(session.id, true);
		expect(response.worktreeWarnings?.join(" ")).toMatch(/detached commits/i);
		expect(existsSync(session.path)).toBe(true);
		expect(git(session.path, "rev-parse", "HEAD")).toBe(head);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toContain(
			branch,
		);
	});

	it("removes a detached checkout whose commits are merged into the default branch", async () => {
		const { fixture, create, inspect, remove } = await start("detached-merged");
		const session = await create("Detached merged");
		if (!session.path) throw new Error("Missing worktree");
		const branch = git(session.path, "branch", "--show-current");
		git(session.path, "switch", "--detach");
		commit(session.path, "Detached completed work");
		const head = git(session.path, "rev-parse", "HEAD");
		git(fixture.projectDir, "merge", "--ff-only", head);
		git(fixture.projectDir, "push", "origin", "main");
		await inspect(session.id);
		expect((await remove(session.id, true)).worktreeWarnings ?? []).toEqual([]);
		expect(existsSync(session.path)).toBe(false);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toBe("");
		expect(git(fixture.projectDir, "rev-parse", "main")).toBe(head);
	});

	it("keeps a detached checkout when no default branch can prove its commits merged", async () => {
		const { fixture, create, inspect, remove } = await start(
			"detached-unknown-default",
			{ branch: "trunk" },
		);
		const session = await create("Detached unknown");
		if (!session.path) throw new Error("Missing worktree");
		const branch = git(session.path, "branch", "--show-current");
		git(
			fixture.projectDir,
			"symbolic-ref",
			"--delete",
			"refs/remotes/origin/HEAD",
		);
		git(session.path, "switch", "--detach");
		await inspect(session.id);
		expect(
			(await remove(session.id, true)).worktreeWarnings?.join(" "),
		).toMatch(/detached commits/i);
		expect(existsSync(session.path)).toBe(true);
		expect(git(fixture.projectDir, "branch", "--list", branch)).toContain(
			branch,
		);
	});

	it("preserves a user branch checked out inside an owned checkout", async () => {
		const { fixture, create, inspect, remove } = await start("user-branch");
		const session = await create("User branch");
		if (!session.path) throw new Error("Missing worktree");
		git(session.path, "switch", "-c", "user/kept");
		await inspect(session.id);
		await remove(session.id, true);
		expect(existsSync(session.path)).toBe(false);
		expect(git(fixture.projectDir, "branch", "--list", "user/kept")).toContain(
			"user/kept",
		);
	});
});
