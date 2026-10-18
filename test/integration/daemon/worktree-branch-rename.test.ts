/*
 * Branch rename cases, written before implementation:
 * - Rename a launch-owned two-repository session in both folders and refresh git status immediately.
 * - Invalid ref names leave both branches unchanged and name the folder and reason.
 * - A name taken only in the second repository changes neither branch.
 * - A missing second checkout changes neither branch.
 * - HEAD moved off the owned branch in either checkout changes neither branch.
 * - A second Git rename failure rolls back the first rename.
 * - A held second worktree HEAD.lock restores refs even when Git changes the ref before failing.
 * - A substitute checkout from another repository at the owned path is rejected without touching either repository.
 * - Concurrent deletion waits for a pending rename and removes both renamed branches and checkouts.
 * - A failed canonical append restores Git and permits a retry with unchanged ownership.
 * - A session moved into an existing worktree, or a fork, has no launch ownership and is rejected.
 * - Renaming to the current name succeeds without changing Git or recording another event.
 * - A subsequent rename reads updated ownership; deletion removes the renamed branches when merged.
 * - An owned branch can become a parent or child ref name when no other branch conflicts.
 * - Branch renames preserve workspace paths, cause, and pending user moves.
 * Write every folder's refs and HEAD before and after each rename, including failures.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RenameSessionBranch,
	type SessionInfo,
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

function commit(directory: string, message: string) {
	git(directory, "add", ".");
	git(
		directory,
		"-c",
		"user.name=Branch rename test",
		"-c",
		"user.email=rename@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-m",
		message,
	);
}

describe("Worktree branch rename through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	let folders: string[] = [];
	const worktrees = new Map<
		string,
		{ sessionId: string; folder: string; path: string }
	>();

	function seed(fixture: ProcessHarness, directory: string) {
		mkdirSync(directory, { recursive: true });
		git(directory, "init", "-b", "main");
		mkdirSync(join(directory, "subfolder"));
		writeFileSync(join(directory, "subfolder", "base.txt"), "committed base\n");
		commit(directory, "Initial commit");
		const remote = `${directory}-origin.git`;
		git(fixture.root, "init", "--bare", remote);
		git(directory, "remote", "add", "origin", remote);
		git(directory, "push", "-u", "origin", "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
		);
	}

	async function start(
		name: string,
		options: { shim?: boolean; shared?: boolean } = {},
	) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		worktrees.clear();
		harness = ProcessHarness.create();
		const fixture = harness;
		const secondary = join(fixture.root, "library");
		seed(fixture, fixture.projectDir);
		seed(fixture, secondary);
		folders = [
			fixture.projectDir,
			...(options.shared ? [join(fixture.projectDir, "subfolder")] : []),
			secondary,
		];
		writeFileSync(
			join(fixture.root, "claude", "conduit-test-record-forks"),
			"record\n",
		);
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
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const branch = args.indexOf("branch");
if (branch >= 0 && args[branch + 1] === "-m") {
  const directory = args[0] === "-C" ? args[1] : process.cwd();
  const common = spawnSync(${JSON.stringify(realGit)}, ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
  const folder = common === ${JSON.stringify(join(secondary, ".git"))} ? ${JSON.stringify(secondary)} : ${JSON.stringify(fixture.projectDir)};
  const [oldName, newName] = args.slice(branch + 2).filter(arg => arg !== "--");
  const marker = ${JSON.stringify(join(fixture.root, "fail-rename"))};
  const failed = folder === ${JSON.stringify(secondary)} && existsSync(marker) && newName === readFileSync(marker, "utf8").trim();
  appendFileSync(${JSON.stringify(join(fixture.root, "git-renames.jsonl"))}, JSON.stringify({ folder, oldName, newName, failed }) + "\\n");
  if (failed) {
    process.stderr.write("forced second repository branch rename failure\\n");
    process.exit(1);
  }
  const pause = ${JSON.stringify(join(fixture.root, "pause-rename"))};
  if (folder === ${JSON.stringify(secondary)} && existsSync(pause) && newName === readFileSync(pause, "utf8").trim()) {
    writeFileSync(${JSON.stringify(join(fixture.root, "rename-paused"))}, JSON.stringify({ folder, oldName, newName }));
    const release = ${JSON.stringify(join(fixture.root, "release-rename"))};
    const deadline = Date.now() + 20_000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(release)) {
      if (Date.now() > deadline) {
        process.stderr.write("timed out waiting for branch rename test release\\n");
        process.exit(1);
      }
      Atomics.wait(wait, 0, 0, 10);
    }
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
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders,
		});
		const sessions = async () =>
			(
				await sendRpcRequest(socket, {
					_tag: "ListDaemonSessions",
					scope: "process-test",
					roots: false,
				})
			).sessions;
		const find = async (id: string) => {
			const session = (await sessions()).find((row) => row.id === id);
			if (!session) throw new Error(`Session ${id} was not listed`);
			return session;
		};
		const create = async (title: string, newWorktree = true) => {
			const { sessionId } = await sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				projectSlug: "process-test",
				originId: "worktree-branch-rename-test",
				providerId: "claude",
				title,
				...(newWorktree ? { newWorktree: true } : {}),
			});
			const session = await find(sessionId);
			for (const [folder, path] of Object.entries(
				session.workspace?.worktrees ?? {},
			))
				worktrees.set(`${sessionId}:${folder}`, { sessionId, folder, path });
			return session;
		};
		const state = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				const events = db
					.prepare(
						"SELECT sequence, session_id, data FROM events WHERE project_id = 'process-test' AND type = 'session.workspace_changed' ORDER BY sequence",
					)
					.all() as {
					sequence: number;
					session_id: string;
					data: string;
				}[];
				return {
					sessions: db
						.prepare(
							"SELECT id, title, workspace FROM sessions WHERE project_id = 'process-test' ORDER BY id",
						)
						.all(),
					workspaceEvents: events.map(({ sequence, session_id, data }) => ({
						sequence,
						sessionId: session_id,
						data: JSON.parse(data) as Record<string, unknown>,
					})),
					repositories: folders.map((folder) => ({
						folder,
						branches: git(
							folder,
							"for-each-ref",
							"--format=%(refname:short) %(objectname)",
							"refs/heads",
						).split("\n"),
						head: git(folder, "rev-parse", "HEAD"),
						branch: git(folder, "branch", "--show-current"),
						registeredWorktrees: git(folder, "worktree", "list", "--porcelain"),
					})),
					worktrees: [...worktrees.values()].map((worktree) => {
						const exists = existsSync(worktree.path);
						let head: string | null = null;
						let headError: string | undefined;
						if (exists) {
							try {
								head = git(worktree.path, "rev-parse", "HEAD");
							} catch (error) {
								headError = String(error);
							}
						}
						return {
							...worktree,
							exists,
							branch: exists
								? git(worktree.path, "branch", "--show-current")
								: null,
							head,
							...(headError === undefined ? {} : { headError }),
						};
					}),
				};
			} finally {
				db.close();
			}
		};
		const manifests: {
			payload: {
				_tag: "RenameSessionBranch";
				projectSlug: string;
				sessionId: string;
				branchName: string;
			};
			before: ReturnType<typeof state>;
			after?: ReturnType<typeof state>;
			response?: unknown;
			error?: unknown;
		}[] = [];
		evidence["renames"] = manifests;
		const rename = async (sessionId: string, branchName: string) => {
			const manifest: (typeof manifests)[number] = {
				payload: {
					_tag: "RenameSessionBranch",
					projectSlug: "process-test",
					sessionId,
					branchName,
				},
				before: state(),
			};
			manifests.push(manifest);
			mkdirSync("test-results", { recursive: true });
			const artifact = `test-results/q5u6-5-rename-${scenario}-${manifests.length}`;
			writeFileSync(
				`${artifact}-before.json`,
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			try {
				const response = await sendRpcRequest(
					socket,
					new RenameSessionBranch(manifest.payload),
					{ requestTimeoutMs: 30_000 },
				);
				manifest.response = response;
				return response;
			} catch (error) {
				manifest.error =
					error instanceof Error ? { ...error, message: error.message } : error;
				throw error;
			} finally {
				manifest.after = state();
				writeFileSync(
					`${artifact}-after.json`,
					`${JSON.stringify(manifest, null, 2)}\n`,
				);
			}
		};
		return {
			fixture,
			socket,
			secondary,
			create,
			find,
			sessions,
			state,
			rename,
		};
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
			evidence["cleanup"] = "no fixture runners remain";
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/q5u6-5-rename-${scenario}.json`,
				`${JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	function checkout(session: SessionInfo, folder: string) {
		const path = session.workspace?.worktrees[folder];
		if (!path) throw new Error(`Session has no worktree for ${folder}`);
		return path;
	}

	it("renames an owned branch to a child ref and back to its parent ref", async () => {
		const { fixture, secondary, create, rename } = await start(
			"source-ref-namespace",
		);
		const session = await create("Namespace rename");
		const original = git(
			checkout(session, fixture.projectDir),
			"branch",
			"--show-current",
		);
		for (const branchName of [`${original}/nested`, original]) {
			expect(await rename(session.id, branchName)).toEqual({ ok: true });
			for (const folder of [fixture.projectDir, secondary])
				expect(git(checkout(session, folder), "branch", "--show-current")).toBe(
					branchName,
				);
		}
	}, 300_000);

	it("restores both branches when the canonical append fails and permits a retry", async () => {
		const { fixture, create, state, rename } = await start(
			"event-write-failure",
		);
		const session = await create("Append failure");
		const db = new Database(fixture.daemonStorePath());
		db.exec(`CREATE TRIGGER fail_branch_rename BEFORE INSERT ON events
			WHEN NEW.type = 'session.workspace_changed' AND json_extract(NEW.data, '$.cause') = 'branch-rename'
			BEGIN SELECT RAISE(FAIL, 'forced canonical append failure'); END`);
		try {
			const before = state();
			await expect(
				rename(session.id, "feature/append-failure"),
			).rejects.toMatchObject({ _tag: "WsRpcError" });
			expect(state()).toEqual(before);
		} finally {
			db.exec("DROP TRIGGER fail_branch_rename");
			db.close();
		}
		expect(await rename(session.id, "feature/append-retry")).toEqual({
			ok: true,
		});
	}, 300_000);

	it("renames both branches, publishes fresh git rows, and retains ownership through another rename and restart", async () => {
		const { fixture, secondary, create, find, state, rename } =
			await start("both-folders");
		const session = await create("Two folders");
		expect(session.canRenameBranch).toBe(true);
		const oldName = git(
			checkout(session, fixture.projectDir),
			"branch",
			"--show-current",
		);
		const before = state();
		const browser = await fixture.connect(session.id);
		await browser.followFamily(session.id);
		const cursor = browser.frames.length;
		const branchName = "feature/renamed-session";
		expect(await rename(session.id, branchName)).toEqual({ ok: true });
		const current = await find(session.id);
		expect(current.workspace).toEqual(session.workspace);
		expect(current.git?.branch).toBe(branchName);
		expect(current.git?.folders?.map(({ branch }) => branch)).toEqual([
			branchName,
			branchName,
		]);
		const row = await browser.waitFor(
			(message) => {
				if (message["type"] !== "session_row" || message["id"] !== session.id)
					return false;
				const status = message["git"] as SessionInfo["git"];
				return status?.branch === branchName;
			},
			cursor,
			2_000,
		);
		evidence["publishedGitRow"] = row;
		expect(row["canRenameBranch"]).toBe(true);
		for (const folder of [fixture.projectDir, secondary]) {
			expect(git(checkout(session, folder), "branch", "--show-current")).toBe(
				branchName,
			);
			expect(git(folder, "branch", "--list", oldName)).toBe("");
			expect(git(folder, "branch", "--show-current")).toBe("main");
		}
		const after = state();
		expect(after.worktrees.map(({ head }) => head)).toEqual(
			before.worktrees.map(({ head }) => head),
		);
		expect(after.workspaceEvents).toHaveLength(
			before.workspaceEvents.length + 1,
		);
		expect(after.workspaceEvents.at(-1)?.data).toMatchObject({
			cause: "branch-rename",
			ownership: [
				{
					folder: fixture.projectDir,
					path: checkout(session, fixture.projectDir),
					branchName,
					head: before.worktrees[0]?.head,
				},
				{
					folder: secondary,
					path: checkout(session, secondary),
					branchName,
					head: before.worktrees[1]?.head,
				},
			],
		});
		await browser.close();
		await fixture.terminate();
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const nextName = "feature/renamed-after-restart";
		expect(await rename(session.id, nextName)).toEqual({ ok: true });
		expect((await find(session.id)).workspace).toEqual(session.workspace);
		expect((await find(session.id)).git?.branch).toBe(nextName);
		for (const folder of [fixture.projectDir, secondary]) {
			expect(git(checkout(session, folder), "branch", "--show-current")).toBe(
				nextName,
			);
			expect(git(folder, "branch", "--list", branchName)).toBe("");
		}
		expect(state().workspaceEvents.at(-1)?.data).toMatchObject({
			cause: "branch-rename",
			ownership: [
				expect.objectContaining({ branchName: nextName }),
				expect.objectContaining({ branchName: nextName }),
			],
		});
	}, 300_000);

	it("rejects invalid names, empty names, options, and revision expansions before changing either folder", async () => {
		const { fixture, create, state, rename } = await start("invalid-names", {
			shim: true,
		});
		const session = await create("Invalid names");
		// A real previous checkout proves @{-1} is rejected as input rather than
		// accepted through Git's previous-branch expansion.
		git(fixture.projectDir, "switch", "-c", "previous");
		git(fixture.projectDir, "switch", "main");
		for (const branchName of ["bad..name", "", "-option", "@{-1}"]) {
			const before = state();
			await expect(rename(session.id, branchName)).rejects.toMatchObject({
				_tag: "WorktreeBranchRenameError",
				folder: fixture.projectDir,
				reason: "invalid-name",
				message: expect.stringMatching(/invalid|branch name/i),
			});
			expect(state()).toEqual(before);
			expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
		}
	}, 300_000);

	it("leaves both branches unchanged when the name is taken only in the second repository", async () => {
		const { fixture, secondary, create, state, rename } = await start(
			"second-name-taken",
			{ shim: true },
		);
		const session = await create("Taken name");
		const branchName = "feature/already-taken";
		git(secondary, "branch", branchName);
		expect(git(fixture.projectDir, "branch", "--list", branchName)).toBe("");
		const before = state();
		await expect(rename(session.id, branchName)).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: secondary,
			reason: "already-exists",
			message: expect.stringMatching(/already|exists/i),
		});
		expect(state()).toEqual(before);
		expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
	}, 300_000);

	it("leaves both branches unchanged when the second checkout was deleted on disk", async () => {
		const { fixture, secondary, create, state, rename } = await start(
			"second-checkout-missing",
			{ shim: true },
		);
		const session = await create("Missing checkout");
		rmSync(checkout(session, secondary), { recursive: true, force: true });
		const before = state();
		await expect(rename(session.id, "feature/missing")).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: secondary,
			reason: "worktree-missing",
			message: expect.stringMatching(/missing|does not exist/i),
		});
		expect(state()).toEqual(before);
		expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
	}, 300_000);

	it.each([
		"detached",
		"different-branch",
	])("rejects a second checkout with %s HEAD without changing either repository", async (mode) => {
		const { fixture, secondary, create, state, rename } = await start(
			`head-${mode}`,
			{ shim: true },
		);
		const session = await create("Moved HEAD");
		const path = checkout(session, secondary);
		if (mode === "detached") git(path, "switch", "--detach");
		else git(path, "switch", "-c", "external/branch");
		const before = state();
		await expect(
			rename(session.id, "feature/head-mismatch"),
		).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: secondary,
			reason: "head-mismatch",
			message: expect.stringMatching(/HEAD|owned branch/i),
		});
		expect(state()).toEqual(before);
		expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
	}, 300_000);

	it("rolls back the first repository when Git fails while renaming the second", async () => {
		const { fixture, secondary, create, state, rename } = await start(
			"second-git-failure",
			{ shim: true },
		);
		const session = await create("Rollback");
		const oldName = git(
			checkout(session, fixture.projectDir),
			"branch",
			"--show-current",
		);
		const branchName = "feature/rollback";
		writeFileSync(join(fixture.root, "fail-rename"), branchName);
		const before = state();
		await expect(rename(session.id, branchName)).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: secondary,
			reason: "git-failed",
			message: expect.stringContaining(
				"forced second repository branch rename failure",
			),
		});
		expect(state()).toEqual(before);
		const attempts = readFileSync(
			join(fixture.root, "git-renames.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		evidence["gitRenameAttempts"] = attempts;
		expect(attempts).toEqual([
			{
				folder: fixture.projectDir,
				oldName,
				newName: branchName,
				failed: false,
			},
			{ folder: secondary, oldName, newName: branchName, failed: true },
			{
				folder: fixture.projectDir,
				oldName: branchName,
				newName: oldName,
				failed: false,
			},
		]);
	}, 300_000);

	it("restores every ref when a held second worktree HEAD.lock makes Git fail after changing its branch ref", async () => {
		const { secondary, create, state, rename } =
			await start("second-head-lock");
		const session = await create("Partial Git rename");
		const path = checkout(session, secondary);
		const lock = `${git(path, "rev-parse", "--path-format=absolute", "--git-path", "HEAD")}.lock`;
		writeFileSync(lock, "held by branch rename test\n", { flag: "wx" });
		evidence["heldHeadLock"] = lock;
		const before = state();
		try {
			await expect(
				rename(session.id, "feature/head-lock"),
			).rejects.toMatchObject({
				_tag: "WorktreeBranchRenameError",
				folder: secondary,
				reason: "git-failed",
				message: expect.stringContaining("HEAD.lock"),
			});
			expect(state()).toEqual(before);
			expect(existsSync(lock)).toBe(true);
			evidence["headLockExistsAfterFailure"] = true;
		} finally {
			rmSync(lock, { force: true });
		}
	}, 300_000);

	it("rejects an unrelated repository's checkout substituted at the owned path even on the same branch name", async () => {
		const { fixture, secondary, create, state, rename } = await start(
			"substitute-repository",
			{ shim: true },
		);
		const session = await create("Substitute checkout");
		const path = checkout(session, secondary);
		const oldName = git(path, "branch", "--show-current");
		const unrelated = join(fixture.root, "unrelated");
		seed(fixture, unrelated);
		git(secondary, "worktree", "remove", path);
		git(unrelated, "worktree", "add", "-b", oldName, path);
		folders.push(unrelated);
		evidence["substituteRepository"] = unrelated;
		expect(git(path, "branch", "--show-current")).toBe(oldName);
		expect(
			git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
		).toBe(join(unrelated, ".git"));
		expect(
			git(secondary, "rev-parse", "--path-format=absolute", "--git-common-dir"),
		).toBe(join(secondary, ".git"));
		const before = state();
		await expect(
			rename(session.id, "feature/substitute"),
		).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: secondary,
			reason: "not-owned",
			message: expect.stringMatching(/repository|belong|ownership|owned/i),
		});
		expect(state()).toEqual(before);
		expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
		for (const folder of [fixture.projectDir, secondary, unrelated]) {
			expect(git(folder, "branch", "--list", oldName)).not.toBe("");
			expect(git(folder, "branch", "--list", "feature/substitute")).toBe("");
		}
	}, 300_000);

	it("serializes deletion with a rename paused before the second Git mutation", async () => {
		const { fixture, secondary, create, sessions, state, rename } = await start(
			"concurrent-delete",
			{ shim: true },
		);
		const session = await create("Concurrent rename and delete");
		const primaryPath = checkout(session, fixture.projectDir);
		const secondaryPath = checkout(session, secondary);
		const oldName = git(primaryPath, "branch", "--show-current");
		const branchName = "feature/concurrent-delete";
		const browser = await fixture.connect(session.id);
		writeFileSync(join(fixture.root, "pause-rename"), branchName);
		const renamed = rename(session.id, branchName).then(
			(response) => ({ response }),
			(error: unknown) => ({ error }),
		);
		let pendingDelete: Promise<unknown> | undefined;
		let deletionManifest:
			| {
					payload: {
						_tag: "DeleteSession";
						projectSlug: string;
						sessionId: string;
						removeWorktrees: boolean;
					};
					before: ReturnType<typeof state>;
					after?: ReturnType<typeof state>;
					result?: unknown;
			  }
			| undefined;
		const artifact = `test-results/q5u6-5-rename-${scenario}-delete`;
		try {
			await vi.waitFor(
				() =>
					expect(existsSync(join(fixture.root, "rename-paused"))).toBe(true),
				{ timeout: 15_000, interval: 25 },
			);
			evidence["pausedRename"] = JSON.parse(
				readFileSync(join(fixture.root, "rename-paused"), "utf8"),
			) as Record<string, unknown>;
			expect(git(primaryPath, "branch", "--show-current")).toBe(branchName);
			expect(git(secondaryPath, "branch", "--show-current")).toBe(oldName);
			deletionManifest = {
				payload: {
					_tag: "DeleteSession",
					projectSlug: "process-test",
					sessionId: session.id,
					removeWorktrees: true,
				},
				before: state(),
			};
			evidence["concurrentDeletion"] = deletionManifest;
			writeFileSync(
				`${artifact}-before.json`,
				`${JSON.stringify(deletionManifest, null, 2)}\n`,
			);
			const deleted = Effect.runPromise(
				browser.rpc.DeleteSession(deletionManifest.payload),
			).then(
				(response) => ({ response }),
				(error: unknown) => ({ error }),
			);
			pendingDelete = deleted;
			// The barrier uses the deletion's existing RPC connection. Its reply
			// confirms the server has received the preceding delete request while
			// the second Git rename is still paused, without a timing sleep.
			await Effect.runPromise(browser.rpc.GetProjects({}));
			evidence["stateBeforeRelease"] = state();
			expect((await sessions()).some(({ id }) => id === session.id)).toBe(true);
			expect(existsSync(primaryPath)).toBe(true);
			expect(existsSync(secondaryPath)).toBe(true);
			writeFileSync(join(fixture.root, "release-rename"), "release\n");
			const [renameResult, deleteResult] = await Promise.all([
				renamed,
				deleted,
			]);
			deletionManifest.result = deleteResult;
			expect(renameResult).toEqual({ response: { ok: true } });
			expect(deleteResult).toMatchObject({ response: { ok: true } });
			if ("response" in deleteResult)
				expect(deleteResult.response.worktreeWarnings ?? []).toEqual([]);
			expect((await sessions()).some(({ id }) => id === session.id)).toBe(
				false,
			);
			for (const [folder, path] of [
				[fixture.projectDir, primaryPath],
				[secondary, secondaryPath],
			] as const) {
				expect(existsSync(path)).toBe(false);
				expect(git(folder, "branch", "--list", oldName)).toBe("");
				expect(git(folder, "branch", "--list", branchName)).toBe("");
				expect(
					git(
						folder,
						"for-each-ref",
						"--format=%(refname:short)",
						"refs/heads",
					),
				).toBe("main");
			}
			expect(state().workspaceEvents.at(-1)?.data).toMatchObject({
				cause: "branch-rename",
				ownership: [
					expect.objectContaining({ branchName }),
					expect.objectContaining({ branchName }),
				],
			});
		} finally {
			writeFileSync(join(fixture.root, "release-rename"), "release\n");
			await Promise.allSettled([
				renamed,
				...(pendingDelete ? [pendingDelete] : []),
			]);
			if (deletionManifest) {
				deletionManifest.after = state();
				writeFileSync(
					`${artifact}-after.json`,
					`${JSON.stringify(deletionManifest, null, 2)}\n`,
				);
			}
		}
	}, 300_000);

	it("rejects a session moved into an existing worktree without launch ownership", async () => {
		const { fixture, socket, create, find, state, rename } =
			await start("existing-worktree");
		const session = await create("Existing worktree", false);
		const path = join(fixture.root, "existing");
		git(fixture.projectDir, "worktree", "add", "-b", "external/existing", path);
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: session.id,
			path: realpathSync(path),
		});
		worktrees.set(`${session.id}:${fixture.projectDir}`, {
			sessionId: session.id,
			folder: fixture.projectDir,
			path,
		});
		expect((await find(session.id)).canRenameBranch ?? false).toBe(false);
		const before = state();
		await expect(rename(session.id, "feature/not-owned")).rejects.toMatchObject(
			{
				_tag: "WorktreeBranchRenameError",
				folder: fixture.projectDir,
				reason: "not-owned",
				message: expect.stringMatching(/ownership|created|Conduit/i),
			},
		);
		expect(state()).toEqual(before);
	}, 300_000);

	it("rejects a fork which inherits a workspace without launch ownership", async () => {
		const { fixture, socket, create, find, state, rename } =
			await start("fork-not-owned");
		const parent = await create("Parent");
		const browser = await fixture.connect(parent.id);
		await browser.send(parent.id, "Reply with pong.", 120_000);
		const fork = await sendRpcRequest(socket, {
			_tag: "ForkSession",
			sessionId: parent.id,
			originId: browser.originId,
		});
		const child = await find(fork.sessionId);
		expect(child.workspace?.worktrees).toEqual(parent.workspace?.worktrees);
		expect(child.canRenameBranch ?? false).toBe(false);
		const before = state();
		await expect(rename(child.id, "feature/fork")).rejects.toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: fixture.projectDir,
			reason: "not-owned",
		});
		expect(state()).toEqual(before);
	}, 300_000);

	it("treats the current name as a no-op without appending a workspace event", async () => {
		const { fixture, create, state, rename } = await start("same-name", {
			shim: true,
		});
		const session = await create("Same name");
		const branchName = git(
			checkout(session, fixture.projectDir),
			"branch",
			"--show-current",
		);
		const before = state();
		expect(await rename(session.id, branchName)).toEqual({ ok: true });
		expect(state()).toEqual(before);
		expect(existsSync(join(fixture.root, "git-renames.jsonl"))).toBe(false);
	}, 300_000);

	it("preserves a user's workspace move while renaming the original owned branches", async () => {
		const { fixture, socket, secondary, create, find, state, rename } =
			await start("preserve-user-move");
		const session = await create("Moved owner");
		const existing = join(fixture.root, "user-choice");
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"external/user-choice",
			existing,
		);
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: session.id,
			path: existing,
		});
		const moved = await find(session.id);
		expect(moved.workspace?.cause).toBe("user");
		expect(moved.workspace?.worktrees[fixture.projectDir]).toBe(existing);
		const before = state();
		const branchName = "feature/owned-after-move";
		expect(await rename(session.id, branchName)).toEqual({ ok: true });
		const renamed = await find(session.id);
		expect(renamed.workspace).toEqual(moved.workspace);
		expect(renamed.git?.branch).toBe("external/user-choice");
		for (const folder of [fixture.projectDir, secondary])
			expect(git(checkout(session, folder), "branch", "--show-current")).toBe(
				branchName,
			);
		expect(state().sessions).toEqual(before.sessions);
		expect(state().workspaceEvents.at(-1)?.data).toMatchObject({
			cause: "branch-rename",
		});
	}, 300_000);

	it("renames each repository once when two project folders share its checkout", async () => {
		const { fixture, secondary, create, find, state, rename } = await start(
			"shared-repository",
			{ shared: true, shim: true },
		);
		const session = await create("Shared repository");
		expect(Object.keys(session.workspace?.worktrees ?? {})).toHaveLength(3);
		const before = state();
		const branchName = "feature/shared-folders";
		expect(await rename(session.id, branchName)).toEqual({ ok: true });
		expect((await find(session.id)).workspace).toEqual(session.workspace);
		expect(
			(await find(session.id)).git?.folders?.map(({ branch }) => branch),
		).toEqual([branchName, branchName, branchName]);
		expect(state().worktrees.map(({ head }) => head)).toEqual(
			before.worktrees.map(({ head }) => head),
		);
		const attempts = readFileSync(
			join(fixture.root, "git-renames.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { folder: string });
		expect(attempts.map(({ folder }) => folder)).toEqual([
			fixture.projectDir,
			secondary,
		]);
		evidence["gitRenameAttempts"] = attempts;
	}, 300_000);

	it("deletes the renamed branches and their worktrees once their commits are merged", async () => {
		const { fixture, socket, secondary, create, sessions, state, rename } =
			await start("delete-renamed");
		const session = await create("Merged renamed worktrees");
		const oldName = git(
			checkout(session, fixture.projectDir),
			"branch",
			"--show-current",
		);
		for (const folder of [fixture.projectDir, secondary]) {
			const path = checkout(session, folder);
			writeFileSync(join(path, "session.txt"), "merged session work\n");
			commit(path, "Session work");
			git(path, "push", "-u", "origin", oldName);
			git(folder, "merge", "--ff-only", oldName);
			git(folder, "push", "origin", "main");
		}
		const branchName = "feature/merged-renamed";
		expect(await rename(session.id, branchName)).toEqual({ ok: true });
		const inspection = await sendRpcRequest(socket, {
			_tag: "InspectSessionWorktrees",
			sessionId: session.id,
		});
		evidence["inspection"] = inspection;
		expect(inspection.removeWorktrees).toBe(true);
		expect(inspection.worktrees).toHaveLength(2);
		for (const folder of [fixture.projectDir, secondary])
			expect(inspection.worktrees).toContainEqual(
				expect.objectContaining({
					folder,
					path: checkout(session, folder),
					reasons: [],
				}),
			);
		const before = state();
		const response = await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: session.id,
			removeWorktrees: true,
		});
		evidence["deletion"] = { before, response, after: state() };
		expect(response.ok).toBe(true);
		expect(response.worktreeWarnings ?? []).toEqual([]);
		expect((await sessions()).some(({ id }) => id === session.id)).toBe(false);
		for (const folder of [fixture.projectDir, secondary]) {
			expect(existsSync(checkout(session, folder))).toBe(false);
			expect(git(folder, "branch", "--list", branchName)).toBe("");
			expect(git(folder, "branch", "--list", oldName)).toBe("");
			expect(
				git(folder, "for-each-ref", "--format=%(refname:short)", "refs/heads"),
			).toBe("main");
		}
	}, 300_000);
});
