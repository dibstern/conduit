/*
Failure cases, written before implementation:
- Only the extra checkout is missing: report its folder and recreate it, leaving
  the primary checkout's uncommitted work untouched.
- Only the primary is missing: retain the extra checkout and its Git status.
- Both are missing: report both folders and restore each repository's branch tip.
- The extra branch is deleted: fail with that folder and reason, roll back the
  primary recreated by this action, and preserve both repositories' refs.
- Another session shares the extra checkout: restore the same path for both
  sessions without changing their recorded workspace or deleting a healthy path.
- Restart while the extra is missing: retain the mapping and missing state,
  recover after restart, and publish the recovered shell and family rows.
- The second Git add fails after creating its checkout: remove every checkout
  created by this action, preserve registrations/refs, and allow another attempt.
- Sibling subdirectories of one repository share a checkout: healthy mappings
  must not be reported missing, and recovery recreates the shared checkout once.
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
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionInfoSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
for (const key of gitOverrides) delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function latestRow(
	browser: ProcessBrowser,
	feed: "shell" | "family",
	id: string,
) {
	return browser.frames
		.flatMap(({ message }) => {
			if (message["type"] !== feed) return [];
			const rows: readonly unknown[] =
				message["_tag"] === "snapshot" && Array.isArray(message["rows"])
					? message["rows"]
					: message["_tag"] === "upsert"
						? [message["item"]]
						: [];
			return rows
				.filter(Schema.is(SessionInfoSchema))
				.filter((row) => row.id === id);
		})
		.at(-1);
}

describe("Missing multi-folder worktrees through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let folders: string[] = [];
	let evidence: Record<string, unknown> = {};
	const names = new Map<string, string>();
	const checkoutNames = new Map<string, string>();
	const branchNames = new Map<string, string>();
	const heads = new Map<string, string>();

	function seed(fixture: ProcessHarness, folder: string) {
		const label = basename(folder);
		const remote = join(fixture.root, `${label}-origin.git`);
		const source = join(fixture.root, `${label}-seed`);
		git(fixture.root, "init", "--bare", remote);
		git(fixture.root, "init", "-b", "main", source);
		writeFileSync(join(source, "tracked.txt"), `${label} main\n`);
		git(source, "add", "tracked.txt");
		git(
			source,
			"-c",
			"user.name=Recovery test",
			"-c",
			"user.email=recovery@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		git(source, "push", remote, "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
		git(fixture.root, "clone", remote, folder);
		heads.set(git(folder, "rev-parse", "HEAD"), `initial:${label}`);
	}

	async function start(name: string, failExtraAdd = false) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		names.clear();
		checkoutNames.clear();
		branchNames.clear();
		heads.clear();
		harness = ProcessHarness.create({ managedOpenCode: true });
		const fixture = harness;
		const extra = join(fixture.root, "library");
		seed(fixture, fixture.projectDir);
		seed(fixture, extra);
		folders = [fixture.projectDir, extra];
		const failMarker = join(fixture.root, "fail-recovery");
		if (failExtraAdd) {
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
const { existsSync, realpathSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (existsSync(${JSON.stringify(failMarker)}) && args.includes("worktree") && args.includes("add") && result.status === 0) {
  appendFileSync(${JSON.stringify(join(fixture.root, "recreated.jsonl"))}, JSON.stringify({ folder: realpathSync(process.cwd()), path: args.at(-2) }) + "\\n");
  if (realpathSync(process.cwd()) === ${JSON.stringify(realpathSync(extra))}) {
    process.stderr.write("forced extra folder recovery failure\\n");
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
				})
			).sessions;
		const row = async (id: string) => {
			const session = (await sessions()).find((session) => session.id === id);
			if (!session) throw new Error(`Session ${id} was not listed`);
			return session;
		};
		const create = async (title: string, newWorktree = true) => {
			const { sessionId } = await sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				model: { providerId: "claude", modelId: "sonnet" },
				projectSlug: "process-test",
				originId: "multi-folder-recovery-test",
				providerId: "claude",
				title,
				...(newWorktree ? { newWorktree: true } : {}),
			});
			names.set(sessionId, title);
			const session = await row(sessionId);
			for (const [folder, path] of Object.entries(
				session.workspace?.worktrees ?? {},
			)) {
				checkoutNames.set(path, `<checkout:${title}:${basename(folder)}>`);
				const root = git(path, "rev-parse", "--show-toplevel");
				if (!checkoutNames.has(root))
					checkoutNames.set(root, `<checkout:${title}:${basename(folder)}>`);
				branchNames.set(
					git(path, "branch", "--show-current"),
					`<branch:${title}>`,
				);
			}
			return session;
		};
		const recreate = (sessionId: string) =>
			sendRpcRequest(socket, { _tag: "RecreateSessionWorktree", sessionId });
		return { fixture, socket, extra, row, create, recreate, failMarker };
	}

	function workspaceEvents(fixture: ProcessHarness, id: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					"SELECT sequence, data FROM events WHERE session_id = ? AND type = 'session.workspace_changed' ORDER BY sequence",
				)
				.all(id);
		} finally {
			db.close();
		}
	}

	async function capture(phase: string, fixture: ProcessHarness) {
		const sessions = (
			await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
				_tag: "ListDaemonSessions",
				scope: "process-test",
			})
		).sessions;
		evidence[phase] = {
			sessions: sessions.map(
				({ id, workspace, workspaceMissing, git: state }) => ({
					id,
					workspace,
					workspaceMissing,
					git: state,
					events: workspaceEvents(fixture, id),
				}),
			),
			folders: folders.map((folder) => ({
				folder,
				refs: git(
					folder,
					"for-each-ref",
					"--format=%(refname) %(objectname)",
					"refs/heads",
				),
				worktrees: git(folder, "worktree", "list", "--porcelain")
					.split("\n\n")
					.filter(Boolean)
					.map((entry) => {
						const path = /^worktree (.+)$/m.exec(entry)?.[1] ?? "";
						const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
						const present = existsSync(path);
						return {
							folder,
							effectiveDirectory: path,
							branch,
							present,
							head: /^HEAD (.+)$/m.exec(entry)?.[1],
							shared:
								sessions.filter(({ workspace }) =>
									Object.values(workspace?.worktrees ?? {}).includes(path),
								).length > 1,
							owned: checkoutNames.has(path),
							dirty: present
								? git(path, "status", "--porcelain").length > 0
								: null,
							unpushed: present
								? Number(
										git(
											path,
											"rev-list",
											"--count",
											"HEAD",
											"--not",
											"--remotes",
										),
									) > 0
								: null,
							unmerged: present
								? Number(git(path, "rev-list", "--count", "main..HEAD")) > 0
								: null,
						};
					}),
			})),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await capture("final", fixture);
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
				for (const [path, label] of checkoutNames)
					normalized = normalized.replaceAll(path, label);
				for (const [branch, label] of branchNames)
					normalized = normalized.replaceAll(branch, label);
				for (const [id, label] of names)
					normalized = normalized.replaceAll(id, `<session:${label}>`);
				for (const [head, label] of heads)
					normalized = normalized.replaceAll(head, label);
				normalized = normalized
					.replaceAll(root, "<root>")
					.replaceAll(fixture.root, "<root>")
					.replace(/\b[a-f0-9]{40}\b/g, "<commit>");
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-21-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	for (const missing of ["extra", "primary", "both"] as const) {
		it(`reports and recovers ${missing} missing checkouts`, async () => {
			const { fixture, extra, row, create, recreate } = await start(missing);
			const session = await create("owner");
			const mappings = session.workspace?.worktrees ?? {};
			const missingFolders = folders.filter(
				(folder) =>
					missing === "both" ||
					(missing === "primary"
						? folder === fixture.projectDir
						: folder === extra),
			);
			const original = folders.map((folder) => ({
				folder,
				path: mappings[folder] ?? "",
				branch: git(mappings[folder] ?? "", "branch", "--show-current"),
				head: git(mappings[folder] ?? "", "rev-parse", "HEAD"),
			}));
			// Different branch tips prove recovery uses the branch in each repository.
			git(
				mappings[extra] ?? "",
				"-c",
				"user.name=Recovery test",
				"-c",
				"user.email=recovery@example.test",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--allow-empty",
				"-m",
				"Extra session commit",
			);
			const extraCheckout = original.find(({ folder }) => folder === extra);
			if (!extraCheckout) throw new Error("Missing extra checkout in fixture");
			extraCheckout.head = git(mappings[extra] ?? "", "rev-parse", "HEAD");
			heads.set(extraCheckout.head, "extra-session-tip");
			const present = original.filter(
				({ folder }) => !missingFolders.includes(folder),
			);
			for (const { path } of present)
				writeFileSync(join(path, "keep.txt"), "keep present checkout\n");
			await vi.waitFor(
				async () => {
					const state = await row(session.id);
					for (const { folder } of present)
						expect(
							state.git?.folders?.find(({ root }) => root === folder)?.dirty,
						).toBe(true);
				},
				{ timeout: 15_000 },
			);
			const events = workspaceEvents(fixture, session.id);
			await capture("healthy", fixture);
			for (const folder of missingFolders)
				rmSync(mappings[folder] ?? "", { recursive: true, force: true });
			await capture("beforeRecovery", fixture);
			const state = await row(session.id);
			expect(
				state.workspaceMissing?.folders?.map(({ folder }) => folder),
			).toEqual(missingFolders);
			expect(state.workspaceMissing?.canRecreate).toBe(true);
			for (const folder of missingFolders) {
				const status = state.git?.folders?.find(({ root }) => root === folder);
				expect(status?.missing).toBe(true);
				expect(status?.branch).toBeUndefined();
				expect(status?.dirty).toBeUndefined();
			}
			for (const { folder, branch } of present)
				expect(
					state.git?.folders?.find(({ root }) => root === folder),
				).toMatchObject({ branch, dirty: true });
			expect(await recreate(session.id)).toEqual({
				directory: mappings[fixture.projectDir],
			});
			for (const { path, branch, head } of original) {
				expect(git(path, "branch", "--show-current")).toBe(branch);
				expect(git(path, "rev-parse", "HEAD")).toBe(head);
			}
			for (const { path } of present)
				expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe(
					"keep present checkout\n",
				);
			expect((await row(session.id)).workspaceMissing).toBeUndefined();
			expect((await row(session.id)).workspace).toEqual(session.workspace);
			expect(workspaceEvents(fixture, session.id)).toEqual(events);
			await capture("afterRecovery", fixture);
			// A repeat action succeeds without disturbing already recovered checkouts.
			expect(await recreate(session.id)).toEqual({
				directory: mappings[fixture.projectDir],
			});
		}, 180_000);
	}

	for (const failure of ["deleted-branch", "git-add"] as const) {
		it(`rolls back every recreated checkout on ${failure}`, async () => {
			const { fixture, extra, row, create, recreate, failMarker } = await start(
				failure,
				failure === "git-add",
			);
			const session = await create("owner");
			const mappings = session.workspace?.worktrees ?? {};
			const branch = git(mappings[extra] ?? "", "branch", "--show-current");
			for (const path of Object.values(mappings))
				rmSync(path, { recursive: true, force: true });
			if (failure === "deleted-branch")
				git(extra, "update-ref", "-d", `refs/heads/${branch}`);
			else writeFileSync(failMarker, "fail\n");
			const refs = folders.map((folder) =>
				git(
					folder,
					"for-each-ref",
					"--format=%(refname) %(objectname)",
					"refs/heads",
				),
			);
			await capture("beforeRecovery", fixture);
			if (failure === "deleted-branch")
				expect((await row(session.id)).workspaceMissing).toMatchObject({
					canRecreate: false,
					reason: "branch-missing",
				});
			await expect(recreate(session.id)).rejects.toMatchObject({
				_tag: "WorktreeRecoveryError",
				reason: failure === "deleted-branch" ? "branch-missing" : "git-failed",
				message: expect.stringContaining(extra),
			});
			for (const path of Object.values(mappings))
				expect(existsSync(path)).toBe(false);
			expect(
				folders.map((folder) =>
					git(
						folder,
						"for-each-ref",
						"--format=%(refname) %(objectname)",
						"refs/heads",
					),
				),
			).toEqual(refs);
			expect((await row(session.id)).workspaceMissing?.folders).toHaveLength(2);
			await capture("afterRecovery", fixture);
			if (failure === "git-add") {
				evidence["gitAddsBeforeFailure"] = readFileSync(
					join(fixture.root, "recreated.jsonl"),
					"utf8",
				)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(evidence["gitAddsBeforeFailure"]).toHaveLength(2);
				rmSync(failMarker);
				await recreate(session.id);
				expect((await row(session.id)).workspaceMissing).toBeUndefined();
				await capture("retryRecovered", fixture);
			}
		}, 180_000);
	}

	it.each([
		"directory",
		"registration",
	] as const)("recovers one checkout shared by sibling repository folders (%s removed)", async (removal) => {
		const { fixture, socket, extra, row, create, recreate } = await start(
			`same-repository-${removal}`,
		);
		const app = join(fixture.projectDir, "app");
		const api = join(fixture.projectDir, "api");
		for (const directory of [app, api]) {
			mkdirSync(directory);
			writeFileSync(
				join(directory, "source.txt"),
				`${basename(directory)} committed\n`,
			);
		}
		git(fixture.projectDir, "add", "app", "api");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Recovery test",
			"-c",
			"user.email=recovery@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Shared folder base",
		);
		git(fixture.projectDir, "push", "origin", "main");
		folders = [app, api, extra];
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders,
		});
		const session = await create("owner");
		const mappings = session.workspace?.worktrees ?? {};
		const root = git(mappings[app] ?? "", "rev-parse", "--show-toplevel");
		expect(mappings[api]).toBe(join(root, "api"));
		expect((await row(session.id)).workspaceMissing).toBeUndefined();
		const events = workspaceEvents(fixture, session.id);
		if (removal === "registration")
			git(app, "worktree", "remove", "--force", root);
		else rmSync(root, { recursive: true, force: true });
		await capture("beforeRecovery", fixture);
		expect(
			(await row(session.id)).workspaceMissing?.folders?.map(
				({ folder }) => folder,
			),
		).toEqual([app, api]);
		expect((await row(session.id)).workspaceMissing?.canRecreate).toBe(true);
		await recreate(session.id);
		for (const folder of [app, api])
			expect(
				readFileSync(join(mappings[folder] ?? "", "source.txt"), "utf8"),
			).toBe(`${basename(folder)} committed\n`);
		expect((await row(session.id)).workspaceMissing).toBeUndefined();
		expect(
			git(app, "worktree", "list", "--porcelain").split("\n\n").filter(Boolean),
		).toHaveLength(2);
		expect(workspaceEvents(fixture, session.id)).toEqual(events);
		await capture("afterRecovery", fixture);
	}, 180_000);

	it("recovers a missing extra checkout shared with another session", async () => {
		const { fixture, socket, extra, row, create, recreate } =
			await start("shared");
		const owner = await create("owner");
		const reader = await create("reader", false);
		const path = owner.workspace?.worktrees[extra] ?? "";
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: reader.id,
			path,
		});
		const readerWorkspace = (await row(reader.id)).workspace;
		expect(readerWorkspace?.worktrees[extra]).toBe(path);
		const events = workspaceEvents(fixture, owner.id);
		rmSync(path, { recursive: true, force: true });
		await capture("beforeRecovery", fixture);
		await recreate(owner.id);
		expect((await row(owner.id)).workspaceMissing).toBeUndefined();
		expect((await row(reader.id)).workspace).toEqual(readerWorkspace);
		expect((await row(reader.id)).git?.branch).toBe(
			git(path, "branch", "--show-current"),
		);
		expect(workspaceEvents(fixture, owner.id)).toEqual(events);
		await capture("afterRecovery", fixture);
	}, 180_000);

	it("reports a missing extra after restart and publishes recovery to both feeds", async () => {
		const { fixture, extra, row, create, recreate } = await start("restart");
		const session = await create("owner");
		rmSync(session.workspace?.worktrees[extra] ?? "", {
			recursive: true,
			force: true,
		});
		const missing = (await row(session.id)).workspaceMissing;
		expect(missing?.folders?.map(({ folder }) => folder)).toEqual([extra]);
		await capture("beforeRestart", fixture);
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		expect((await row(session.id)).workspaceMissing).toEqual(missing);
		expect((await row(session.id)).workspace).toEqual(session.workspace);
		const browser = await fixture.connect();
		await browser.view(session.id);
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const)
					expect(
						latestRow(browser, feed, session.id)?.workspaceMissing,
					).toEqual(missing);
			},
			{ timeout: 15_000 },
		);
		await capture("beforeRecovery", fixture);
		await recreate(session.id);
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const) {
					const state = latestRow(browser, feed, session.id);
					expect(state).toBeDefined();
					expect(state?.workspaceMissing).toBeUndefined();
					expect(
						state?.git?.folders?.find(({ root }) => root === extra)?.branch,
					).toBeDefined();
				}
			},
			{ timeout: 15_000 },
		);
		await capture("afterRecovery", fixture);
	}, 180_000);
});
