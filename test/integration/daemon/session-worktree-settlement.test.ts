/*
 * Failure modes, pinned before implementation:
 * - Two worktrees inherit the project's branch/merge result, or Local gets a badge.
 * - A merge into local main counts before the remote default branch is fetched.
 * - The merge never reaches the existing settlement sweep with the app closed.
 * - Settlement ends/archives a session or removes its workspace or checkout.
 * - A follow-up restarts Claude in the project folder instead of the worktree.
 * - A later default-branch advance, cache refresh or restart re-settles resumed work.
 * - Manual settlement fails to consume a merge, then hides a follow-up again.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreateSession,
	ListDaemonSessions,
	MarkSessionSeen,
	SetSessionSettled,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { effectiveWorkingDirectory } from "../../../src/lib/session/session-workspace.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

const commit = (directory: string, file: string) => {
	writeFileSync(join(directory, file), `${file}\n`);
	git(directory, "add", file);
	git(
		directory,
		"-c",
		"user.name=Settlement test",
		"-c",
		"user.email=settle@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-qm",
		file,
	);
};

describe("Worktree branch settlement through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let strategy = "setup";
	let evidence: Record<string, unknown> = {};
	let ownedWorktreeName: string | undefined;
	const names = new Map<string, string>();
	const branches = new Map<string, string>();
	const heads = new Map<string, string>();

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			if (task.result?.errors?.length) {
				evidence["daemonLogs"] = fixture.logTail.slice(-4_000);
				evidence["currentSessions"] = (
					await sendRpcRequest(
						join(fixture.configDir, "relay.sock"),
						new ListDaemonSessions({
							projectSlug: "process-test",
							scope: "process-test",
						}),
					)
				).sessions;
			}
			if (existsSync(fixture.projectStorePath())) {
				const db = new Database(fixture.projectStorePath(), { readonly: true });
				try {
					if (task.result?.errors?.length)
						evidence["settleFacts"] = db
							.prepare(
								"SELECT id, status, settled_at, auto_settle_disabled_at, unread, unsettled_at, last_message_at, (SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id AND role = 'user') AS latest_user_at, (SELECT state FROM turns WHERE turns.session_id = sessions.id ORDER BY requested_at DESC LIMIT 1) AS latest_turn FROM sessions WHERE parent_id IS NULL",
							)
							.all();
					evidence["lifecycle"] = db
						.prepare(
							"SELECT session_id, type, data FROM events WHERE type IN ('session.workspace_changed', 'session.settled', 'session.unsettled', 'session.deleted', 'session.archived') ORDER BY sequence",
						)
						.all()
						.map((row) => {
							const event = row as {
								session_id: string;
								type: string;
								data: string;
							};
							return {
								session: event.session_id,
								type: event.type,
								data: JSON.parse(event.data) as unknown,
							};
						});
				} finally {
					db.close();
				}
			}
			evidence["launches"] = [...names].map(([id, session]) => ({
				session,
				turns: sessionQueries(fixture, id).map(({ options, resumeId }) => ({
					cwd: options["cwd"],
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
				for (const [branch, name] of branches)
					normalized = normalized.replaceAll(branch, name);
				if (ownedWorktreeName)
					normalized = normalized.replaceAll(
						ownedWorktreeName,
						"owned-worktree",
					);
				for (const [id, name] of names)
					normalized = normalized.replaceAll(id, name);
				for (const [head, name] of heads)
					normalized = normalized.replaceAll(head, name);
				normalized = normalized
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>");
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-8-merge-${strategy}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it.each([
		"no-ff",
		"ff-only",
	])("settles only the merged worktree after %s and resumes it in place", async (mergeStrategy) => {
		strategy = mergeStrategy;
		evidence = {};
		ownedWorktreeName = undefined;
		names.clear();
		branches.clear();
		heads.clear();
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create();
		const fixture = harness;
		const remote = join(fixture.root, "origin.git");
		const seed = join(fixture.root, "seed");
		git(fixture.root, "init", "--bare", remote);
		git(fixture.root, "init", "-b", "trunk", seed);
		commit(seed, "base.txt");
		git(seed, "push", remote, "trunk");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
		git(fixture.root, "clone", remote, fixture.projectDir);
		git(fixture.projectDir, "branch", "-m", "main");
		const existing = join(fixture.root, "existing");
		git(
			fixture.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/existing",
			existing,
		);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const sessions = async () =>
			(
				await sendRpcRequest(
					socket,
					new ListDaemonSessions({
						projectSlug: "process-test",
						scope: "process-test",
					}),
				)
			).sessions;
		const create = async (
			title: string,
			options: { newWorktree?: boolean; worktreePath?: string } = {},
		) => {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "settlement-test",
					providerId: "claude",
					title,
					...options,
				}),
			);
			names.set(sessionId, title);
			return sessionId;
		};
		const ownedId = await create("owned", { newWorktree: true });
		const otherId = await create("existing", { worktreePath: existing });
		const localId = await create("local");
		const row = (rows: readonly SessionInfo[], id: string) => {
			const session = rows.find((item) => item.id === id);
			if (!session) throw new Error(`Missing session ${names.get(id)}`);
			return session;
		};
		const snapshot = async (stage: string) => {
			const rows = await sessions();
			evidence[stage] = [ownedId, otherId, localId].map((id) => {
				const session = row(rows, id);
				const directory = effectiveWorkingDirectory(
					fixture.projectDir,
					session.workspace,
				);
				const fullHead = git(directory, "rev-parse", "HEAD");
				if (!heads.has(fullHead)) heads.set(fullHead, `<head:${heads.size}>`);
				if (session.git?.head && fullHead.startsWith(session.git.head))
					heads.set(session.git.head, heads.get(fullHead) ?? "<head>");
				return {
					session: id,
					workspace: session.workspace ?? null,
					cwd: directory,
					branchBadge:
						directory === fixture.projectDir ? null : session.git?.branch,
					git: session.git ?? null,
					merged: session.git?.merged ?? false,
					settled: session.settledAt != null,
					status: session.status,
					worktree: {
						exists: existsSync(directory),
						branch: git(directory, "branch", "--show-current"),
						head: fullHead,
						dirty: git(directory, "status", "--porcelain").length > 0,
						unmerged:
							Number(
								git(
									directory,
									"rev-list",
									"--count",
									"HEAD",
									"--not",
									"origin/trunk",
								),
							) > 0,
						unpushed:
							Number(
								git(
									directory,
									"rev-list",
									"--count",
									"HEAD",
									"--not",
									"--remotes=origin",
								),
							) > 0,
					},
				};
			});
			return rows;
		};
		const initial = await snapshot("initial");
		const owned = row(initial, ownedId);
		const ownedPath = owned.workspace?.worktrees[fixture.projectDir];
		const ownedBranch = owned.git?.branch;
		if (!ownedPath || !ownedBranch)
			throw new Error("Owned workspace was not published");
		ownedWorktreeName = basename(ownedPath);
		branches.set(ownedBranch, "<branch:owned>");
		expect(row(initial, otherId).git?.branch).toBe("feature/existing");
		expect(ownedBranch).not.toBe("feature/existing");
		expect(row(initial, localId).workspace ?? null).toBeNull();
		const browser = await fixture.connect();
		await browser.view(ownedId);
		await browser.send(
			ownedId,
			"workspace-isolation-write before merge",
			120_000,
		);
		commit(ownedPath, "owned.txt");
		git(ownedPath, "add", "session-only.txt");
		git(
			ownedPath,
			"-c",
			"user.name=Settlement test",
			"-c",
			"user.email=settle@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-qm",
			"Agent work",
		);
		await browser.view(otherId);
		await browser.send(
			otherId,
			"workspace-isolation-write parallel work",
			120_000,
		);
		commit(existing, "other.txt");
		await browser.view(localId);
		for (const sessionId of [ownedId, otherId])
			await sendRpcRequest(
				socket,
				new MarkSessionSeen({
					projectSlug: "process-test",
					sessionId,
					upTo: Date.now(),
					originId: "settlement-test",
				}),
			);
		await browser.close();
		await snapshot("beforeMerge");
		git(seed, "fetch", fixture.projectDir, ownedBranch);
		git(
			seed,
			"-c",
			"user.name=Settlement test",
			"-c",
			"user.email=settle@example.test",
			"merge",
			`--${mergeStrategy}`,
			"-m",
			"Merge owned work",
			"FETCH_HEAD",
		);
		git(seed, "push", remote, "trunk");
		git(fixture.projectDir, "fetch", "origin");
		// Startup runs the same background sweep and exercises the cold-project reader.
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		await vi.waitFor(
			async () => {
				const rows = await sessions();
				expect(row(rows, ownedId).settledAt).toBeDefined();
			},
			{ timeout: 30_000 },
		);
		const settled = await snapshot("afterMerge");
		expect(row(settled, ownedId)).toMatchObject({
			git: { branch: ownedBranch, merged: true },
			settledAutomatically: true,
			status: "idle",
			workspace: owned.workspace,
		});
		expect(row(settled, otherId).git?.merged).toBe(false);
		expect(row(settled, otherId).settledAt).toBeUndefined();
		expect(row(settled, localId).settledAt).toBeUndefined();
		expect(existsSync(ownedPath)).toBe(true);
		const resumed = await fixture.connect();
		await resumed.view(ownedId);
		await resumed.send(
			ownedId,
			"workspace-isolation-write after merge",
			120_000,
		);
		expect(readFileSync(join(ownedPath, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write after merge",
		);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		expect(readFileSync(join(existing, "session-only.txt"), "utf8")).toBe(
			"workspace-isolation-write parallel work",
		);
		expect(
			sessionQueries(fixture, ownedId).map(({ options }) => options["cwd"]),
		).toEqual([ownedPath, ownedPath]);
		const active = await snapshot("resumed");
		expect(row(active, ownedId).settledAt).toBeUndefined();
		expect(row(active, ownedId).workspace).toEqual(owned.workspace);
		await resumed.view(localId);
		await sendRpcRequest(
			socket,
			new MarkSessionSeen({
				projectSlug: "process-test",
				sessionId: ownedId,
				upTo: Date.now(),
				originId: "settlement-test",
			}),
		);
		await resumed.close();
		commit(seed, "unrelated-default-work.txt");
		git(seed, "push", remote, "trunk");
		git(fixture.projectDir, "fetch", "origin");
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		// Fence the startup sweep with its completed git refresh before inspecting state.
		await vi.waitFor(
			async () => expect(row(await sessions(), ownedId).git?.merged).toBe(true),
			{ timeout: 30_000 },
		);
		const continued = await snapshot("afterDefaultAdvanceAndRestart");
		expect(row(continued, ownedId).settledAt).toBeUndefined();
		expect(row(continued, ownedId).workspace).toEqual(owned.workspace);
		const manual = await fixture.connect();
		await manual.view(otherId);
		git(seed, "fetch", fixture.projectDir, "feature/existing");
		git(
			seed,
			"-c",
			"user.name=Settlement test",
			"-c",
			"user.email=settle@example.test",
			"merge",
			"--no-ff",
			"-m",
			"Merge existing work",
			"FETCH_HEAD",
		);
		git(seed, "push", remote, "trunk");
		git(fixture.projectDir, "fetch", "origin");
		await sendRpcRequest(
			socket,
			new SetSessionSettled({
				projectSlug: "process-test",
				sessionId: otherId,
				settled: true,
				originId: "settlement-test",
			}),
		);
		expect(row(await sessions(), otherId).settledAt).toBeDefined();
		await manual.send(
			otherId,
			"workspace-isolation-write after manual settlement",
			120_000,
		);
		await manual.view(localId);
		await sendRpcRequest(
			socket,
			new MarkSessionSeen({
				projectSlug: "process-test",
				sessionId: otherId,
				upTo: Date.now(),
				originId: "settlement-test",
			}),
		);
		await manual.close();
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const manualResumed = await snapshot("afterManualSettlementAndResume");
		expect(row(manualResumed, otherId)).toMatchObject({
			git: { merged: true },
			workspace: row(initial, otherId).workspace,
		});
		expect(row(manualResumed, otherId).settledAt).toBeUndefined();
		expect(row(manualResumed, ownedId).settledAt).toBeUndefined();
		expect(
			sessionQueries(fixture, otherId).map(({ options }) => options["cwd"]),
		).toEqual([existing, existing]);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? AND type IN ('session.settled', 'session.unsettled', 'session.deleted', 'session.archived') ORDER BY sequence",
					)
					.all(ownedId),
			).toEqual([{ type: "session.settled" }, { type: "session.unsettled" }]);
		} finally {
			db.close();
		}
	}, 240_000);
});

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
