/*
 * Failure modes, recorded before implementation:
 * - Settled sessions lose their owned checkout while the Claude runner lives,
 *   or Clean up now omits the exact "Agent process is running" keep reason.
 * - An ending, stopping, or idle-exiting runner reads as dead before OS exit.
 * - Exited runners permanently prevent the next eligible cleanup removal.
 * - Daemon restart forgets an adopted runner until its next provider command.
 * - A failed end_session still permits immediate delete-time checkout removal.
 * - A Claude-only guard incorrectly retains an eligible OpenCode checkout.
 * Exercise the built daemon, fake process SDK, real Git checkouts and runner
 * PIDs. Preserve RPC results, process marks and checkout state in JSON evidence.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import {
	CleanUpWorktreesNow,
	CreateSession,
	DeleteSession,
	ListDaemonSessions,
	ReloadProviderSession,
	SetSessionSettled,
	SetWorktreeCleanupSetting,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
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

const cleanup = {
	onSettle: "keep" as const,
	onDelete: false,
	settledAfterDays: 0,
	keepWhen: "uncommitted-changes" as const,
};
const command =
	"pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/worktree-cleanup-agent.test.ts";
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const artifact = `test-results/worktree-cleanup-agent-${timestamp}.json`;
const outcomes: Record<string, unknown>[] = [];

describe("Worktree cleanup guards live agents through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const checkouts: Array<{ sessionId: string; path: string; branch: string }> =
		[];

	async function start(
		options: NonNullable<Parameters<typeof ProcessHarness.create>[0]> = {},
	) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		evidence = { sweeps: [] };
		checkouts.length = 0;
		const fixture = ProcessHarness.create({
			dist: "dist",
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
			...options,
		});
		harness = fixture;
		git(fixture.projectDir, "init", "-b", "main");
		writeFileSync(join(fixture.projectDir, "base.txt"), "committed base\n");
		git(fixture.projectDir, "add", "base.txt");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Cleanup agent test",
			"-c",
			"user.email=cleanup@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		const configPath = join(fixture.configDir, "daemon.json");
		const existing: Record<string, unknown> = existsSync(configPath)
			? (JSON.parse(readFileSync(configPath, "utf8")) as Record<
					string,
					unknown
				>)
			: {
					pid: 0,
					port: 0,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
				};
		writeFileSync(
			configPath,
			JSON.stringify({
				...existing,
				instances: [
					...(Array.isArray(existing["instances"])
						? existing["instances"]
						: []),
					{
						id: "claude",
						name: "Test Claude",
						driver: "claude",
						port: 0,
						managed: false,
						configDir: join(fixture.root, "claude"),
					},
				],
				accountDefaults: { claude: "claude" },
				autoSettleAfterDays: null,
				configVersion: 2,
				worktreeCleanup: { ...cleanup, settledAfterDays: null },
			}),
		);
		writeFileSync(
			join(fixture.root, "claude-end-session-failure-fixture"),
			"enabled\n",
		);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		const socket = join(fixture.configDir, "relay.sock");
		const create = async (
			title: string,
			provider: "claude" | "opencode" = "claude",
		) => {
			const { sessionId } = await sendRpcRequest(
				socket,
				new CreateSession({
					projectSlug: "process-test",
					originId: "cleanup-agent-test",
					providerId: provider,
					permissionMode: "ask",
					...(provider === "claude"
						? { model: { providerId: "claude", modelId: "sonnet" } }
						: {
								instanceId: AccountIdSchema.make("managed-test"),
								model: { providerId: "fake", modelId: "fake-model" },
							}),
					title,
					newWorktree: true,
				}),
			);
			const { sessions } = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			const path = sessions.find(({ id }) => id === sessionId)?.workspace
				?.worktrees[fixture.projectDir];
			if (!path) throw new Error("Missing owned session worktree");
			const checkout = {
				sessionId,
				path,
				branch: git(path, "branch", "--show-current"),
			};
			checkouts.push(checkout);
			return checkout;
		};
		const sweep = async (label: string) => {
			const result = await sendRpcRequest(
				socket,
				new CleanUpWorktreesNow({ projectSlug: "process-test" }),
				{ requestTimeoutMs: 30_000 },
			);
			(evidence["sweeps"] as unknown[]).push({ label, ...result });
			expect(result.failed).toEqual([]);
			return result;
		};
		const settle = async (sessionId: string) => {
			await sendRpcRequest(
				socket,
				new SetSessionSettled({ sessionId, settled: true }),
			);
			await sendRpcRequest(
				socket,
				new SetWorktreeCleanupSetting({ worktreeCleanup: cleanup }),
			);
		};
		const send = async (sessionId: string) => {
			const browser = await fixture.connect();
			try {
				await browser.send(sessionId, "Worktree cleanup agent guard");
			} finally {
				await browser.close();
			}
			const runner = fixture.marks.find(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (runner?.kind !== "runner-started")
				throw new Error("Missing runner PID proof");
			return runner;
		};
		return { fixture, socket, create, send, settle, sweep };
	}

	function alive(pid: number) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function sdkProof(fixture: ProcessHarness): Array<Record<string, unknown>> {
		const path = join(fixture.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	}

	function kept(session: { sessionId: string; path: string }) {
		return {
			projectSlug: "process-test",
			...session,
			reason: "Agent process is running",
		};
	}

	afterEach(async ({ task }) => {
		const fixture = harness;
		evidence["scenario"] = task.name;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			if (fixture) {
				evidence["checkouts"] = checkouts.map((checkout) => ({
					...checkout,
					exists: existsSync(checkout.path),
				}));
				evidence["runners"] = fixture.marks.filter((mark) =>
					mark.kind.startsWith("runner-"),
				);
				evidence["sdk"] = sdkProof(fixture);
				if (task.result?.errors?.length)
					evidence["logs"] = fixture.logTail.slice(-4000);
				await fixture.dispose();
				fixture.assertNoRunners();
				evidence["remainingRunnerPids"] = fixture.remainingRunnerPids();
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
				artifact,
				`${JSON.stringify({ command, outcomes }, null, 2)}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("keeps a settled live Claude runner with its reason and removes its worktree after exit", async () => {
		const { fixture, create, send, settle, sweep } = await start();
		const session = await create("settled live agent");
		const runner = await send(session.sessionId);
		await settle(session.sessionId);
		expect(alive(runner.pid)).toBe(true);
		expect((await sweep("settled live runner")).kept).toContainEqual(
			kept({ sessionId: session.sessionId, path: session.path }),
		);
		expect(existsSync(session.path)).toBe(true);
		process.kill(runner.pid, "SIGTERM");
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 10_000,
		});
		const result = await sweep("runner exited");
		expect(result.removed).toContainEqual({
			projectSlug: "process-test",
			sessionId: session.sessionId,
			path: session.path,
			reason: expect.stringMatching(/settled/i),
		});
		expect(existsSync(session.path)).toBe(false);
		expect(
			git(fixture.projectDir, "rev-parse", `refs/heads/${session.branch}`),
		).toBeTruthy();
	}, 60_000);

	it("keeps a worktree while end-session has stopped the SDK but its process is still alive", async () => {
		const { fixture, socket, create, send, settle, sweep } = await start();
		const session = await create("ending live agent");
		const runner = await send(session.sessionId);
		await settle(session.sessionId);
		writeFileSync(
			join(fixture.root, "claude", "conduit-test-hold-stop"),
			"hold\n",
		);
		const ending = sendRpcRequest(
			socket,
			new ReloadProviderSession({
				sessionId: session.sessionId,
				commandId: randomUUID(),
			}),
			{ requestTimeoutMs: 30_000 },
		);
		try {
			await vi.waitFor(
				() =>
					expect(
						sdkProof(fixture).some((mark) => mark["kind"] === "stop-held"),
					).toBe(true),
				{ timeout: 10_000 },
			);
			expect(alive(runner.pid)).toBe(true);
			expect(
				(await sweep("end-session waiting for SDK interrupt")).kept,
			).toContainEqual(
				kept({ sessionId: session.sessionId, path: session.path }),
			);
			expect(existsSync(session.path)).toBe(true);
		} finally {
			writeFileSync(join(fixture.root, "release-switch-stop"), "release\n");
			await ending;
		}
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 10_000,
		});
		expect(
			(await sweep("end-session exited")).removed.some(
				({ sessionId }) => sessionId === session.sessionId,
			),
		).toBe(true);
		expect(existsSync(session.path)).toBe(false);
	}, 60_000);

	it("keeps an idle-exiting runner after stop is requested until its OS process exits", async () => {
		const { fixture, create, send, settle, sweep } = await start({
			runnerLifecycle: { idleTimeoutMs: 1500, idleExitDelayMs: 1500 },
		});
		const session = await create("idle-exiting live agent");
		const runner = await send(session.sessionId);
		await settle(session.sessionId);
		await vi.waitFor(
			() =>
				expect(
					fixture.marks.some(
						(mark) =>
							mark.kind === "runner-idle-exit-started" &&
							mark.pid === runner.pid,
					),
				).toBe(true),
			{ timeout: 10_000, interval: 10 },
		);
		process.kill(runner.pid, "SIGSTOP");
		try {
			expect(alive(runner.pid)).toBe(true);
			expect(
				(await sweep("idle-exit stop requested, process suspended")).kept,
			).toContainEqual(
				kept({ sessionId: session.sessionId, path: session.path }),
			);
			expect(existsSync(session.path)).toBe(true);
		} finally {
			if (alive(runner.pid)) process.kill(runner.pid, "SIGCONT");
		}
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 10_000,
		});
		expect(
			(await sweep("idle-exiting runner gone")).removed.some(
				({ sessionId }) => sessionId === session.sessionId,
			),
		).toBe(true);
		expect(existsSync(session.path)).toBe(false);
	}, 60_000);

	it("adopts a live runner before startup cleanup without another provider command", async () => {
		const { fixture, create, send, settle, sweep } = await start();
		const session = await create("restart live agent");
		const runner = await send(session.sessionId);
		await settle(session.sessionId);
		await fixture.kill();
		expect(alive(runner.pid)).toBe(true);
		await fixture.restart({ startupTimeoutMs: 120_000 });
		expect(existsSync(session.path)).toBe(true);
		expect(
			(await sweep("adopted runner before next command")).kept,
		).toContainEqual(
			kept({ sessionId: session.sessionId, path: session.path }),
		);
		expect(alive(runner.pid)).toBe(true);
		expect(
			fixture.marks
				.filter(
					(mark) =>
						mark.kind === "runner-started" &&
						mark.sessionId === session.sessionId,
				)
				.at(-1),
		).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
		expect(
			sdkProof(fixture).filter((mark) => mark["kind"] === "query"),
		).toHaveLength(1);
	}, 60_000);

	it("keeps the worktree during immediate deletion when end_session fails with its runner alive", async () => {
		const { fixture, socket, create, send } = await start();
		const session = await create("delete failed end-session");
		const runner = await send(session.sessionId);
		writeFileSync(
			join(fixture.root, `fail-end-session-${session.sessionId}`),
			"fail\n",
		);
		const response = await sendRpcRequest(
			socket,
			new DeleteSession({
				sessionId: session.sessionId,
				removeWorktrees: true,
			}),
		);
		evidence["delete"] = response;
		expect(response.ok).toBe(true);
		expect(response.worktreeWarnings?.length).toBeGreaterThan(0);
		expect(alive(runner.pid)).toBe(true);
		expect(existsSync(session.path)).toBe(true);
		expect(
			readFileSync(join(fixture.root, "end-session-failures.ndjson"), "utf8"),
		).toContain(session.sessionId);
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const events = db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('session.deleted', 'session.provider_cleanup_failed') ORDER BY sequence",
				)
				.all(session.sessionId) as Array<{ type: string; data: string }>;
			evidence["deleteEvents"] = events.map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as unknown,
			}));
			expect(
				events.filter(({ type }) => type === "session.deleted"),
			).toHaveLength(1);
			expect(
				events.find(({ type }) => type === "session.provider_cleanup_failed")
					?.data,
			).toContain("Fixture end_session failure");
		} finally {
			db.close();
		}
	}, 60_000);

	it("removes an eligible OpenCode worktree without a Claude runner", async () => {
		const { fixture, create, settle, sweep } = await start({
			managedOpenCode: true,
		});
		const session = await create(
			"OpenCode cleanup remains eligible",
			"opencode",
		);
		await settle(session.sessionId);
		const result = await sweep("OpenCode has no Claude runner");
		expect(
			result.kept.some(
				({ sessionId, reason }) =>
					sessionId === session.sessionId &&
					reason === "Agent process is running",
			),
		).toBe(false);
		await vi.waitFor(() => expect(existsSync(session.path)).toBe(false), {
			timeout: 10_000,
		});
		expect(
			fixture.marks.some(
				(mark) =>
					mark.kind === "runner-started" &&
					mark.sessionId === session.sessionId,
			),
		).toBe(false);
		evidence["openCodeRemoved"] = true;
	}, 60_000);
});
