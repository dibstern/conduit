/*
 * Failure modes exercised through the daemon before implementing the launch:
 * - Git creates a checkout/branch then fails: no session event or owned files remain.
 * - Model initialization is interrupted after creation: session and checkout roll back.
 * - An unsupported provider or project without Git bypasses the disabled chip.
 * - Owned paths, including symlink aliases and missing children, become project folders.
 * - The first turn or a freshly started runner after restart uses the main checkout.
 * - Worktree edits leak into a parallel Local session or another worktree session.
 * - An explicit base is ignored, or a tag/revision is accepted as a local branch.
 * - An invalid base creates a session, generated branch or checkout before failing.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreateSession,
	FindFolders,
	ListBranches,
	ListDaemonSessions,
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

describe("New worktree drafts through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let initialHead = "";
	const names = new Map<string, string>();
	const branches = new Map<string, string>();
	const paths = new Map<string, string>();
	const heads = new Map<string, string>();
	const bases = new Map<string, string>();
	let evidence: Record<string, unknown> = {};

	async function start(name: string, failGit = false) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		names.clear();
		branches.clear();
		paths.clear();
		heads.clear();
		bases.clear();
		evidence = {};
		harness = ProcessHarness.create();
		const fixture = harness;
		const remote = join(fixture.root, "origin.git");
		const seed = join(fixture.root, "seed");
		git(fixture.root, "init", "--bare", remote);
		git(fixture.root, "init", "-b", "main", seed);
		writeFileSync(join(seed, "base.txt"), "committed base\n");
		git(seed, "add", "base.txt");
		git(
			seed,
			"-c",
			"user.name=Workspace test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		git(seed, "push", remote, "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
		git(fixture.root, "clone", remote, fixture.projectDir);
		initialHead = git(fixture.projectDir, "rev-parse", "HEAD");
		heads.set(initialHead, "initial");
		if (failGit) {
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
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (args.includes("worktree") && args.includes("add") && result.status === 0) {
  process.stderr.write("forced worktree creation failure\\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
`,
				{ mode: 0o755 },
			);
			vi.stubEnv("PATH", `${shim}:${gitEnv["PATH"] ?? ""}`);
		}
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const sessions = () =>
			sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
		const create = async (
			title: string,
			newWorktree = true,
			worktreeBase?: string,
		) => {
			const result = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "new-worktree-test",
					providerId: "claude",
					title,
					...(newWorktree ? { newWorktree: true } : {}),
					...(worktreeBase === undefined ? {} : { worktreeBase }),
				}),
			);
			names.set(result.sessionId, title);
			const session = (await sessions()).sessions.find(
				({ id }) => id === result.sessionId,
			);
			const path = session?.workspace?.worktrees[fixture.projectDir];
			if (path) {
				paths.set(path, `<root>/config/worktrees/process-test/${title}/app`);
				bases.set(
					path,
					worktreeBase ?? git(fixture.projectDir, "branch", "--show-current"),
				);
			}
			if (newWorktree && session?.git?.branch)
				branches.set(session.git.branch, `<branch:${title}>`);
			return { id: result.sessionId, session, path };
		};
		return { fixture, socket, sessions, create };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length)
			evidence["diagnosticLogs"] = fixture.logTail
				.slice(-4_000)
				.replace(/\(node:\d+\)/g, "(node:<pid>)")
				.replace(/"time":\d+/g, '"time":"<time>"')
				.replace(/"pid":\d+/g, '"pid":"<pid>"')
				.replace(/"hostname":"[^"]+"/g, '"hostname":"<host>"')
				.replace(/ses_[a-z0-9]+/g, "<session>");
		try {
			if (existsSync(fixture.projectStorePath())) {
				const db = new Database(fixture.projectStorePath(), { readonly: true });
				try {
					const created = db
						.prepare(
							"SELECT session_id, data FROM events WHERE type = 'session.created' ORDER BY sequence",
						)
						.all() as { session_id: string; data: string }[];
					for (const { session_id, data } of created) {
						const { title } = JSON.parse(data) as { title: string };
						if (!names.has(session_id))
							names.set(session_id, title || "initial-session");
					}
					evidence["sessions"] = (
						db
							.prepare(
								"SELECT id, title, workspace FROM sessions ORDER BY title",
							)
							.all() as {
							id: string;
							title: string;
							workspace: string | null;
						}[]
					).map(({ id, title, workspace }) => ({
						session: names.get(id) ?? "initial-session",
						title,
						workspace: workspace ? (JSON.parse(workspace) as unknown) : null,
					}));
					evidence["workspaceEvents"] = (
						db
							.prepare(
								"SELECT data FROM events WHERE type = 'session.workspace_changed' ORDER BY sequence",
							)
							.all() as { data: string }[]
					).map(({ data }) => {
						const event = JSON.parse(data) as {
							sessionId: string;
							worktrees: Record<string, string>;
						};
						for (const path of Object.values(event.worktrees)) {
							if (!paths.has(path))
								paths.set(
									path,
									`<root>/config/worktrees/process-test/${names.get(event.sessionId) ?? "interrupted"}/app`,
								);
						}
						return event;
					});
				} finally {
					db.close();
				}
			}
			evidence["worktrees"] = [...paths]
				.filter(([path]) => existsSync(path))
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([path]) => ({
					path,
					branch: git(path, "branch", "--show-current"),
					base: bases.get(path),
					head: heads.get(git(path, "rev-parse", "HEAD")) ?? "unexpected-head",
					dirty: git(path, "status", "--porcelain").length > 0,
				}));
			evidence["launches"] = [...names]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([id, name]) => ({
					session: name,
					turns: sessionQueries(fixture, id).map(({ options, resumeId }) => ({
						cwd: options["cwd"],
						additionalDirectories: options["additionalDirectories"] ?? [],
						resumed: Boolean(resumeId),
					})),
				}));
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
			} finally {
				let normalized = JSON.stringify(
					evidence,
					(_key, value: unknown) =>
						value !== null && typeof value === "object" && !Array.isArray(value)
							? Object.fromEntries(
									Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
								)
							: value,
					2,
				);
				for (const [path, label] of paths)
					normalized = normalized.replaceAll(path, label);
				for (const [id, label] of names)
					normalized = normalized.replaceAll(id, label);
				for (const [branch, label] of branches)
					normalized = normalized.replaceAll(branch, label);
				normalized = normalized
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>");
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-2-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("starts from the chosen local branch and defaults to the current branch", async () => {
		const { fixture, socket, create } = await start("base-branch-selection");
		git(fixture.projectDir, "branch", "feature/base");
		git(fixture.projectDir, "tag", "release");
		writeFileSync(
			join(fixture.projectDir, "base.txt"),
			"current main commit\n",
		);
		git(
			fixture.projectDir,
			"-c",
			"user.name=Workspace test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-am",
			"Advance main",
		);
		const currentHead = git(fixture.projectDir, "rev-parse", "HEAD");
		heads.set(initialHead, "base:feature/base");
		heads.set(currentHead, "current:main");
		expect(currentHead).not.toBe(initialHead);
		expect(
			await sendRpcRequest(
				socket,
				new ListBranches({ projectSlug: "process-test" }),
			),
		).toEqual({
			current: "main",
			branches: ["feature/base", "main"],
		});
		const selected = await create("selected-base", true, "feature/base");
		const defaulted = await create("default-base");
		expect(git(selected.path ?? "", "rev-parse", "HEAD")).toBe(initialHead);
		expect(git(defaulted.path ?? "", "rev-parse", "HEAD")).toBe(currentHead);
		expect(git(fixture.projectDir, "branch", "--show-current")).toBe("main");
		evidence["baseSelections"] = [
			{
				session: "selected-base",
				base: "feature/base",
				head: "base:feature/base",
			},
			{ session: "default-base", base: "main", head: "current:main" },
		];
		git(fixture.projectDir, "checkout", "--detach", "main");
		const detached = await sendRpcRequest(
			socket,
			new ListBranches({ projectSlug: "process-test" }),
		);
		expect(detached).not.toHaveProperty("current");
		expect(detached.branches).toEqual(
			[
				git(selected.path ?? "", "branch", "--show-current"),
				git(defaulted.path ?? "", "branch", "--show-current"),
				"feature/base",
				"main",
			].sort(),
		);
		evidence["detachedBranches"] = detached;
	}, 300_000);

	it("rejects missing and non-branch bases without a session, branch or worktree", async () => {
		const { fixture, socket, sessions } = await start("invalid-base");
		git(fixture.projectDir, "tag", "release");
		const beforeSessions = (await sessions()).sessions.map(({ id }) => id);
		const beforeBranches = git(
			fixture.projectDir,
			"for-each-ref",
			"--format=%(refname) %(objectname)",
		);
		const beforeWorktrees = git(
			fixture.projectDir,
			"worktree",
			"list",
			"--porcelain",
		);
		const invalid = [
			"missing",
			"release",
			"origin/main",
			"HEAD",
			"main^{commit}",
			"refs/heads/main",
		];
		for (const worktreeBase of invalid) {
			await expect(
				sendRpcRequest(
					socket,
					new CreateSession({
						projectSlug: "process-test",
						originId: "base-test",
						providerId: "claude",
						newWorktree: true,
						worktreeBase,
					}),
				),
			).rejects.toMatchObject({
				_tag: "WorktreeCreationError",
				reason: "invalid-branch",
			});
		}
		await expect(
			sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "base-test",
					providerId: "claude",
					worktreeBase: "main",
				}),
			),
		).rejects.toMatchObject({
			_tag: "WsRpcError",
			message: expect.stringContaining("worktreeBase requires newWorktree"),
		});
		expect((await sessions()).sessions.map(({ id }) => id)).toEqual(
			beforeSessions,
		);
		expect(
			git(
				fixture.projectDir,
				"for-each-ref",
				"--format=%(refname) %(objectname)",
			),
		).toBe(beforeBranches);
		expect(git(fixture.projectDir, "worktree", "list", "--porcelain")).toBe(
			beforeWorktrees,
		);
		expect(ownedCheckouts(fixture)).toEqual([]);
		evidence["invalidBases"] = invalid;
		evidence["failure"] = {
			sessionCreated: false,
			branchesChanged: false,
			worktreesChanged: false,
		};
	}, 300_000);

	it("isolates first-turn edits and resumes a new runner in canonical worktrees after restart", async () => {
		const { fixture, create } = await start("isolation-restart");
		const isolated = await create("isolated");
		const parallel = await create("parallel");
		const local = await create("local", false);
		expect(isolated.path).toBeDefined();
		expect(parallel.path).toBeDefined();
		if (!isolated.path || !parallel.path)
			throw new Error("Worktree workspace was not published");
		expect(isolated.session?.workspace).toEqual({
			cause: "launch",
			origin: "conduit",
			worktrees: { [fixture.projectDir]: isolated.path },
		});
		expect(isolated.session?.git).toMatchObject({
			branch: expect.stringMatching(/^conduit\//),
			worktree: expect.any(String),
		});
		expect(isolated.session?.git?.branch).not.toBe(
			parallel.session?.git?.branch,
		);
		expect(local.session?.workspace ?? null).toBeNull();
		expect(local.session?.git?.branch).toBe("main");
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		await browser.send(isolated.id, "workspace-isolation-write one", 120_000);
		expect(readFileSync(join(isolated.path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write one",
		);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		expect(existsSync(join(parallel.path, "session-only.txt"))).toBe(false);
		await browser.view(local.id);
		expect(
			(
				await browser.send(local.id, "workspace-isolation-read", 120_000)
			).chunks.join(""),
		).toBe("absent");
		await browser.view(parallel.id);
		expect(
			(
				await browser.send(parallel.id, "workspace-isolation-read", 120_000)
			).chunks.join(""),
		).toBe("absent");
		expect(
			sessionQueries(fixture, isolated.id).map(({ options }) => options["cwd"]),
		).toEqual([isolated.path]);
		expect(
			sessionQueries(fixture, local.id).map(({ options }) => options["cwd"]),
		).toEqual([fixture.projectDir]);
		const oldPids = fixture.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === isolated.id
				? [mark.pid]
				: [],
		);
		// Full stop prevents re-adopting a surviving runner from masquerading as canonical resume.
		await fixture.shutdown();
		await vi.waitFor(() => expect(fixture.remainingRunnerPids()).toEqual([]));
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const restarted = await fixture.connect();
		await restarted.view(isolated.id);
		await restarted.send(isolated.id, "workspace-isolation-write two", 120_000);
		expect(readFileSync(join(isolated.path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write two",
		);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		expect(existsSync(join(parallel.path, "session-only.txt"))).toBe(false);
		const turns = sessionQueries(fixture, isolated.id);
		expect(turns.map(({ options }) => options["cwd"])).toEqual([
			isolated.path,
			isolated.path,
		]);
		expect(turns[1]?.resumeId).toBeTruthy();
		expect(oldPids).not.toContain(turns[1]?.pid);
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const events = db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND type IN ('session.created', 'session.workspace_changed', 'message.created') ORDER BY sequence",
				)
				.all(isolated.id) as { type: string }[];
			expect(events.slice(0, 2).map(({ type }) => type)).toEqual([
				"session.created",
				"session.workspace_changed",
			]);
		} finally {
			db.close();
		}
	}, 300_000);

	it("launches a single Git subfolder at its corresponding path inside the worktree", async () => {
		const { fixture, socket, sessions } = await start("git-subfolder");
		const folder = join(fixture.projectDir, "app");
		mkdirSync(folder);
		writeFileSync(join(folder, "tracked.txt"), "app base\n");
		git(fixture.projectDir, "add", "app");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Workspace test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Add app folder",
		);
		initialHead = git(fixture.projectDir, "rev-parse", "HEAD");
		await sendRpcRequest(
			socket,
			new SaveProject({ slug: "process-test", folders: [folder] }),
		);
		const { sessionId } = await sendRpcRequest(
			socket,
			new CreateSession({
				projectSlug: "process-test",
				originId: "new-worktree-test",
				providerId: "claude",
				title: "subfolder",
				newWorktree: true,
			}),
		);
		names.set(sessionId, "subfolder");
		const session = (await sessions()).sessions.find(
			({ id }) => id === sessionId,
		);
		const path = session?.workspace?.worktrees[folder];
		if (!session || !path)
			throw new Error("Worktree subfolder was not published");
		paths.set(path, "<root>/config/worktrees/process-test/subfolder/app");
		if (session.git?.branch)
			branches.set(session.git.branch, "<branch:subfolder>");
		expect(session.workspace?.origin).toBe("conduit");
		expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("app base\n");
		const browser = await fixture.connect();
		await browser.view(sessionId);
		await browser.send(
			sessionId,
			"workspace-isolation-write subfolder",
			120_000,
		);
		expect(readFileSync(join(path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write subfolder",
		);
		expect(existsSync(join(folder, "session-only.txt"))).toBe(false);
		expect(
			sessionQueries(fixture, sessionId).map(({ options }) => options["cwd"]),
		).toEqual([path]);
	}, 300_000);

	it("reports a partial Git creation failure and leaves no session, branch or worktree", async () => {
		const { fixture, socket, sessions } = await start("creation-failure", true);
		const before = await sessions();
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const count = () =>
				(
					db
						.prepare(
							"SELECT count(*) AS count FROM events WHERE type = 'session.created'",
						)
						.get() as { count: number }
				).count;
			const beforeCount = count();
			await expect(
				sendRpcRequest(
					socket,
					new CreateSession({
						projectSlug: "process-test",
						originId: "new-worktree-test",
						providerId: "claude",
						title: "failed",
						newWorktree: true,
					}),
				),
			).rejects.toMatchObject({
				_tag: "WorktreeCreationError",
				reason: "git-failed",
				message: expect.stringContaining("forced worktree creation failure"),
			});
			expect(count()).toBe(beforeCount);
		} finally {
			db.close();
		}
		expect((await sessions()).sessions.map(({ id }) => id)).toEqual(
			before.sessions.map(({ id }) => id),
		);
		expect(
			git(
				fixture.projectDir,
				"for-each-ref",
				"--format=%(refname:short)",
				"refs/heads",
			),
		).toBe("main");
		expect(
			git(fixture.projectDir, "worktree", "list", "--porcelain"),
		).not.toContain(join(fixture.configDir, "worktrees"));
		expect(ownedCheckouts(fixture)).toEqual([]);
		expect(fixture.marks.some(({ kind }) => kind === "runner-started")).toBe(
			false,
		);
		evidence["failure"] = {
			reason: "git-failed",
			message: "forced worktree creation failure",
			sessionCreated: false,
			branches: ["main"],
			ownedWorktrees: [],
		};
	}, 300_000);

	it("rejects unsupported providers and projects without Git before creating anything", async () => {
		const { fixture, socket, sessions } = await start("unsupported-launches");
		const before = (await sessions()).sessions.map(({ id }) => id);
		await expect(
			sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "new-worktree-test",
					providerId: "unsupported-provider",
					newWorktree: true,
				}),
			),
		).rejects.toMatchObject({
			_tag: "WorkspaceMoveError",
			reason: "unsupported-provider",
		});
		await expect(
			sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "new-worktree-test",
					providerId: "claude",
					newWorktree: true,
					worktreePath: fixture.projectDir,
				}),
			),
		).rejects.toMatchObject({
			_tag: "WsRpcError",
			message: expect.stringContaining(
				"either a new worktree or an existing worktree",
			),
		});
		const secondary = join(fixture.root, "secondary");
		mkdirSync(secondary);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [secondary],
			}),
		);
		await expect(
			sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "new-worktree-test",
					providerId: "claude",
					newWorktree: true,
				}),
			),
		).rejects.toMatchObject({
			_tag: "WorktreeCreationError",
			reason: "unsupported-project",
		});
		expect((await sessions()).sessions.map(({ id }) => id)).toEqual(before);
		expect(
			git(
				fixture.projectDir,
				"for-each-ref",
				"--format=%(refname:short)",
				"refs/heads",
			),
		).toBe("main");
		expect(existsSync(join(fixture.configDir, "worktrees"))).toBe(false);
		evidence["refused"] = [
			"opencode",
			"conflicting-draft-choices",
			"no-git-folders",
		];
	}, 300_000);

	it("refuses owned worktree paths and aliases in discovery and every project folder", async () => {
		const { fixture, socket, create } = await start("owned-paths");
		const isolated = await create("isolated");
		if (!isolated.path) throw new Error("Worktree workspace was not published");
		const root = realpathSync(join(fixture.configDir, "worktrees"));
		const alias = join(fixture.root, "worktree-alias");
		symlinkSync(root, alias);
		const outwardAlias = join(root, "outward-alias");
		symlinkSync(fixture.projectDir, outwardAlias);
		for (const path of [
			root,
			isolated.path,
			alias,
			join(alias, "missing"),
			outwardAlias,
			join(outwardAlias, "missing"),
		]) {
			await expect(
				sendRpcRequest(socket, new FindFolders({ query: path })),
			).rejects.toMatchObject({
				_tag: "ProjectSaveRejected",
				issues: expect.arrayContaining([
					{ kind: "conduit-worktree", path: expect.any(String) },
				]),
			});
			for (const folders of [[path], [fixture.projectDir, path]]) {
				await expect(
					sendRpcRequest(
						socket,
						new SaveProject({
							...(folders.length > 1 ? { slug: "process-test" } : {}),
							folders,
						}),
					),
				).rejects.toMatchObject({
					_tag: "ProjectSaveRejected",
					issues: expect.arrayContaining([
						{ kind: "conduit-worktree", path: expect.any(String) },
					]),
				});
			}
		}
		const suggestions = await sendRpcRequest(
			socket,
			new FindFolders({ query: `${fixture.configDir}/` }),
		);
		expect(suggestions.entries.some(({ path }) => path === root)).toBe(false);
		evidence["refused"] = [
			"root",
			"checkout",
			"symlink",
			"missing-symlink-child",
			"outward-symlink",
			"missing-outward-symlink-child",
		];
	}, 300_000);

	it("rolls back the new worktree when model initialization is interrupted", async () => {
		const { fixture, socket, sessions } = await start(
			"interrupted-initialization",
		);
		const browser = await fixture.connect();
		const gate = join(fixture.root, "capabilities-probe");
		writeFileSync(`${gate}-gated`, "");
		const creating = Effect.runPromise(
			Effect.exit(
				browser.rpc.CreateSession({
					projectSlug: "process-test",
					originId: browser.originId,
					providerId: "claude",
					title: "Interrupted new worktree",
					newWorktree: true,
					model: { providerId: "claude", modelId: "sonnet", variant: "high" },
				}),
			),
		);
		try {
			await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true));
			await browser.close();
			expect(Exit.isFailure(await creating)).toBe(true);
			await vi.waitFor(async () => {
				expect(
					(await sessions()).sessions.some(
						({ title }) => title === "Interrupted new worktree",
					),
				).toBe(false);
				expect(
					git(
						fixture.projectDir,
						"for-each-ref",
						"--format=%(refname:short)",
						"refs/heads",
					),
				).toBe("main");
				expect(
					git(fixture.projectDir, "worktree", "list", "--porcelain"),
				).not.toContain(join(fixture.configDir, "worktrees"));
				expect(ownedCheckouts(fixture)).toEqual([]);
			});
			evidence["interrupted"] = {
				remainingSessions: 0,
				branches: ["main"],
				ownedWorktrees: [],
			};
		} finally {
			writeFileSync(`${gate}-release`, "");
			await creating;
		}
		expect(
			(
				await sendRpcRequest(
					socket,
					new ListDaemonSessions({ projectSlug: "process-test" }),
				)
			).sessions.some(({ title }) => title === "Interrupted new worktree"),
		).toBe(false);
	}, 300_000);
});

function ownedCheckouts(harness: ProcessHarness) {
	const root = join(harness.configDir, "worktrees", "process-test");
	return existsSync(root)
		? readdirSync(root).flatMap((session) =>
				readdirSync(join(root, session)).map((folder) =>
					join(root, session, folder),
				),
			)
		: [];
}

function sessionQueries(harness: ProcessHarness, sessionId: string) {
	const pids = new Set(
		harness.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	return harness.claudeOptions().filter(({ pid }) => pids.has(pid));
}
