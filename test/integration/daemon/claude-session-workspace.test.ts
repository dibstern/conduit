import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
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
	ListDaemonSessions,
	MoveSessionWorkspace,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../../src/lib/persistence/events.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function initRepo(directory: string, branch = "main") {
	mkdirSync(directory, { recursive: true });
	git(directory, "init", "-b", branch);
	git(
		directory,
		"-c",
		"user.name=Workspace test",
		"-c",
		"user.email=workspace@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--allow-empty",
		"-m",
		"Initial commit",
	);
}

function events(fixture: ProcessHarness) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT session_id, type, data, metadata FROM events WHERE type IN ('session.workspace_changed', 'session.workspace_started', 'tool.completed', 'session.status', 'turn.completed') ORDER BY sequence",
			)
			.all()
			.map((row) => {
				const event = row as {
					session_id: string;
					type: string;
					data: string;
					metadata: string;
				};
				return {
					sessionId: event.session_id,
					type: event.type,
					data: JSON.parse(event.data) as Record<string, unknown>,
					metadata: JSON.parse(event.metadata) as Record<string, unknown>,
				};
			});
	} finally {
		db.close();
	}
}

function moves(fixture: ProcessHarness, sessionId: string) {
	return events(fixture)
		.filter(
			(event) =>
				event.sessionId === sessionId &&
				event.type === "session.workspace_changed",
		)
		.map(({ data }) =>
			Schema.decodeUnknownSync(SessionWorkspaceChangedPayloadSchema)(data),
		);
}

