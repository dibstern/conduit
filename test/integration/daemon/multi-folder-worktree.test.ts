import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreatePtyForSession,
	CreateSession,
	GetFileContentForSession,
	GetFileTreeForSession,
	GetProjects,
	ListDaemonSessions,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	ptyEnvelope,
} from "../../helpers/process-harness.js";

// Failure modes, before the feature: a second Git add fails after both branches
// exist; only one repository receives the turn or the branch; a consumer reads
// main instead of its worktree; non-git or later-attached folders lose their
// shared label; detach deletes a checkout; a non-git primary launches in an extra;
// a second folder in one repository is dropped from the workspace mapping.
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

async function terminalCwd(browser: ProcessBrowser, ptyId: string) {
	const cursor = browser.frames.length;
	let output = "";
	// Split the marker so the shell's input echo cannot satisfy the assertion.
	await browser.inputPty(
		ptyId,
		"printf '__WORKTREE%s__%s\\n' _CWD \"$(pwd -P)\"\r",
	);
	await browser.waitFor(() => {
		output = browser.frames
			.slice(cursor)
			.flatMap(({ message }) => {
				const envelope = ptyEnvelope(message);
				return envelope?._tag === "output" && envelope.ptyId === ptyId
					? [envelope.data]
					: [];
			})
			.join("");
		return /__WORKTREE_CWD__([^\r\n]+)\r?\n/.test(output);
	}, cursor);
	return /__WORKTREE_CWD__([^\r\n]+)/.exec(output)?.[1];
}

