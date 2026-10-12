/*
 * Failure modes:
 * - An isolated session silently falls back to the main checkout after removal.
 * - A fresh read, shell publication, poll, or restart drops the missing state.
 * - A deleted branch or pruned registration is incorrectly offered for recreation.
 * - Recreation overwrites an occupied path or accepts a symlink to the main checkout.
 * - A turn racing recreation starts before the owned worktree is restored.
 * - Continue in main folder races a pending turn without recording the user move.
 * - An existing-worktree session stops automatically falling back on removal.
 * - Recreation changes the recorded workspace instead of restoring its files.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ContinueSessionInMainFolder,
	CreateSession,
	ListDaemonSessions,
	MoveSessionWorkspace,
	RecreateSessionWorktree,
	SubmitInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { SessionInfoSchema } from "../../../src/lib/shared-types.js";
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

function workspaceEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT sequence, type, data FROM events WHERE session_id = ? AND type IN ('session.workspace_changed', 'input.admitted', 'input.sent', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				data: string;
			}[]
		).map(({ data, ...event }) => ({
			...event,
			data: JSON.parse(data) as Record<string, unknown>,
		}));
	} finally {
		db.close();
	}
}

function recordedWorkspace(
	fixture: ProcessHarness,
	sessionId: string,
): unknown {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		const row = db
			.prepare("SELECT workspace FROM sessions WHERE id = ?")
			.get(sessionId) as { workspace: string | null } | undefined;
		return row?.workspace ? (JSON.parse(row.workspace) as unknown) : null;
	} finally {
		db.close();
	}
}

function sessionQueries(fixture: ProcessHarness, sessionId: string) {
	const pids = new Set(
		fixture.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	return fixture
		.claudeOptions()
		.filter(({ pid, prompt }) => pids.has(pid) && prompt !== undefined);
}

function shellRows(
	browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	sessionId: string,
	cursor = 0,
) {
	return browser.frames.slice(cursor).flatMap(({ message }) => {
		if (message["type"] !== "shell" || message["_tag"] !== "upsert") return [];
		const row = Schema.decodeUnknownSync(SessionInfoSchema)(message["item"]);
		return row.id === sessionId ? [row] : [];
	});
}

describe("Missing isolated worktrees through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	const names = new Map<string, string>();
	const branches = new Map<string, string>();
	const paths = new Map<string, string>();
	const heads = new Map<string, string>();
	let phases: Record<string, unknown>[] = [];
	let evidence: Record<string, unknown> = {};

	async function start(name: string, gateRecreation = false) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		names.clear();
		branches.clear();
		paths.clear();
		heads.clear();
		phases = [];
		evidence = {};
		const fixture = ProcessHarness.create({ restartProof: true });
		harness = fixture;
		const remote = join(fixture.root, "origin.git");
		const seed = join(fixture.root, "seed");
		git(fixture.root, "init", "--bare", remote);
		git(fixture.root, "init", "-b", "main", seed);
		writeFileSync(join(seed, "base.txt"), "committed base\n");
		git(seed, "add", "base.txt");
		commit(seed, "Initial commit");
		git(seed, "push", remote, "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
		git(fixture.root, "clone", remote, fixture.projectDir);
		heads.set(git(fixture.projectDir, "rev-parse", "HEAD"), "initial");
		paths.set(fixture.projectDir, "<main>");
		const gate = join(fixture.root, "recreate-git");
		if (gateRecreation) {
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
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const gate = ${JSON.stringify(gate)};
(async () => {
  if (args.includes("worktree") && args.includes("add") && existsSync(gate)) {
    writeFileSync(gate + "-started", "worktree add has not run");
    while (!existsSync(gate + "-release")) await new Promise(done => setTimeout(done, 10));
  }
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
})();
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
		const row = async (sessionId: string) => {
			const session = (await sessions()).sessions.find(
				({ id }) => id === sessionId,
			);
			if (!session) throw new Error(`Session ${sessionId} was not published`);
			return session;
		};
		const create = async (title: string, isolated = true) => {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					permissionMode: "ask",
					projectSlug: "process-test",
					originId: "missing-worktree-test",
					providerId: "claude",
					title,
					...(isolated ? { newWorktree: true } : {}),
				}),
			);
			names.set(sessionId, title);
			const session = await row(sessionId);
			const path = session.workspace?.worktrees[fixture.projectDir];
			if (isolated && !path)
				throw new Error("Owned workspace was not published");
			if (path) {
				paths.set(path, `<owned:${title}>`);
				branches.set(
					git(path, "branch", "--show-current"),
					`<branch:${title}>`,
				);
			}
			return { id: sessionId, path: path ?? fixture.projectDir, session };
		};
		const recreate = (sessionId: string) =>
			sendRpcRequest(
				socket,
				new RecreateSessionWorktree({ projectSlug: "process-test", sessionId }),
				{ requestTimeoutMs: 30_000 },
			);
		const continueInMain = (sessionId: string) =>
			sendRpcRequest(
				socket,
				new ContinueSessionInMainFolder({
					projectSlug: "process-test",
					sessionId,
				}),
			);
		return { fixture, socket, row, create, recreate, continueInMain, gate };
	}

	function pathState(
		path: string,
		fixture: ProcessHarness,
		registration?: string,
	) {
		const branch = registration
			?.split("\n")
			.find((line) => line.startsWith("branch refs/heads/"))
			?.slice(18);
		const registeredHead = registration
			?.split("\n")
			.find((line) => line.startsWith("HEAD "))
			?.slice(5);
		let branchHead: string | undefined;
		if (branch) {
			try {
				branchHead = git(
					fixture.projectDir,
					"rev-parse",
					"--verify",
					`refs/heads/${branch}`,
				);
			} catch {
				// The registration can survive external deletion of its branch.
			}
		}
		const head = branch ? branchHead : registeredHead;
		const missingCheckout = {
			branch: branch ?? null,
			branchExists: branch ? Boolean(branchHead) : null,
			head: head ? (heads.get(head) ?? "unexpected-head") : null,
			dirty: null,
			unpushed: branchHead
				? git(
						fixture.projectDir,
						"rev-list",
						branchHead,
						"--not",
						"--remotes=origin",
					).length > 0
				: null,
			unmerged: branchHead
				? git(fixture.projectDir, "merge-base", branchHead, "origin/main") !==
					branchHead
				: null,
		};
		const info = lstatSync(path, { throwIfNoEntry: false });
		if (!info) return { path, present: false, ...missingCheckout };
		if (info.isSymbolicLink())
			return {
				path,
				present: true,
				kind: "symlink",
				target: realpathSync(path),
				...missingCheckout,
			};
		if (!info.isDirectory()) return { path, present: true, kind: "file" };
		try {
			const head = git(path, "rev-parse", "HEAD");
			return {
				path,
				present: true,
				branch: git(path, "branch", "--show-current"),
				head: heads.get(head) ?? "unexpected-head",
				dirty: git(path, "status", "--porcelain").length > 0,
				unpushed:
					git(path, "rev-list", "HEAD", "--not", "--remotes=origin").length > 0,
				unmerged: git(path, "merge-base", "HEAD", "origin/main") !== head,
				sessionFile: existsSync(join(path, "session-only.txt"))
					? readFileSync(join(path, "session-only.txt"), "utf8")
					: null,
			};
		} catch {
			return {
				path,
				present: true,
				kind: "directory",
				repository: false,
				...missingCheckout,
			};
		}
	}

	function capture(phase: string, fixture: ProcessHarness) {
		const registrations = git(
			fixture.projectDir,
			"worktree",
			"list",
			"--porcelain",
		).split("\n\n");
		phases.push({
			phase,
			paths: [...paths]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([path]) =>
					pathState(
						path,
						fixture,
						registrations.find((entry) =>
							entry.split("\n").includes(`worktree ${path}`),
						),
					),
				),
			sessions: [...names]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([id]) => ({
					id,
					workspace: recordedWorkspace(fixture, id),
					workspaceEvents: workspaceEvents(fixture, id)
						.filter(({ type }) => type === "session.workspace_changed")
						.map(({ type, data }) => ({ type, data })),
					turnErrors: workspaceEvents(fixture, id)
						.filter(({ type }) => type === "turn.error")
						.map(({ type, data }) => ({ type, data })),
					queries: sessionQueries(fixture, id).map(({ options, resumeId }) => ({
						cwd: options["cwd"],
						resumed: Boolean(resumeId),
					})),
				})),
		});
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			if (existsSync(fixture.projectStorePath())) capture("final", fixture);
			evidence["phases"] = phases;
			evidence["result"] = task.result?.state;
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			if (task.result?.errors?.length)
				evidence["logs"] = fixture.logTail.slice(-4_000);
		} finally {
			try {
				writeFileSync(join(fixture.root, "recreate-git-release"), "release");
				writeFileSync(join(fixture.root, "release-local-work"), "release");
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				let normalized = JSON.stringify(
					evidence,
					(key, value: unknown) => {
						if (key === "timestamp" || key === "time") return "<time>";
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
				for (const [value, label] of [
					...paths,
					...branches,
					...names,
					...heads,
				].sort(([a], [b]) => b.length - a.length))
					normalized = normalized.replaceAll(value, label);
				normalized = normalized
					.replaceAll(fixture.root, "<root>")
					.replace(
						/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
						"<id>",
					)
					.replace(/\b[0-9a-f]{40}\b/g, "<commit>")
					.replace(/ses_[a-z0-9]+/g, "<session>");
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-10-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("reports external removal, blocks the provider, and recreates the same branch after restart", async () => {
		const { fixture, create, row, recreate } = await start("recreate-restart");
		const isolated = await create("isolated");
		const local = await create("main-reader", false);
		const mainHead = git(fixture.projectDir, "rev-parse", "HEAD");
		const branch = git(isolated.path, "branch", "--show-current");
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		await browser.send(
			isolated.id,
			"workspace-isolation-write before removal",
			120_000,
		);
		expect(readFileSync(join(isolated.path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write before removal",
		);
		git(isolated.path, "add", "session-only.txt");
		commit(isolated.path, "Keep isolated session work");
		const isolatedHead = git(isolated.path, "rev-parse", "HEAD");
		heads.set(isolatedHead, "isolated-commit");
		const recorded = recordedWorkspace(fixture, isolated.id);
		const moves = workspaceEvents(fixture, isolated.id).filter(
			({ type }) => type === "session.workspace_changed",
		);
		capture("before-removal", fixture);
		rmSync(isolated.path, { recursive: true, force: true });
		const missing = { path: isolated.path, branch, canRecreate: true };
		expect((await row(isolated.id)).workspaceMissing).toEqual(missing);
		const cursor = browser.frames.length;
		await browser.send(
			isolated.id,
			"workspace-isolation-write blocked",
			120_000,
		);
		expect(
			workspaceEvents(fixture, isolated.id)
				.filter(({ type }) => type === "turn.error")
				.at(-1)?.data,
		).toMatchObject({
			code: "WORKTREE_MISSING",
			error: expect.stringContaining("Worktree missing"),
		});
		expect(sessionQueries(fixture, isolated.id)).toHaveLength(1);
		await vi.waitFor(() =>
			expect(
				shellRows(browser, isolated.id, cursor).at(-1)?.workspaceMissing,
			).toEqual(missing),
		);
		evidence["missingPublication"] = shellRows(browser, isolated.id, cursor).at(
			-1,
		)?.workspaceMissing;
		expect((await row(isolated.id)).workspaceMissing).toEqual(missing);
		expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
		expect(
			workspaceEvents(fixture, isolated.id).filter(
				({ type }) => type === "session.workspace_changed",
			),
		).toEqual(moves);
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		expect(git(fixture.projectDir, "rev-parse", "HEAD")).toBe(mainHead);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		await browser.view(local.id);
		expect(
			(
				await browser.send(local.id, "workspace-isolation-read", 120_000)
			).chunks.join(""),
		).toBe("absent");
		evidence["reportedMissing"] = missing;
		capture("missing-blocked", fixture);
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		expect((await row(isolated.id)).workspaceMissing).toEqual(missing);
		expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
		expect(await recreate(isolated.id)).toEqual({ directory: isolated.path });
		expect(git(isolated.path, "branch", "--show-current")).toBe(branch);
		expect(git(isolated.path, "rev-parse", "HEAD")).toBe(isolatedHead);
		expect(readFileSync(join(isolated.path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write before removal",
		);
		expect((await row(isolated.id)).workspaceMissing).toBeUndefined();
		expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
		expect(
			workspaceEvents(fixture, isolated.id).filter(
				({ type }) => type === "session.workspace_changed",
			),
		).toEqual(moves);
		capture("recreated", fixture);
		const restarted = await fixture.connect();
		await restarted.view(isolated.id);
		await restarted.send(
			isolated.id,
			"workspace-isolation-write after recreate",
			120_000,
		);
		expect(readFileSync(join(isolated.path, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write after recreate",
		);
		expect(
			sessionQueries(fixture, isolated.id).map(({ options }) => options["cwd"]),
		).toEqual([isolated.path, isolated.path]);
		expect(sessionQueries(fixture, isolated.id).at(-1)?.resumeId).toBeTruthy();
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		expect(git(fixture.projectDir, "branch", "--show-current")).toBe("main");
		expect(git(fixture.projectDir, "rev-parse", "HEAD")).toBe(mainHead);
	}, 300_000);

	it("continues in the main folder only after recording the user's move", async () => {
		const { fixture, create, row, continueInMain } =
			await start("continue-main");
		const isolated = await create("continue");
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		await browser.send(
			isolated.id,
			"workspace-isolation-write isolated",
			120_000,
		);
		rmSync(isolated.path, { recursive: true, force: true });
		expect((await row(isolated.id)).workspaceMissing?.canRecreate).toBe(true);
		capture("missing", fixture);
		expect(await continueInMain(isolated.id)).toEqual({
			directory: fixture.projectDir,
		});
		expect(recordedWorkspace(fixture, isolated.id)).toBeNull();
		expect((await row(isolated.id)).workspaceMissing).toBeUndefined();
		const moved = workspaceEvents(fixture, isolated.id)
			.filter(({ type }) => type === "session.workspace_changed")
			.at(-1);
		expect(moved?.data).toMatchObject({
			path: fixture.projectDir,
			cause: "user",
			worktrees: {},
		});
		expect(
			workspaceEvents(fixture, isolated.id).some(
				({ data }) => data["cause"] === "missing",
			),
		).toBe(false);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		await browser.send(
			isolated.id,
			"workspace-isolation-write explicit main",
			120_000,
		);
		expect(
			readFileSync(join(fixture.projectDir, "session-only.txt"), "utf8"),
		).toBe("workspace-isolation-write explicit main");
		expect(
			sessionQueries(fixture, isolated.id).map(({ options }) => options["cwd"]),
		).toEqual([isolated.path, fixture.projectDir]);
		expect(existsSync(isolated.path)).toBe(false);
	}, 300_000);

	it("keeps the automatic missing fallback for a session moved into an existing worktree", async () => {
		const { fixture, socket, create, row } = await start("existing-fallback");
		const local = await create("existing", false);
		const path = join(fixture.root, "existing-worktree");
		git(fixture.projectDir, "worktree", "add", "-b", "feature/existing", path);
		paths.set(path, "<existing-worktree>");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: local.id,
				path,
			}),
		);
		expect((await row(local.id)).workspace?.origin).toBe("existing");
		const browser = await fixture.connect();
		await browser.view(local.id);
		await browser.send(local.id, "workspace-isolation-write existing", 120_000);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		rmSync(path, { recursive: true, force: true });
		capture("existing-missing", fixture);
		await browser.send(
			local.id,
			"workspace-isolation-write existing fallback",
			120_000,
		);
		expect((await row(local.id)).workspace).toEqual({
			cause: "missing",
			origin: "existing",
			worktrees: {},
		});
		expect((await row(local.id)).workspaceMissing).toBeUndefined();
		expect(
			workspaceEvents(fixture, local.id).filter(
				({ data }) => data["cause"] === "missing",
			),
		).toHaveLength(1);
		expect(
			readFileSync(join(fixture.projectDir, "session-only.txt"), "utf8"),
		).toBe("workspace-isolation-write existing fallback");
		expect(
			sessionQueries(fixture, local.id).map(({ options }) => options["cwd"]),
		).toEqual([path, fixture.projectDir]);
	}, 300_000);

	it.each([
		"deleted",
		"pruned",
	] as const)("refuses recreation when the branch is %s and still allows an explicit move to main", async (loss) => {
		const { fixture, create, row, recreate, continueInMain } = await start(
			`branch-${loss}`,
		);
		const isolated = await create(loss);
		const branch = git(isolated.path, "branch", "--show-current");
		rmSync(isolated.path, { recursive: true, force: true });
		if (loss === "deleted")
			git(fixture.projectDir, "update-ref", "-d", `refs/heads/${branch}`);
		else git(fixture.projectDir, "worktree", "prune");
		const reason = loss === "deleted" ? "branch-missing" : "branch-unknown";
		const missing = (await row(isolated.id)).workspaceMissing;
		expect(missing).toMatchObject({
			path: isolated.path,
			canRecreate: false,
			reason,
		});
		expect(missing?.branch).toBe(loss === "deleted" ? branch : undefined);
		evidence["reportedMissing"] = missing;
		const recorded = recordedWorkspace(fixture, isolated.id);
		await expect(recreate(isolated.id)).rejects.toMatchObject({
			_tag: "WorktreeRecoveryError",
			path: isolated.path,
			reason,
		});
		expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
		expect(existsSync(isolated.path)).toBe(false);
		expect(sessionQueries(fixture, isolated.id)).toEqual([]);
		capture("recreate-refused", fixture);
		expect(await continueInMain(isolated.id)).toEqual({
			directory: fixture.projectDir,
		});
		expect(recordedWorkspace(fixture, isolated.id)).toBeNull();
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		await browser.send(
			isolated.id,
			"workspace-isolation-write branch unavailable",
			120_000,
		);
		expect(
			sessionQueries(fixture, isolated.id).map(({ options }) => options["cwd"]),
		).toEqual([fixture.projectDir]);
		expect(
			readFileSync(join(fixture.projectDir, "session-only.txt"), "utf8"),
		).toBe("workspace-isolation-write branch unavailable");
	}, 300_000);

	it.each([
		"directory",
		"symlink",
	] as const)("preserves an occupied %s and never launches through it", async (occupant) => {
		const { fixture, create, row, recreate } = await start(
			`occupied-${occupant}`,
		);
		const isolated = await create(occupant);
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		rmSync(isolated.path, { recursive: true, force: true });
		if (occupant === "directory") {
			mkdirSync(isolated.path);
			writeFileSync(join(isolated.path, "keep.txt"), "external files\n");
		} else symlinkSync(fixture.projectDir, isolated.path);
		expect((await row(isolated.id)).workspaceMissing).toMatchObject({
			path: isolated.path,
			canRecreate: true,
		});
		const recorded = recordedWorkspace(fixture, isolated.id);
		await expect(recreate(isolated.id)).rejects.toMatchObject({
			_tag: "WorktreeRecoveryError",
			path: isolated.path,
			reason: "target-exists",
		});
		await browser.send(
			isolated.id,
			"workspace-isolation-write unsafe path",
			120_000,
		);
		expect(
			workspaceEvents(fixture, isolated.id)
				.filter(({ type }) => type === "turn.error")
				.at(-1)?.data,
		).toMatchObject({ code: "WORKTREE_MISSING" });
		expect(sessionQueries(fixture, isolated.id)).toEqual([]);
		expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		if (occupant === "directory")
			expect(readFileSync(join(isolated.path, "keep.txt"), "utf8")).toBe(
				"external files\n",
			);
		else {
			expect(lstatSync(isolated.path).isSymbolicLink()).toBe(true);
			expect(realpathSync(isolated.path)).toBe(fixture.projectDir);
		}
	}, 300_000);

	it("holds a racing turn until recreation has restored the recorded workspace", async () => {
		const { fixture, socket, create, recreate, gate } = await start(
			"recreate-racing-turn",
			true,
		);
		const isolated = await create("racing");
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		const recorded = recordedWorkspace(fixture, isolated.id);
		const held = browser.send(isolated.id, "local-work-turn", 120_000);
		const recreating = (async () => {
			await vi.waitFor(
				() =>
					expect(
						fixture.marks.some(
							(mark) =>
								mark.kind === "pre-assistant-held" &&
								mark.prompt === "local-work-turn",
						),
					).toBe(true),
				{ timeout: 90_000 },
			);
			rmSync(isolated.path, { recursive: true, force: true });
			writeFileSync(gate, "hold");
			return recreate(isolated.id);
		})().then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		try {
			await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true), {
				timeout: 90_000,
			});
			const inputId = randomUUID();
			const cursor = browser.frames.length;
			await sendRpcRequest(
				socket,
				new SubmitInput({
					projectSlug: "process-test",
					sessionId: isolated.id,
					inputId,
					delivery: "queue",
					text: "workspace-isolation-write raced recreate",
				}),
			);
			expect(
				workspaceEvents(fixture, isolated.id).some(
					({ type, data }) =>
						type === "input.admitted" && data["inputId"] === inputId,
				),
			).toBe(true);
			// Queue while the existing turn is held so submission itself can finish.
			// Ending that turn starts the drain while recovery still owns the lock.
			writeFileSync(join(fixture.root, "release-local-work"), "release");
			const heldResult = await held;
			expect(
				sessionQueries(fixture, isolated.id).map(
					({ options }) => options["cwd"],
				),
			).toEqual([isolated.path]);
			expect(
				workspaceEvents(fixture, isolated.id).filter(
					({ type }) => type === "turn.error",
				),
			).toEqual([]);
			expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
				false,
			);
			// Recovery reserves the directory before invoking Git. It is not a
			// usable checkout until worktree add has installed its .git marker.
			expect(existsSync(join(isolated.path, ".git"))).toBe(false);
			expect(existsSync(join(isolated.path, "session-only.txt"))).toBe(false);
			capture("recreation-held-with-input", fixture);
			writeFileSync(`${gate}-release`, "release");
			expect(await recreating).toEqual({ value: { directory: isolated.path } });
			await browser.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === isolated.id &&
					message["status"] === "idle" &&
					Number(message["lastTurnEndVersion"] ?? -1) >
						Number(heldResult.done["lastTurnEndVersion"] ?? Infinity),
				cursor,
				120_000,
			);
			expect(
				sessionQueries(fixture, isolated.id).map(
					({ options }) => options["cwd"],
				),
			).toEqual([isolated.path, isolated.path]);
			expect(
				readFileSync(join(isolated.path, "session-only.txt"), "utf8"),
			).toBe("workspace-isolation-write raced recreate");
			expect(recordedWorkspace(fixture, isolated.id)).toEqual(recorded);
			expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		} finally {
			writeFileSync(`${gate}-release`, "release");
			writeFileSync(join(fixture.root, "release-local-work"), "release");
			await Promise.all([held, recreating]);
		}
	}, 300_000);

	it("records Continue while a turn is running and launches its queued successor in main", async () => {
		const { fixture, socket, create, continueInMain } = await start(
			"continue-pending-turn",
		);
		const isolated = await create("pending");
		const browser = await fixture.connect();
		await browser.view(isolated.id);
		await browser.send(
			isolated.id,
			"workspace-isolation-write before pending turn",
			120_000,
		);
		const held = browser.send(isolated.id, "local-work-turn", 120_000);
		try {
			await vi.waitFor(() =>
				expect(
					fixture.marks.some(
						(mark) =>
							mark.kind === "pre-assistant-held" &&
							mark.prompt === "local-work-turn",
					),
				).toBe(true),
			);
			rmSync(isolated.path, { recursive: true, force: true });
			const inputId = randomUUID();
			const cursor = browser.frames.length;
			await sendRpcRequest(
				socket,
				new SubmitInput({
					projectSlug: "process-test",
					sessionId: isolated.id,
					inputId,
					delivery: "queue",
					text: "workspace-isolation-write queued after Continue",
				}),
			);
			const before = workspaceEvents(fixture, isolated.id);
			const admitted = before.find(
				({ type, data }) =>
					type === "input.admitted" && data["inputId"] === inputId,
			);
			expect(admitted).toBeDefined();
			expect(
				before.some(
					({ type, data }) =>
						type === "input.sent" && data["inputId"] === inputId,
				),
			).toBe(false);
			expect(await continueInMain(isolated.id)).toEqual({
				directory: fixture.projectDir,
			});
			expect(recordedWorkspace(fixture, isolated.id)).toBeNull();
			expect(
				sessionQueries(fixture, isolated.id).map(
					({ options }) => options["cwd"],
				),
			).toEqual([isolated.path, isolated.path]);
			expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
				false,
			);
			const moved = workspaceEvents(fixture, isolated.id)
				.filter(({ type }) => type === "session.workspace_changed")
				.at(-1);
			expect(moved?.data).toMatchObject({
				path: fixture.projectDir,
				cause: "user",
				worktrees: {},
			});
			expect(moved?.sequence).toBeGreaterThan(admitted?.sequence ?? Infinity);
			capture("continued-with-turn-held", fixture);
			writeFileSync(join(fixture.root, "release-local-work"), "release");
			const heldResult = await held;
			await browser.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === isolated.id &&
					message["status"] === "idle" &&
					Number(message["lastTurnEndVersion"] ?? -1) >
						Number(heldResult.done["lastTurnEndVersion"] ?? Infinity),
				cursor,
				120_000,
			);
			expect(
				readFileSync(join(fixture.projectDir, "session-only.txt"), "utf8"),
			).toBe("workspace-isolation-write queued after Continue");
			expect(
				sessionQueries(fixture, isolated.id).map(
					({ options }) => options["cwd"],
				),
			).toEqual([isolated.path, isolated.path, fixture.projectDir]);
			const sent = workspaceEvents(fixture, isolated.id).find(
				({ type, data }) =>
					type === "input.sent" && data["inputId"] === inputId,
			);
			expect(sent?.sequence).toBeGreaterThan(moved?.sequence ?? Infinity);
			expect(
				workspaceEvents(fixture, isolated.id).some(
					({ data }) => data["cause"] === "missing",
				),
			).toBe(false);
		} finally {
			writeFileSync(join(fixture.root, "release-local-work"), "release");
			await held;
		}
	}, 300_000);
});

function commit(directory: string, message: string) {
	git(
		directory,
		"-c",
		"user.name=Workspace test",
		"-c",
		"user.email=workspace@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-m",
		message,
	);
}
