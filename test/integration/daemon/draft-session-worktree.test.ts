import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreateSession,
	ListDaemonSessions,
	ListWorktrees,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { SessionWorkspaceChangedPayload } from "../../../src/lib/persistence/events.js";
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
	});
}

function initRepo(directory: string) {
	mkdirSync(directory, { recursive: true });
	git(directory, "init", "-b", "main");
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

async function holdWorkspaceValidation(
	fixture: ProcessHarness,
	worktree: string,
) {
	const directory = join(fixture.root, "git-shim");
	const gate = join(directory, "hold");
	const entered = join(directory, "entered");
	const realGit = execFileSync("/usr/bin/which", ["git"], {
		env: gitEnv,
		encoding: "utf8",
	}).trim();
	mkdirSync(directory);
	writeFileSync(
		join(directory, "git"),
		`#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
async function main() {
  if (process.cwd() === ${JSON.stringify(worktree)} &&
      process.argv[2] === "rev-parse" && process.argv[3] === "--git-common-dir" &&
      fs.existsSync(${JSON.stringify(gate)})) {
    fs.writeFileSync(${JSON.stringify(entered)}, "");
    while (fs.existsSync(${JSON.stringify(gate)}))
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
main();
`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PATH", `${directory}:${gitEnv["PATH"] ?? ""}`);
	await fixture.shutdown();
	await fixture.restart();
	writeFileSync(gate, "");
	return {
		wait: () => vi.waitFor(() => expect(existsSync(entered)).toBe(true)),
		release: () => {
			if (existsSync(gate)) unlinkSync(gate);
		},
	};
}

describe("Draft worktree launches through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	const names = new Map<string, string>();

	async function start(name: string, opencodeRecording?: string) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		names.clear();
		harness = ProcessHarness.create({
			...(opencodeRecording ? { opencodeRecording } : {}),
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
			},
		});
		initRepo(harness.projectDir);
		const worktree = join(harness.root, "existing-worktree");
		git(harness.projectDir, "worktree", "add", "-b", "feature/draft", worktree);
		await harness.restart();
		return {
			fixture: harness,
			worktree: realpathSync(worktree),
			socket: join(harness.configDir, "relay.sock"),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		evidence["events"] = [];
		try {
			if (existsSync(fixture.projectStorePath())) {
				const db = new Database(fixture.projectStorePath(), { readonly: true });
				try {
					evidence["events"] = db
						.prepare(
							"SELECT data FROM events WHERE type = 'session.workspace_changed' ORDER BY sequence",
						)
						.all()
						.map((row) => {
							const { data } = row as { data: string };
							const event = JSON.parse(data) as SessionWorkspaceChangedPayload;
							return {
								...event,
								sessionId: names.get(event.sessionId) ?? "unreturned-session",
							};
						})
						.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
				} finally {
					db.close();
				}
			}
			evidence["launches"] = [...names]
				.sort(([, a], [, b]) => a.localeCompare(b))
				.map(([id, name]) => ({
					session: name,
					queries: sessionQueries(fixture, id).map(({ options }) => ({
						cwd: options["cwd"],
						additionalDirectories: options["additionalDirectories"] ?? [],
					})),
				}));
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
			} finally {
				mkdirSync("test-results", { recursive: true });
				let normalized = JSON.stringify(
					evidence,
					(_key, value: unknown) =>
						value !== null && typeof value === "object" && !Array.isArray(value)
							? Object.fromEntries(
									Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
								)
							: value,
					2,
				)
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>");
				for (const [id, name] of names)
					normalized = normalized.replaceAll(id, name);
				writeFileSync(
					`test-results/q5u6-1-6-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("records a launch move before the first turn, while no choice stays in the main folder", async () => {
		const { fixture, worktree, socket } = await start("launch");
		const browser = await fixture.connect();
		const { worktrees } = await sendRpcRequest(
			socket,
			new ListWorktrees({ projectSlug: "process-test" }),
		);
		expect(worktrees).toContainEqual({
			path: worktree,
			branch: "feature/draft",
			main: false,
		});
		evidence["worktrees"] = [...worktrees].sort((a, b) =>
			a.path.localeCompare(b.path),
		);

		for (const [name, path] of [
			["existing-worktree", worktree],
			["current-checkout", undefined],
		] as const) {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "draft-worktree-test",
					providerId: "claude",
					title: name,
					...(path ? { worktreePath: path } : {}),
				}),
			);
			names.set(sessionId, name);
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			const session = sessions.find(({ id }) => id === sessionId);
			if (path) {
				expect(session?.workspace).toEqual({
					cause: "launch",
					worktrees: { [fixture.projectDir]: worktree },
					origin: "existing",
				});
				expect(session?.git).toMatchObject({
					branch: "feature/draft",
					worktree: "existing-worktree",
				});
			} else {
				expect(session?.workspace ?? null).toBeNull();
				expect(session?.git?.branch).toBe("main");
			}
			expect(sessionQueries(fixture, sessionId)).toEqual([]);
			await browser.view(sessionId);
			const reply = await browser.send(sessionId, "Reply with pong.");
			expect(reply.chunks.join("")).toBe("pong");
			expect(
				sessionQueries(fixture, sessionId).map(({ options }) => options["cwd"]),
			).toEqual([path ?? fixture.projectDir]);
			evidence[name] = {
				workspace: session?.workspace ?? null,
				branch: session?.git?.branch,
			};
		}
	}, 60_000);

	it("starts in either checkout of a secondary repository, keeping the primary as an additional directory", async () => {
		const { fixture, socket } = await start("secondary-repository");
		const secondary = join(fixture.root, "docs");
		initRepo(secondary);
		git(secondary, "branch", "-m", "docs-main");
		const linked = join(fixture.root, "docs-worktree");
		git(secondary, "worktree", "add", "-b", "feature/docs", linked);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, secondary],
			}),
		);
		const browser = await fixture.connect();
		const { worktrees } = await sendRpcRequest(
			socket,
			new ListWorktrees({ projectSlug: "process-test" }),
		);
		evidence["worktrees"] = [...worktrees].sort((a, b) =>
			a.path.localeCompare(b.path),
		);
		for (const [name, path, branch] of [
			["secondary-main", secondary, "docs-main"],
			["secondary-linked", linked, "feature/docs"],
		] as const) {
			expect(worktrees).toContainEqual({
				path,
				branch,
				main: path === secondary,
			});
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: browser.originId,
					providerId: "claude",
					title: name,
					worktreePath: path,
				}),
			);
			names.set(sessionId, name);
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			const session = sessions.find(({ id }) => id === sessionId);
			expect(session?.workspace).toEqual({
				cause: "launch",
				worktrees: { [secondary]: path },
				origin: "existing",
			});
			expect(session?.git?.branch).toBe(branch);
			await browser.view(sessionId);
			const reply = await browser.send(sessionId, "Reply with pong.");
			expect(reply.chunks.join("")).toBe("pong");
			expect(
				sessionQueries(fixture, sessionId).map(({ options }) => ({
					cwd: options["cwd"],
					additionalDirectories: options["additionalDirectories"],
				})),
			).toEqual([{ cwd: path, additionalDirectories: [fixture.projectDir] }]);
			evidence[name] = {
				workspace: session?.workspace,
				branch: session?.git?.branch,
			};
		}
	}, 60_000);

	it("removes an interrupted draft creation while its workspace is being validated", async () => {
		const { fixture, worktree, socket } = await start("interrupted");
		const validation = await holdWorkspaceValidation(fixture, worktree);
		const browser = await fixture.connect();
		const creating = Effect.runPromise(
			Effect.exit(
				browser.rpc.CreateSession({
					projectSlug: "process-test",
					originId: browser.originId,
					providerId: "claude",
					title: "Interrupted draft",
					worktreePath: worktree,
				}),
			),
		);
		try {
			await validation.wait();
			await browser.close();
			expect(Exit.isFailure(await creating)).toBe(true);
			await vi.waitFor(async () => {
				const { sessions } = await sendRpcRequest(
					socket,
					new ListDaemonSessions({
						projectSlug: "process-test",
						scope: "process-test",
					}),
				);
				expect(
					sessions.some(({ title }) => title === "Interrupted draft"),
				).toBe(false);
			});
			expect(
				fixture.marks.filter(({ kind }) => kind === "runner-started"),
			).toEqual([]);
			evidence["interruptedCreation"] = { remainingSessions: 0, launches: 0 };
		} finally {
			validation.release();
		}
	}, 30_000);

	it("rolls back a chosen-worktree draft interrupted while applying its model and effort", async () => {
		const { fixture, worktree, socket } = await start("interrupted-model");
		const browser = await fixture.connect();
		const gate = join(fixture.root, "capabilities-probe");
		writeFileSync(`${gate}-gated`, "");
		const creating = Effect.runPromise(
			Effect.exit(
				browser.rpc.CreateSession({
					projectSlug: "process-test",
					originId: browser.originId,
					providerId: "claude",
					title: "Interrupted model draft",
					model: { providerId: "claude", modelId: "sonnet", variant: "high" },
					worktreePath: worktree,
				}),
			),
		);
		try {
			await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true));
			await browser.close();
			expect(Exit.isFailure(await creating)).toBe(true);
			await vi.waitFor(async () => {
				const { sessions } = await sendRpcRequest(
					socket,
					new ListDaemonSessions({
						projectSlug: "process-test",
						scope: "process-test",
					}),
				);
				expect(
					sessions.some(({ title }) => title === "Interrupted model draft"),
				).toBe(false);
			});
			expect(
				fixture.marks.filter(({ kind }) => kind === "runner-started"),
			).toEqual([]);
			evidence["interruptedModelCreation"] = {
				remainingSessions: 0,
				launches: 0,
			};
		} finally {
			writeFileSync(`${gate}-release`, "");
		}
	}, 30_000);

	it("makes another tab's prewarm wait until the launch workspace is recorded", async () => {
		const { fixture, worktree, socket } = await start("concurrent-prewarm");
		const validation = await holdWorkspaceValidation(fixture, worktree);
		const creator = await fixture.connect();
		const observer = await fixture.connect();
		const creating = Effect.runPromise(
			Effect.exit(
				creator.rpc.CreateSession({
					projectSlug: "process-test",
					originId: creator.originId,
					providerId: "claude",
					title: "Concurrent draft",
					worktreePath: worktree,
				}),
			),
		);
		try {
			await validation.wait();
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			const sessionId = sessions.find(
				({ title }) => title === "Concurrent draft",
			)?.id;
			expect(sessionId).toBeDefined();
			if (!sessionId) throw new Error("Concurrent draft was not published");
			names.set(sessionId, "concurrent-draft");
			await observer.view(sessionId);
			const warming = observer.preWarmSession(sessionId);
			const beforeMove = await Promise.race([
				warming.then(() => "warmed"),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("waiting"), 300),
				),
			]);
			expect(beforeMove).toBe("waiting");
			expect(sessionQueries(fixture, sessionId)).toEqual([]);
			validation.release();
			const created = await creating;
			expect(Exit.isSuccess(created)).toBe(true);
			await warming;
			await vi.waitFor(() => {
				expect(
					sessionQueries(fixture, sessionId).map(
						({ options }) => options["cwd"],
					),
				).toEqual([worktree]);
			});
			const reply = await observer.send(sessionId, "Reply with pong.");
			expect(reply.chunks.join("")).toBe("pong");
			evidence["prewarmBeforeMove"] = beforeMove;
		} finally {
			validation.release();
			await creating;
		}
	}, 30_000);

	it("rejects a stale or foreign draft choice without leaving a session or launching a runner", async () => {
		const { fixture, socket } = await start("invalid");
		const plain = join(fixture.root, "plain");
		mkdirSync(plain);
		const foreign = join(fixture.root, "foreign");
		initRepo(foreign);
		const failures = [];
		for (const [path, reason] of [
			[join(fixture.root, "removed"), "missing"],
			[plain, "not-a-worktree"],
			[foreign, "other-repository"],
		] as const) {
			await expect(
				sendRpcRequest(
					socket,
					new CreateSession({
						projectSlug: "process-test",
						originId: "draft-worktree-test",
						providerId: "claude",
						title: "Rejected draft",
						worktreePath: path,
					}),
				),
			).rejects.toMatchObject({ _tag: "WorkspaceMoveError", path, reason });
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			expect(sessions.some(({ title }) => title === "Rejected draft")).toBe(
				false,
			);
			expect(fixture.marks.some(({ kind }) => kind === "runner-started")).toBe(
				false,
			);
			failures.push({ path, reason });
		}
		evidence["rejections"] = failures.sort((a, b) =>
			a.reason.localeCompare(b.reason),
		);
	}, 60_000);

	it("rejects an unsupported provider's draft choice before recording a workspace", async () => {
		const { fixture, worktree, socket } = await start(
			"unsupported-provider",
			"chat-multi-turn",
		);
		await expect(
			sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "draft-worktree-test",
					providerId: "opencode",
					title: "Unsupported draft",
					worktreePath: worktree,
				}),
			),
		).rejects.toMatchObject({
			_tag: "WorkspaceMoveError",
			reason: "unsupported-provider",
		});
		const { sessions } = await sendRpcRequest(
			socket,
			new ListDaemonSessions({
				projectSlug: "process-test",
				scope: "process-test",
			}),
		);
		expect(sessions.some(({ title }) => title === "Unsupported draft")).toBe(
			false,
		);
		expect(fixture.marks.some(({ kind }) => kind === "runner-started")).toBe(
			false,
		);
		evidence["rejection"] = "unsupported-provider";
	}, 60_000);
});