describe("Multi-folder worktree sessions through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let folders: string[] = [];
	let evidence: Record<string, unknown> = {};
	const initialHeads = new Map<string, string>();
	const names = new Map<string, string>();
	const paths = new Map<string, string>();
	const branches = new Map<string, string>();
	const headLabels = new Map<string, string>();

	function seedRepository(fixture: ProcessHarness, directory: string) {
		const label = basename(directory);
		const remote = join(fixture.root, `${label}-origin.git`);
		const seed = join(fixture.root, `${label}-seed`);
		git(fixture.root, "init", "--bare", remote);
		git(fixture.root, "init", "-b", "main", seed);
		writeFileSync(join(seed, "tracked.txt"), `${label} main\n`);
		git(seed, "add", "tracked.txt");
		git(
			seed,
			"-c",
			"user.name=Multi-folder test",
			"-c",
			"user.email=folders@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		git(seed, "push", remote, "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
		git(fixture.root, "clone", remote, directory);
		initialHeads.set(directory, git(directory, "rev-parse", "HEAD"));
		headLabels.set(git(directory, "rev-parse", "HEAD"), `initial:${label}`);
	}

	async function start(name: string, failSecondGit = false) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		initialHeads.clear();
		headLabels.clear();
		names.clear();
		paths.clear();
		branches.clear();
		harness = ProcessHarness.create({ managedOpenCode: true });
		const fixture = harness;
		const secondary = join(fixture.root, "library");
		const scratch = join(fixture.root, "notes");
		seedRepository(fixture, fixture.projectDir);
		seedRepository(fixture, secondary);
		mkdirSync(scratch);
		writeFileSync(join(scratch, "shared.txt"), "shared notes\n");
		folders = [fixture.projectDir, secondary, scratch];
		if (failSecondGit) {
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
const { appendFileSync, realpathSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (args.includes("worktree") && args.includes("add") && result.status === 0) {
  appendFileSync(${JSON.stringify(join(fixture.root, "git-created.jsonl"))}, JSON.stringify({ folder: realpathSync(process.cwd()), path: args.at(-2), branch: args.at(-1) }) + "\\n");
  if (realpathSync(process.cwd()) === ${JSON.stringify(realpathSync(secondary))}) {
    process.stderr.write("forced second repository worktree failure\\n");
    process.exit(1);
  }
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
		const saveFolders = async (next: string[]) => {
			await sendRpcRequest(
				socket,
				new SaveProject({ slug: "process-test", folders: next }),
			);
			folders = next;
		};
		await saveFolders(folders);
		const sessions = async () =>
			(
				await sendRpcRequest(
					socket,
					new ListDaemonSessions({ scope: "process-test" }),
				)
			).sessions;
		const create = async (
			title: string,
			newWorktree = true,
			worktreeBase?: string,
		) => {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					permissionMode: "ask",
					projectSlug: "process-test",
					originId: "multi-folder-worktree-test",
					providerId: "claude",
					title,
					...(newWorktree ? { newWorktree: true } : {}),
					...(worktreeBase === undefined ? {} : { worktreeBase }),
				}),
			);
			names.set(sessionId, title);
			const session = (await sessions()).find(({ id }) => id === sessionId);
			if (!session) throw new Error("Created session was not listed");
			for (const [folder, path] of Object.entries(
				session.workspace?.worktrees ?? {},
			)) {
				if (!paths.has(path))
					paths.set(
						path,
						`<root>/config/worktrees/process-test/${title}/${basename(folder)}`,
					);
				branches.set(
					git(path, "branch", "--show-current"),
					`<branch:${title}>`,
				);
			}
			return session;
		};
		return {
			fixture,
			socket,
			secondary,
			scratch,
			saveFolders,
			sessions,
			create,
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const realRoot = realpathSync(fixture.root);
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			const socket = join(fixture.configDir, "relay.sock");
			const project = (
				await sendRpcRequest(socket, new GetProjects({}))
			).projects.find(({ slug }) => slug === "process-test");
			evidence["project"] = {
				slug: project?.slug,
				folders: project?.folders,
				repositoryIdentities: project?.repositoryIdentities,
			};
			const sessions = (
				await sendRpcRequest(
					socket,
					new ListDaemonSessions({ scope: "process-test" }),
				)
			).sessions;
			for (const session of sessions) {
				names.set(session.id, session.title);
				for (const [folder, path] of Object.entries(
					session.workspace?.worktrees ?? {},
				)) {
					if (!paths.has(path))
						paths.set(
							path,
							`<root>/config/worktrees/process-test/${session.title}/${basename(folder)}`,
						);
					if (existsSync(path))
						branches.set(
							git(path, "branch", "--show-current"),
							`<branch:${session.title}>`,
						);
				}
			}
			evidence["sessions"] = sessions
				.map(({ id, title, workspace, git }) => ({ id, title, workspace, git }))
				.sort((a, b) => a.title.localeCompare(b.title));
			evidence["launches"] = [...names]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([id, title]) => {
					const pids = new Set(
						fixture.marks.flatMap((mark) =>
							mark.kind === "runner-started" && mark.sessionId === id
								? [mark.pid]
								: [],
						),
					);
					return {
						session: title,
						turns: fixture
							.claudeOptions()
							.filter(({ pid }) => pids.has(pid))
							.map(({ options }) => ({
								cwd: options["cwd"],
								additionalDirectories: options["additionalDirectories"] ?? [],
							})),
					};
				});
			evidence["worktrees"] = [...initialHeads]
				.sort(([a], [b]) => a.localeCompare(b))
				.flatMap(([folder]) =>
					git(folder, "worktree", "list", "--porcelain")
						.split("\n\n")
						.filter(Boolean)
						.sort()
						.map((entry) => {
							const path = /^worktree (.+)$/m.exec(entry)?.[1];
							if (!path) throw new Error("Git worktree entry has no path");
							return {
								folder,
								effectiveDirectory: path,
								branch: git(path, "branch", "--show-current"),
								head:
									headLabels.get(git(path, "rev-parse", "HEAD")) ??
									"unexpected-head",
								shared: sessions.some(
									({ workspace }) =>
										workspace?.origin === "conduit" &&
										!workspace.worktrees[folder] &&
										folders.includes(folder),
								),
								owned: paths.has(path),
								dirty: git(path, "status", "--porcelain").length > 0,
								unpushed:
									Number(
										git(
											path,
											"rev-list",
											"--count",
											"HEAD",
											"--not",
											"--remotes",
										),
									) > 0,
								unmerged:
									Number(git(path, "rev-list", "--count", "main..HEAD")) > 0,
							};
						}),
				);
			evidence["sharedFolders"] = folders
				.filter((folder) => !initialHeads.has(folder))
				.sort()
				.map((folder) => ({
					folder,
					effectiveDirectory: folder,
					branch: null,
					head: null,
					shared: sessions.some(
						({ workspace }) =>
							workspace?.origin === "conduit" && !workspace.worktrees[folder],
					),
					owned: false,
					dirty: false,
					unpushed: false,
					unmerged: false,
				}));
		} catch (cause) {
			evidence["manifestError"] = String(cause);
			throw cause;
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
				evidence["cleanup"] = "no fixture runners remain";
			} finally {
				let normalized = JSON.stringify(
					evidence,
					(key, value: unknown) => {
						if (
							key === "head" &&
							typeof value === "string" &&
							/^[a-f0-9]+$/.test(value)
						) {
							const initial = [...initialHeads].find(([, head]) =>
								head.startsWith(value),
							);
							return initial ? `initial:${basename(initial[0])}` : "<commit>";
						}
						return value !== null &&
							typeof value === "object" &&
							!Array.isArray(value)
							? Object.fromEntries(
									Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
								)
							: value;
					},
					2,
				);
				for (const [path, label] of paths)
					normalized = normalized.replaceAll(path, label);
				for (const [path, label] of paths)
					normalized = normalized.replaceAll(basename(path), basename(label));
				for (const [branch, label] of branches)
					normalized = normalized.replaceAll(branch, label);
				for (const [id, title] of names)
					normalized = normalized.replaceAll(id, `<session:${title}>`);
				for (const [folder, head] of initialHeads)
					normalized = normalized.replaceAll(
						head,
						`initial:${basename(folder)}`,
					);
				normalized = normalized
					.replaceAll(realRoot, "<root>")
					.replaceAll(fixture.root, "<root>")
					.replace(/\b[a-f0-9]{40}\b/g, "<commit>");
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-4-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("applies the chosen base to the primary folder while other repositories use their own HEAD", async () => {
		const { fixture, secondary, create } = await start("primary-base");
		const baseHead = git(fixture.projectDir, "rev-parse", "HEAD");
		git(fixture.projectDir, "branch", "feature/base");
		writeFileSync(
			join(fixture.projectDir, "tracked.txt"),
			"primary advances\n",
		);
		git(
			fixture.projectDir,
			"-c",
			"user.name=Multi-folder test",
			"-c",
			"user.email=folders@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-am",
			"Advance primary",
		);
		headLabels.set(
			git(fixture.projectDir, "rev-parse", "HEAD"),
			`current:${basename(fixture.projectDir)}`,
		);
		const secondaryHead = git(secondary, "rev-parse", "HEAD");
		const session = await create("selected-base", true, "feature/base");
		expect(
			git(
				session.workspace?.worktrees[fixture.projectDir] ?? "",
				"rev-parse",
				"HEAD",
			),
		).toBe(baseHead);
		expect(
			git(session.workspace?.worktrees[secondary] ?? "", "rev-parse", "HEAD"),
		).toBe(secondaryHead);
		expect(git(fixture.projectDir, "rev-parse", "HEAD")).not.toBe(baseHead);
		evidence["baseSelections"] = [
			{
				folder: fixture.projectDir,
				base: "feature/base",
				head: headLabels.get(baseHead),
			},
			{ folder: secondary, base: "main", head: headLabels.get(secondaryHead) },
		];
	}, 300_000);

	it("rolls back both creations and every owned branch when Git fails in the second repository", async () => {
		const { fixture, secondary, sessions, create } = await start(
			"second-repository-failure",
			true,
		);
		const before = (await sessions()).map(({ id }) => id);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const createdCount = () =>
				(
					db
						.prepare(
							"SELECT count(*) AS count FROM events WHERE type = 'session.created'",
						)
						.get() as { count: number }
				).count;
			const beforeCount = createdCount();
			await expect(create("failed")).rejects.toMatchObject({
				_tag: "WorktreeCreationError",
				reason: "git-failed",
				path: secondary,
				message: expect.stringContaining(
					"forced second repository worktree failure",
				),
			});
			expect(createdCount()).toBe(beforeCount);
			evidence["sessionCreatedEvents"] = {
				before: beforeCount,
				after: createdCount(),
			};
		} finally {
			db.close();
		}
		const created = readFileSync(
			join(fixture.root, "git-created.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { folder: string; path: string; branch: string },
			);
		evidence["creationsBeforeFailure"] = created;
		expect(created.map(({ folder }) => folder)).toEqual(
			[fixture.projectDir, secondary].map((folder) => realpathSync(folder)),
		);
		expect(created[0]?.branch).toBe(created[1]?.branch);
		expect(created[0]?.branch).toMatch(/^conduit\//);
		for (const { folder, path, branch } of created) {
			paths.set(
				path,
				`<root>/config/worktrees/process-test/failed/${basename(folder)}`,
			);
			branches.set(branch, "<branch:failed>");
			expect(existsSync(path)).toBe(false);
			expect(
				git(folder, "for-each-ref", "--format=%(refname:short)", "refs/heads"),
			).toBe("main");
			expect(git(folder, "worktree", "list", "--porcelain")).not.toContain(
				join(fixture.configDir, "worktrees"),
			);
		}
		expect((await sessions()).map(({ id }) => id)).toEqual(before);
		const owned = join(fixture.configDir, "worktrees", "process-test");
		expect(
			existsSync(owned)
				? readdirSync(owned).flatMap((session) =>
						readdirSync(join(owned, session)),
					)
				: [],
		).toEqual([]);
		expect(fixture.marks.some(({ kind }) => kind === "runner-started")).toBe(
			false,
		);
	}, 300_000);

	it("creates one branch in both repositories and routes the turn, files, terminals and git to the worktrees", async () => {
		const { fixture, socket, secondary, scratch, sessions, create } =
			await start("isolation");
		const isolated = await create("isolated");
		const local = await create("local", false);
		const primaryWorktree = isolated.workspace?.worktrees[fixture.projectDir];
		const secondaryWorktree = isolated.workspace?.worktrees[secondary];
		if (!primaryWorktree || !secondaryWorktree)
			throw new Error("Both worktrees were not published");
		expect(isolated.workspace).toEqual({
			cause: "launch",
			origin: "conduit",
			worktrees: {
				[fixture.projectDir]: primaryWorktree,
				[secondary]: secondaryWorktree,
			},
		});
		const branch = git(primaryWorktree, "branch", "--show-current");
		expect(branch).toMatch(/^conduit\//);
		expect(git(secondaryWorktree, "branch", "--show-current")).toBe(branch);
		for (const [folder, worktree] of [
			[fixture.projectDir, primaryWorktree],
			[secondary, secondaryWorktree],
		] as const) {
			expect(git(worktree, "rev-parse", "HEAD")).toBe(initialHeads.get(folder));
			expect(git(folder, "branch", "--show-current")).toBe("main");
		}
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		const prompt = "workspace-multi-folder-write isolated";
		await browser.send(isolated.id, prompt, 120_000);
		for (const [folder, worktree] of [
			[fixture.projectDir, primaryWorktree],
			[secondary, secondaryWorktree],
		] as const) {
			expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe(
				`${prompt}\n`,
			);
			expect(readFileSync(join(folder, "tracked.txt"), "utf8")).toBe(
				`${basename(folder)} main\n`,
			);
			expect(git(folder, "status", "--porcelain")).toBe("");
		}
		const pids = new Set(
			fixture.marks.flatMap((mark) =>
				mark.kind === "runner-started" && mark.sessionId === isolated.id
					? [mark.pid]
					: [],
			),
		);
		const turns = fixture.claudeOptions().filter(({ pid }) => pids.has(pid));
		expect(
			turns.map(({ options }) => ({
				cwd: options["cwd"],
				additionalDirectories: options["additionalDirectories"],
			})),
		).toEqual([
			{
				cwd: primaryWorktree,
				additionalDirectories: [secondaryWorktree, scratch],
			},
		]);
		const scope = { sessionId: isolated.id };
		const tree = await sendRpcRequest(socket, new GetFileTreeForSession(scope));
		evidence["fileTreeRoots"] = tree.roots;
		expect(tree.roots).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: secondary, label: "library" },
			{ root: scratch, label: "notes", shared: true },
		]);
		for (const root of [fixture.projectDir, secondary]) {
			expect(
				(
					await sendRpcRequest(
						socket,
						new GetFileContentForSession({
							...scope,
							root,
							path: "tracked.txt",
						}),
					)
				).content,
			).toBe(`${prompt}\n`);
			expect(
				(
					await sendRpcRequest(
						socket,
						new GetFileContentForSession({
							...scope,
							sessionId: local.id,
							root,
							path: "tracked.txt",
						}),
					)
				).content,
			).toBe(`${basename(root)} main\n`);
		}
		expect(
			(
				await sendRpcRequest(
					socket,
					new GetFileContentForSession({
						...scope,
						root: scratch,
						path: "shared.txt",
					}),
				)
			).content,
		).toBe("shared notes\n");
		const choices = [];
		for (const [root, directory] of [
			[fixture.projectDir, primaryWorktree],
			[secondary, secondaryWorktree],
			[scratch, scratch],
		] as const) {
			const cursor = browser.frames.length;
			await sendRpcRequest(
				socket,
				new CreatePtyForSession({ ...scope, originId: browser.originId, root }),
			);
			const envelope = ptyEnvelope(
				await browser.waitFor(
					(message) => ptyEnvelope(message)?._tag === "upsert",
					cursor,
				),
			);
			if (envelope?._tag !== "upsert")
				throw new Error("New terminal was not reported");
			const cwd = await terminalCwd(browser, envelope.item.id);
			choices.push({ root, label: basename(root), cwd });
			expect(cwd).toBe(realpathSync(directory));
			await browser.closePty(envelope.item.id);
		}
		evidence["terminalChoices"] = choices;
		await vi.waitFor(
			async () => {
				const git = (await sessions()).find(
					({ id }) => id === isolated.id,
				)?.git;
				expect(git?.folders).toEqual([
					expect.objectContaining({
						root: fixture.projectDir,
						label: basename(fixture.projectDir),
						branch,
						worktree: basename(primaryWorktree),
						dirty: true,
					}),
					expect.objectContaining({
						root: secondary,
						label: "library",
						branch,
						worktree: basename(secondaryWorktree),
						dirty: true,
					}),
					{ root: scratch, label: "notes", shared: true },
				]);
				evidence["sessionGit"] = git;
			},
			{ timeout: 20_000 },
		);
		expect(local.workspace ?? null).toBeNull();
		expect(
			(
				await sendRpcRequest(
					socket,
					new GetFileTreeForSession({ ...scope, sessionId: local.id }),
				)
			).roots,
		).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: secondary, label: "library" },
			{ root: scratch, label: "notes" },
		]);
	}, 300_000);

	it("uses a later-attached git folder in place and keeps a detached folder's worktree on disk", async () => {
		const {
			fixture,
			socket,
			secondary,
			scratch,
			saveFolders,
			sessions,
			create,
		} = await start("attach-detach");
		const isolated = await create("isolated");
		const secondaryWorktree = isolated.workspace?.worktrees[secondary];
		if (!secondaryWorktree)
			throw new Error("Secondary worktree was not published");
		const later = join(fixture.root, "later");
		seedRepository(fixture, later);
		await saveFolders([fixture.projectDir, secondary, scratch, later]);
		const scope = { sessionId: isolated.id };
		const attached = await sendRpcRequest(
			socket,
			new GetFileTreeForSession(scope),
		);
		expect(attached.roots).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: secondary, label: "library" },
			{ root: scratch, label: "notes", shared: true },
			{ root: later, label: "later", shared: true },
		]);
		expect(
			(await sessions()).find(({ id }) => id === isolated.id)?.workspace,
		).toEqual(isolated.workspace);
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		const prompt = "workspace-multi-folder-write attached";
		await browser.send(isolated.id, prompt, 120_000);
		expect(readFileSync(join(later, "tracked.txt"), "utf8")).toBe(
			`${prompt}\n`,
		);
		expect(git(later, "branch", "--show-current")).toBe("main");
		expect(
			git(later, "worktree", "list", "--porcelain").match(/^worktree /gm),
		).toHaveLength(1);
		await vi.waitFor(
			async () => {
				const state = (await sessions()).find(
					({ id }) => id === isolated.id,
				)?.git;
				expect(
					state?.folders?.find(({ root }) => root === later),
				).toMatchObject({
					root: later,
					label: "later",
					branch: "main",
					dirty: true,
					shared: true,
				});
				evidence["attachedGit"] = state;
			},
			{ timeout: 20_000 },
		);
		const cursor = browser.frames.length;
		await sendRpcRequest(
			socket,
			new CreatePtyForSession({
				...scope,
				originId: browser.originId,
				root: later,
			}),
		);
		const terminal = ptyEnvelope(
			await browser.waitFor(
				(message) => ptyEnvelope(message)?._tag === "upsert",
				cursor,
			),
		);
		if (terminal?._tag !== "upsert")
			throw new Error("Attached-folder terminal was not reported");
		expect(await terminalCwd(browser, terminal.item.id)).toBe(
			realpathSync(later),
		);
		await browser.closePty(terminal.item.id);
		await saveFolders([fixture.projectDir, scratch, later]);
		const detached = await sendRpcRequest(
			socket,
			new GetFileTreeForSession(scope),
		);
		evidence["attachedRoots"] = attached.roots;
		evidence["detachedRoots"] = detached.roots;
		expect(detached.roots).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: scratch, label: "notes", shared: true },
			{ root: later, label: "later", shared: true },
		]);
		expect(existsSync(secondaryWorktree)).toBe(true);
		expect(readFileSync(join(secondaryWorktree, "tracked.txt"), "utf8")).toBe(
			`${prompt}\n`,
		);
		expect(git(secondary, "worktree", "list", "--porcelain")).toContain(
			secondaryWorktree,
		);
		expect(
			(await sessions()).find(({ id }) => id === isolated.id)?.workspace,
		).toEqual(isolated.workspace);
		await expect(
			sendRpcRequest(
				socket,
				new CreatePtyForSession({
					...scope,
					originId: browser.originId,
					root: secondary,
				}),
			),
		).rejects.toThrow(/Unknown terminal root/);
		await expect(
			sendRpcRequest(
				socket,
				new GetFileContentForSession({
					...scope,
					root: secondary,
					path: "tracked.txt",
				}),
			),
		).rejects.toThrow(/Unknown file root/);
		await vi.waitFor(
			async () => {
				const git = (await sessions()).find(
					({ id }) => id === isolated.id,
				)?.git;
				expect(git?.folders?.map(({ root }) => root)).toEqual([
					fixture.projectDir,
					scratch,
					later,
				]);
			},
			{ timeout: 20_000 },
		);
		evidence["detachedWorktreeKept"] = {
			folder: secondary,
			path: secondaryWorktree,
			exists: true,
		};
		await saveFolders([scratch]);
		const onlyShared = await sendRpcRequest(
			socket,
			new GetFileTreeForSession(scope),
		);
		const retainedWorkspace = (await sessions()).find(
			({ id }) => id === isolated.id,
		)?.workspace;
		const retainedWorktrees = Object.values(isolated.workspace?.worktrees ?? {})
			.sort()
			.map((path) => ({ path, exists: existsSync(path) }));
		evidence["onlySharedRoot"] = {
			folders: [scratch],
			roots: onlyShared.roots ?? null,
			workspace: retainedWorkspace,
			retainedWorktrees,
		};
		expect(retainedWorkspace).toEqual(isolated.workspace);
		expect(retainedWorktrees.map(({ exists }) => exists)).toEqual([true, true]);
		expect(onlyShared.roots).toEqual([
			{ root: scratch, label: "notes", shared: true },
		]);
	}, 300_000);

	it("keeps a non-git primary shared as the agent cwd with a sole git extra", async () => {
		const { fixture, socket, secondary, scratch, saveFolders, create } =
			await start("non-git-primary");
		await saveFolders([scratch, secondary]);
		const isolated = await create("isolated");
		const secondaryWorktree = isolated.workspace?.worktrees[secondary];
		if (!secondaryWorktree)
			throw new Error("Git extra did not receive a worktree");
		expect(isolated.workspace?.worktrees).toEqual({
			[secondary]: secondaryWorktree,
		});
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		const prompt = "workspace-multi-folder-write non-git-primary";
		await browser.send(isolated.id, prompt, 120_000);
		expect(readFileSync(join(secondaryWorktree, "tracked.txt"), "utf8")).toBe(
			`${prompt}\n`,
		);
		expect(readFileSync(join(secondary, "tracked.txt"), "utf8")).toBe(
			"library main\n",
		);
		const pids = new Set(
			fixture.marks.flatMap((mark) =>
				mark.kind === "runner-started" && mark.sessionId === isolated.id
					? [mark.pid]
					: [],
			),
		);
		expect(
			fixture
				.claudeOptions()
				.filter(({ pid }) => pids.has(pid))
				.map(({ options }) => ({
					cwd: options["cwd"],
					additionalDirectories: options["additionalDirectories"],
				})),
		).toEqual([{ cwd: scratch, additionalDirectories: [secondaryWorktree] }]);
		const tree = await sendRpcRequest(
			socket,
			new GetFileTreeForSession({ sessionId: isolated.id }),
		);
		expect(tree.roots).toEqual([
			{ root: scratch, label: "notes", shared: true },
			{ root: secondary, label: "library" },
		]);
		evidence["fileTreeRoots"] = tree.roots;
	}, 300_000);

	it("keeps both roots of a shared repository in one owned checkout", async () => {
		const {
			fixture,
			socket,
			secondary,
			scratch,
			saveFolders,
			sessions,
			create,
		} = await start("shared-repository");
		const linked = join(fixture.root, "linked");
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"linked-main",
			linked,
			"main",
		);
		initialHeads.set(linked, git(linked, "rev-parse", "HEAD"));
		await saveFolders([fixture.projectDir, linked, secondary, scratch]);
		const isolated = await create("isolated");
		const primaryWorktree = isolated.workspace?.worktrees[fixture.projectDir];
		const secondaryWorktree = isolated.workspace?.worktrees[secondary];
		if (!primaryWorktree || !secondaryWorktree)
			throw new Error("Owned worktrees were not published");
		expect(isolated.workspace).toEqual({
			cause: "launch",
			origin: "conduit",
			worktrees: {
				[fixture.projectDir]: primaryWorktree,
				[linked]: primaryWorktree,
				[secondary]: secondaryWorktree,
			},
		});
		const branch = git(primaryWorktree, "branch", "--show-current");
		expect(git(secondaryWorktree, "branch", "--show-current")).toBe(branch);
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		const prompt = "workspace-multi-folder-write shared-repository";
		await browser.send(isolated.id, prompt, 120_000);
		for (const worktree of [primaryWorktree, secondaryWorktree])
			expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe(
				`${prompt}\n`,
			);
		for (const folder of [fixture.projectDir, linked]) {
			expect(readFileSync(join(folder, "tracked.txt"), "utf8")).toBe(
				"process-test main\n",
			);
			expect(git(folder, "status", "--porcelain")).toBe("");
		}
		expect(readFileSync(join(secondary, "tracked.txt"), "utf8")).toBe(
			"library main\n",
		);
		expect(git(linked, "branch", "--show-current")).toBe("linked-main");
		const pids = new Set(
			fixture.marks.flatMap((mark) =>
				mark.kind === "runner-started" && mark.sessionId === isolated.id
					? [mark.pid]
					: [],
			),
		);
		expect(
			fixture
				.claudeOptions()
				.filter(({ pid }) => pids.has(pid))
				.map(({ options }) => ({
					cwd: options["cwd"],
					additionalDirectories: options["additionalDirectories"],
				})),
		).toEqual([
			{
				cwd: primaryWorktree,
				additionalDirectories: [secondaryWorktree, scratch],
			},
		]);
		const scope = { sessionId: isolated.id };
		const tree = await sendRpcRequest(socket, new GetFileTreeForSession(scope));
		expect(tree.roots).toEqual([
			{ root: fixture.projectDir, label: basename(fixture.projectDir) },
			{ root: linked, label: "linked" },
			{ root: secondary, label: "library" },
			{ root: scratch, label: "notes", shared: true },
		]);
		evidence["fileTreeRoots"] = tree.roots;
		const opened = await sendRpcRequest(
			socket,
			new GetFileContentForSession({
				...scope,
				root: linked,
				path: "tracked.txt",
			}),
		);
		expect(opened.content).toBe(`${prompt}\n`);
		evidence["linkedRootContent"] = opened;
		const cursor = browser.frames.length;
		await sendRpcRequest(
			socket,
			new CreatePtyForSession({
				...scope,
				originId: browser.originId,
				root: linked,
			}),
		);
		const terminal = ptyEnvelope(
			await browser.waitFor(
				(message) => ptyEnvelope(message)?._tag === "upsert",
				cursor,
			),
		);
		if (terminal?._tag !== "upsert")
			throw new Error("Linked-root terminal was not reported");
		const cwd = await terminalCwd(browser, terminal.item.id);
		expect(cwd).toBe(realpathSync(primaryWorktree));
		evidence["terminalChoices"] = [{ root: linked, cwd }];
		await browser.closePty(terminal.item.id);
		await vi.waitFor(
			async () => {
				const state = (await sessions()).find(
					({ id }) => id === isolated.id,
				)?.git;
				expect(state?.folders).toHaveLength(4);
				for (const root of [fixture.projectDir, linked]) {
					const folder = state?.folders?.find((folder) => folder.root === root);
					expect(folder).toMatchObject({
						root,
						branch,
						worktree: basename(primaryWorktree),
						dirty: true,
					});
					expect(folder?.shared).toBeUndefined();
				}
				evidence["sessionGit"] = state;
			},
			{ timeout: 20_000 },
		);
	}, 300_000);
});