describe("Claude declared workspace moves through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(
		name: string,
		replay: NonNullable<
			Parameters<typeof ProcessHarness.create>[0]
		>["claudeReplay"],
		beforeRestart?: (fixture: ProcessHarness) => void,
	) {
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({ claudeReplay: replay });
		initRepo(harness.projectDir);
		const entered = join(
			harness.projectDir,
			".claude",
			"worktrees",
			"contract",
		);
		git(
			harness.projectDir,
			"worktree",
			"add",
			"-b",
			"worktree-contract",
			entered,
		);
		writeFileSync(join(entered, "dirty.txt"), "agent workspace\n");
		const user = join(harness.root, "user-worktree");
		git(harness.projectDir, "worktree", "add", "-b", "user-destination", user);
		beforeRestart?.(harness);
		await harness.restart();
		const socket = join(harness.configDir, "relay.sock");
		return {
			fixture: harness,
			main: realpathSync(harness.projectDir),
			entered: realpathSync(entered),
			user: realpathSync(user),
			socket,
			list: () =>
				sendRpcRequest(
					socket,
					new ListDaemonSessions({
						projectSlug: "process-test",
						scope: "process-test",
					}),
				),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["events"] = existsSync(fixture.projectStorePath())
				? events(fixture)
				: [];
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			if (task.result?.errors?.length)
				evidence["diagnosticLogs"] = fixture.logTail
					.replace(/\(node:\d+\)/g, "(node:<pid>)")
					.replace(/"time":\d+/g, '"time":"<time>"')
					.replace(/"pid":\d+/g, '"pid":"<pid>"')
					.replace(/"hostname":"[^"]+"/g, '"hostname":"<host>"')
					.replace(/ses_[a-z0-9]+/g, "<session>");
		} finally {
			// Release a paused trace even when its assertion fails.
			writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
			writeFileSync(join(fixture.root, "git-resolution-release"), "release\n");
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
			} finally {
				mkdirSync("test-results", { recursive: true });
				const sessions = new Map<string, string>();
				const normalized = JSON.stringify(
					evidence,
					(key, value: unknown) => {
						if (key === "sessionId" && typeof value === "string") {
							if (!sessions.has(value))
								sessions.set(value, `session-${sessions.size + 1}`);
							return sessions.get(value);
						}
						if (/Id$/.test(key)) return "<id>";
						if (key === "head") return "<commit>";
						if (
							value !== null &&
							typeof value === "object" &&
							!Array.isArray(value)
						)
							return Object.fromEntries(
								Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
							);
						return value;
					},
					2,
				)
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>");
				writeFileSync(
					`test-results/q5u6-1-4-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it.each([
		"primary",
		"secondary",
	] as const)("follows captured EnterWorktree and ExitWorktree in the %s folder during the turn without restarting the runner", async (folder) => {
		const {
			fixture,
			main,
			entered: primaryWorktree,
			socket,
			list,
		} = await start(`declared-${folder}`, {
			turns: [
				"enter-worktree-turn",
				"pong-thinking-text-turn",
				"exit-worktree-keep-turn",
				"pong-thinking-text-turn",
			],
			holdBeforeResult: true,
			...(folder === "secondary"
				? { enterPath: "../extra-repo/.claude/worktrees/contract" }
				: {}),
		});
		let entered = primaryWorktree;
		let projectFolder = main;
		if (folder === "secondary") {
			const extra = join(fixture.root, "extra-repo");
			initRepo(extra);
			entered = join(extra, ".claude", "worktrees", "contract");
			git(extra, "worktree", "add", "-b", "worktree-contract", entered);
			writeFileSync(join(entered, "dirty.txt"), "agent workspace\n");
			projectFolder = realpathSync(extra);
			entered = realpathSync(entered);
			await sendRpcRequest(
				socket,
				new SaveProject({
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				}),
			);
		}
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Declared moves");
		const enteredTurn = browser.send(sessionId, "Enter a worktree.");
		void enteredTurn.catch(() => {});
		await vi.waitFor(
			async () => {
				const { sessions } = await list();
				expect(sessions.find(({ id }) => id === sessionId)).toMatchObject({
					workspace: {
						cause: "agent",
						worktrees: { [projectFolder]: entered },
					},
					git: {
						branch: "worktree-contract",
						worktree: "contract",
						dirty: true,
					},
				});
			},
			{ timeout: 15_000 },
		);
		expect(
			events(fixture).filter(
				(event) =>
					event.type === "turn.completed" && event.sessionId === sessionId,
			),
		).toEqual([]);
		evidence["enteredDuringTurn"] = (await list()).sessions.find(
			({ id }) => id === sessionId,
		)?.git;
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		await enteredTurn;
		await browser.send(sessionId, "Reply with pong in the worktree.");
		const runnerStarts = () =>
			new Set(
				fixture.marks.flatMap((mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId
						? [mark.pid]
						: [],
				),
			).size;
		expect(runnerStarts()).toBe(1);
		rmSync(join(fixture.root, "claude-replay-release"));
		const exitTurn = browser.send(sessionId, "Exit the worktree and keep it.");
		void exitTurn.catch(() => {});
		await vi.waitFor(
			async () => {
				const { sessions } = await list();
				const session = sessions.find(({ id }) => id === sessionId);
				expect(session?.workspace ?? null).toBeNull();
				expect(session?.git?.branch).toBe("main");
				expect(session?.git?.worktree).toBeUndefined();
			},
			{ timeout: 15_000 },
		);
		expect(
			events(fixture).filter(
				(event) =>
					event.type === "turn.completed" && event.sessionId === sessionId,
			),
		).toHaveLength(2);
		evidence["exitedDuringTurn"] = (await list()).sessions.find(
			({ id }) => id === sessionId,
		)?.git;
		writeFileSync(join(fixture.root, "claude-replay-release"), "release\n");
		await exitTurn;
		await browser.send(sessionId, "Reply with pong back in the main folder.");
		expect(runnerStarts()).toBe(1);
		expect(moves(fixture, sessionId)).toEqual([
			{
				sessionId,
				cause: "agent",
				worktrees: { [projectFolder]: entered },
				origin: "existing",
			},
			{ sessionId, cause: "agent", worktrees: {}, origin: "existing" },
		]);
		const recorded = events(fixture);
		expect(
			recorded.filter(({ type }) => type === "tool.completed"),
		).toHaveLength(4);
		expect(
			recorded
				.filter(({ type }) => type === "session.workspace_started")
				.map(({ data }) => data),
		).toEqual([{ sessionId, path: main }]);
		for (const { metadata } of recorded) {
			expect(metadata).not.toHaveProperty("claudeWorktree");
			expect(metadata).not.toHaveProperty("workspaceCwd");
		}
		for (const { options } of fixture
			.claudeOptions()
			.filter(({ options }) => options["includePartialMessages"] === true)) {
			expect(options["systemPrompt"]).toBeTypeOf("string");
			expect(options["systemPrompt"]).toContain("EnterWorktree");
		}
		evidence["runnerStarts"] = runnerStarts();
	});

	it.each([
		"user",
		"agent",
	] as const)("lets another session append provider events while a %s move resolves slow git", async (cause) => {
		const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
			env: gitEnv,
			encoding: "utf8",
		}).trim();
		const { fixture, entered, user, socket } = await start(
			`slow-git-${cause}`,
			{
				turns: [
					"pong-thinking-text-turn",
					"enter-worktree-turn",
					"pong-thinking-text-turn",
				],
			},
			(fixture) => {
				const bin = join(fixture.root, "git-bin");
				mkdirSync(bin);
				const arm = join(fixture.root, "git-resolution-arm");
				const started = join(fixture.root, "git-resolution-started");
				const release = join(fixture.root, "git-resolution-release");
				const target =
					cause === "user"
						? join(fixture.root, "user-worktree")
						: join(fixture.projectDir, ".claude", "worktrees", "contract");
				// Block just worktree discovery, not git polling. All paths are harness-owned.
				writeFileSync(
					join(bin, "git"),
					`#!/bin/sh
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR
if [ "$PWD" = '${target}' ] && [ "$*" = 'rev-parse --git-common-dir' ] && [ -f '${arm}' ]; then
  touch '${started}'
  while [ ! -f '${release}' ]; do sleep 0.01; done
fi
exec '${realGit}' "$@"
`,
					{ mode: 0o755 },
				);
				vi.stubEnv("PATH", `${bin}:${gitEnv["PATH"] ?? ""}`);
			},
		);
		const arm = join(fixture.root, "git-resolution-arm");
		const started = join(fixture.root, "git-resolution-started");
		const release = join(fixture.root, "git-resolution-release");
		const target = cause === "user" ? user : entered;
		const moving = await fixture.connect();
		const sessionId = await moving.createSession("Slow workspace resolution");
		await moving.send(sessionId, "Reply with pong before moving.");
		const other = await fixture.connect();
		const otherSessionId = await other.createSession("Independent session");
		await other.send(
			otherSessionId,
			"Reply with pong before the other session moves.",
		);
		await other.send(
			otherSessionId,
			"Enter the worktree before the slow resolution.",
		);
		const completedBefore = events(fixture).filter(
			({ sessionId: id, type }) =>
				id === otherSessionId && type === "turn.completed",
		).length;
		writeFileSync(arm, "arm\n");
		const move =
			cause === "user"
				? sendRpcRequest(
						socket,
						new MoveSessionWorkspace({
							projectSlug: "process-test",
							sessionId,
							path: user,
						}),
					)
				: moving.send(
						sessionId,
						"Enter the worktree while git resolution is slow.",
					);
		void move.catch(() => {});
		try {
			await vi.waitFor(() => expect(existsSync(started)).toBe(true), {
				timeout: 10_000,
				interval: 10,
			});
			const otherTurn = other.send(
				otherSessionId,
				"Continue while the other session resolves git.",
			);
			void otherTurn.catch(() => {});
			await vi.waitFor(
				() => {
					expect(
						events(fixture).filter(
							({ sessionId: id, type }) =>
								id === otherSessionId && type === "turn.completed",
						),
					).toHaveLength(completedBefore + 1);
				},
				{ timeout: 1_200, interval: 10 },
			);
			await otherTurn;
			expect(existsSync(release)).toBe(false);
			expect(moves(fixture, sessionId)).toEqual([]);
			evidence["concurrency"] = {
				otherSessionAppendedDuringResolution: true,
				cause,
			};
		} finally {
			writeFileSync(release, "release\n");
		}
		await move;
		expect(moves(fixture, sessionId).at(-1)).toMatchObject({
			cause,
			worktrees: { [fixture.projectDir]: target },
		});
	}, 60_000);

	it("restarts when a configured extra folder is replaced after a declared move", async () => {
		const { fixture, entered, socket } = await start("configured-replacement", {
			turns: [
				"enter-worktree-turn",
				"pong-thinking-text-turn",
				"exit-worktree-keep-turn",
				"pong-thinking-text-turn",
			],
		});
		const extra = join(fixture.root, "extra-repo");
		initRepo(extra);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			}),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Configured replacement");
		await browser.send(sessionId, "Enter a worktree.");
		await browser.send(sessionId, "Reply with pong in the worktree.");
		await browser.send(sessionId, "Exit the worktree and keep it.");
		const runnerStarts = () =>
			new Set(
				fixture.marks.flatMap((mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId
						? [mark.pid]
						: [],
				),
			).size;
		expect(runnerStarts()).toBe(1);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, entered],
			}),
		);
		const updated = await fixture.connect(sessionId);
		await updated.send(sessionId, "Use the updated project folders.");
		evidence["runnerStarts"] = runnerStarts();
		evidence["additionalDirectories"] = fixture
			.claudeOptions()
			.map(({ options }) => options["additionalDirectories"]);
		expect(runnerStarts()).toBe(2);
		expect(
			fixture.claudeOptions().at(-1)?.options["additionalDirectories"],
		).toEqual([entered]);
		evidence["runnerStarts"] = runnerStarts();
	});

	it("reuses the runner when configured extra folders are only reordered", async () => {
		const { fixture, socket } = await start("reordered-folders", {
			turns: ["enter-worktree-turn", "pong-thinking-text-turn"],
		});
		const extraA = join(fixture.root, "extra-a");
		const extraB = join(fixture.root, "extra-b");
		initRepo(extraA);
		initRepo(extraB);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extraA, extraB],
			}),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Reordered extra folders");
		await browser.send(sessionId, "Enter a worktree.");
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extraB, extraA],
			}),
		);
		const reordered = await fixture.connect(sessionId);
		await reordered.send(
			sessionId,
			"Continue with the same set of extra folders.",
		);
		const runnerStarts = new Set(
			fixture.marks.flatMap((mark) =>
				mark.kind === "runner-started" && mark.sessionId === sessionId
					? [mark.pid]
					: [],
			),
		).size;
		evidence["runnerStarts"] = runnerStarts;
		evidence["additionalDirectories"] = fixture
			.claudeOptions()
			.map(({ options }) => options["additionalDirectories"]);
		expect(runnerStarts).toBe(1);
	});

	it.each([
		"pending",
		"consumed",
	] as const)("retains the live runner after deferring an unsafe upgrade with %s move reconciliation", async (state) => {
		const { fixture, socket } = await start(`upgrade-${state}`, {
			turns: [
				"enter-worktree-turn",
				"pong-thinking-text-turn",
				"pong-thinking-text-turn",
			],
			enterPath: "../extra-repo/.claude/worktrees/contract",
		});
		const extra = join(fixture.root, "extra-repo");
		initRepo(extra);
		const entered = join(extra, ".claude", "worktrees", "contract");
		git(extra, "worktree", "add", "-b", "worktree-contract", entered);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			}),
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Upgrade after declared move",
		);
		await browser.send(sessionId, "Enter the secondary worktree.");
		if (state === "consumed")
			await browser.send(sessionId, "Reply with pong in the worktree.");
		const old = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (old?.kind !== "runner-started")
			throw new Error("Missing original runner");
		await fixture.kill();
		await fixture.restart({ buildId: "q5u6-14-upgraded" });
		await vi.waitFor(
			() =>
				expect(fixture.logTail).toContain(
					"Changed Claude settings cannot be replayed without changing trust tiers or filesystem discovery; retaining the old runner",
				),
			{ timeout: 15_000 },
		);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		const restored = await fixture.connect(sessionId);
		await restored.send(sessionId, "Reply with pong after the daemon restart.");
		expect(new Set(fixture.claudeOptions().map(({ pid }) => pid))).toEqual(
			new Set([old.pid]),
		);
		expect(moves(fixture, sessionId)).toHaveLength(1);
		expect(moves(fixture, sessionId)[0]?.worktrees).toEqual({
			[extra]: realpathSync(entered),
		});
		evidence["upgrade"] = { deferred: true, retainedQuery: true };
	});

	it("reuses the runner when a declared path is a symlink to a valid worktree", async () => {
		const { fixture, entered } = await start("declared-symlink", {
			turns: ["enter-worktree-turn", "pong-thinking-text-turn"],
			enterPath: "worktree-alias",
		});
		symlinkSync(entered, join(fixture.projectDir, "worktree-alias"));
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Symlink declaration");
		await browser.send(sessionId, "Enter the aliased worktree.");
		expect(moves(fixture, sessionId).at(-1)?.worktrees).toEqual({
			[fixture.projectDir]: entered,
		});
		await browser.send(sessionId, "Reply with pong in the worktree.");
		expect(
			fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			),
		).toHaveLength(1);
	});

	it("records an agent move from runner-start cwd when no user move is pending", async () => {
		const { fixture, entered, list } = await start("backstop", {
			turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
			reportedCwd: ".claude/worktrees/contract",
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Restored worktree");
		await browser.send(sessionId, "Reply with pong.");
		expect(
			(await list()).sessions.find(({ id }) => id === sessionId),
		).toMatchObject({
			workspace: {
				cause: "agent",
				worktrees: { [fixture.projectDir]: entered },
			},
			git: { branch: "worktree-contract" },
		});
		expect(moves(fixture, sessionId)).toHaveLength(1);
		await browser.send(
			sessionId,
			"Reply with pong again in the restored worktree.",
		);
		expect(
			fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			),
		).toHaveLength(1);
		expect(moves(fixture, sessionId)).toHaveLength(1);
	});

	it("preserves a pending user move over Claude's sticky runner-start cwd", async () => {
		const { fixture, user, socket, list } = await start("pending-user", {
			turns: ["pong-thinking-text-turn"],
			reportedCwd: ".claude/worktrees/contract",
		});
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("User move wins");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: user,
			}),
		);
		await browser.send(sessionId, "Reply with pong.");
		expect(
			(await list()).sessions.find(({ id }) => id === sessionId),
		).toMatchObject({
			workspace: { cause: "user", worktrees: { [fixture.projectDir]: user } },
			git: { branch: "user-destination" },
		});
		expect(moves(fixture, sessionId)).toHaveLength(1);
	});

	it.each([
		"worktree",
		"main",
	] as const)("acknowledges a pending user move to %s through a matching tool declaration", async (destination) => {
		const { fixture, main, entered, socket, list } = await start(
			`tool-ack-${destination}`,
			{
				turns: [
					destination === "main"
						? "exit-worktree-keep-turn"
						: "enter-worktree-turn",
				],
				reportedCwd:
					destination === "main" ? ".claude/worktrees/contract" : ".",
			},
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Matching declaration");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: entered,
			}),
		);
		if (destination === "main")
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: main,
				}),
			);
		await browser.send(sessionId, "Declare the requested workspace.");
		expect(moves(fixture, sessionId).at(-1)).toEqual({
			sessionId,
			cause: "agent",
			worktrees: destination === "main" ? {} : { [main]: entered },
			origin: "existing",
		});
		const workspace = (await list()).sessions.find(
			({ id }) => id === sessionId,
		)?.workspace;
		if (destination === "main") expect(workspace ?? null).toBeNull();
		else expect(workspace?.cause).toBe("agent");
	});

	it.each([
		["matching", "worktree"],
		["mismatching", "worktree"],
		["matching", "main"],
		["mismatching", "main"],
	] as const)(
		"remembers a %s startup acknowledgment of a user move to %s after daemon restart",
		async (acknowledgment, destination) => {
			const replay = {
				turns: ["pong-thinking-text-turn"] as const,
				reportedCwd:
					acknowledgment === "matching"
						? "user-alias"
						: ".claude/worktrees/contract",
			};
			const { fixture, main, user, entered, socket, list } = await start(
				`user-ack-${acknowledgment}-${destination}`,
				replay,
			);
			const requested = destination === "main" ? main : user;
			symlinkSync(requested, join(fixture.projectDir, "user-alias"));
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Durable user acknowledgment",
			);
			if (destination === "main")
				await sendRpcRequest(
					socket,
					new MoveSessionWorkspace({
						projectSlug: "process-test",
						sessionId,
						path: user,
					}),
				);
			await sendRpcRequest(
				socket,
				new MoveSessionWorkspace({
					projectSlug: "process-test",
					sessionId,
					path: requested,
				}),
			);
			await browser.send(
				sessionId,
				"Reply with pong in the requested worktree.",
			);
			const userMoves = destination === "main" ? 2 : 1;
			expect(moves(fixture, sessionId)).toHaveLength(userMoves);
			expect(
				events(fixture)
					.filter(({ type }) => type === "session.workspace_started")
					.map(({ data }) => data["path"]),
			).toEqual([acknowledgment === "matching" ? requested : entered]);
			await fixture.kill();
			replay.reportedCwd = ".claude/worktrees/contract";
			await fixture.restart();
			const extra = join(fixture.root, "extra-repo");
			initRepo(extra);
			await sendRpcRequest(
				socket,
				new SaveProject({
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				}),
			);
			const restored = await fixture.connect(sessionId);
			await restored.send(
				sessionId,
				"Reply with pong after restarting the runner.",
			);
			const expected = acknowledgment === "matching" ? entered : requested;
			const workspace = (await list()).sessions.find(
				({ id }) => id === sessionId,
			)?.workspace;
			if (expected === main) expect(workspace ?? null).toBeNull();
			else
				expect(workspace).toMatchObject({
					cause: acknowledgment === "matching" ? "agent" : "user",
					worktrees: { [fixture.projectDir]: expected },
				});
			expect(moves(fixture, sessionId)).toHaveLength(
				userMoves + (acknowledgment === "matching" ? 1 : 0),
			);
			evidence["acknowledgment"] = {
				acknowledgment,
				retainedAcrossRestart: true,
				path: expected,
			};
		},
		60_000,
	);

	it.each([
		"missing",
		"not-a-worktree",
		"other-repository",
	] as const)("logs an invalid %s declared move without recording it", async (reason) => {
		const target =
			reason === "missing"
				? "missing"
				: reason === "not-a-worktree"
					? "plain"
					: "foreign";
		const { fixture, list } = await start(`invalid-${reason}`, {
			turns: ["enter-worktree-turn"],
			enterPath: target,
			logLevel: "warn",
		});
		if (reason !== "missing") mkdirSync(join(fixture.projectDir, target));
		if (reason === "other-repository") {
			initRepo(join(fixture.projectDir, target), "foreign");
		}
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Invalid move");
		await browser.send(sessionId, "Enter a worktree.");
		const session = (await list()).sessions.find(({ id }) => id === sessionId);
		expect(session?.workspace ?? null).toBeNull();
		expect(session?.git?.branch).toBe("main");
		expect(moves(fixture, sessionId)).toEqual([]);
		await vi.waitFor(() => {
			expect(fixture.logTail).toContain("Invalid agent workspace move");
			expect(fixture.logTail).toContain(reason);
		});
		evidence["rejection"] = {
			path: join(fixture.projectDir, target),
			reason,
			logged: true,
		};
	});
});
