/*
 * Failure modes, recorded before implementation:
 * - Settled idle agents remain live, or checkout removal runs before stop ends.
 * - Settling interrupts foreground turns or live background work.
 * - Turn/background completion does not request another cleanup run.
 * - Off disables agent stops, or stops unbind the provider conversation.
 * - A message racing stop is lost, forks its conversation, or uses a dying runner.
 * - Unsettling starts an agent, or cleanup ends sessions without live agents.
 * - An ending, stopping, or idle-exiting runner reads as dead before OS exit.
 * - Exited runners permanently prevent the next eligible cleanup removal.
 * - Daemon restart forgets a settled adopted runner until its next command.
 * - One failed stop prevents the remaining stops or the checkout sweep.
 * - A failed end_session still permits immediate delete-time checkout removal.
 * - A Claude-only guard incorrectly retains an eligible OpenCode checkout.
 * Exercise the built daemon, fake process SDK, real Git checkouts and runner
 * PIDs. Preserve RPC results, process marks and checkout state in JSON evidence.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import type { WorktreeCleanup } from "../../../src/lib/contracts/worktree.js";
import {
	CancelSession,
	CleanUpWorktreesNow,
	CreateSession,
	DeleteSession,
	ListDaemonSessions,
	SetProjectWorktreeCleanupSetting,
	SetSessionSettled,
	SetWorktreeCleanupSetting,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

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

describe("Settling stops quiescent agents through the built daemon", () => {
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
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 30_000,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const create = async (
			title: string,
			provider: "claude" | "opencode" = "claude",
		) => {
			const { sessionId } = await sendRpcRequest(socket, {
				_tag: "CreateSession",
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
			});
			const { sessions } = await sendRpcRequest(socket, {
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
				scope: "process-test",
			});
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
				{ _tag: "CleanUpWorktreesNow", projectSlug: "process-test" },
				{ requestTimeoutMs: 30_000 },
			);
			(evidence["sweeps"] as unknown[]).push({ label, ...result });
			expect(result.failed).toEqual([]);
			return result;
		};
		const settle = (sessionId: string, settled = true) =>
			sendRpcRequest(socket, { _tag: "SetSessionSettled", sessionId, settled });
		const set = (worktreeCleanup: WorktreeCleanup) =>
			sendRpcRequest(socket, {
				_tag: "SetWorktreeCleanupSetting",
				scope: "global",
				rules: worktreeCleanup,
			});
		const enable = async (session: { path: string }) => {
			// Keep automatic requests harmless until the manual run observes removal.
			writeFileSync(join(session.path, "base.txt"), "cleanup guard\n");
			await set(cleanup);
			await sweep("drain setting request");
			git(session.path, "restore", "base.txt");
		};
		const send = async (sessionId: string) => {
			const browser = await fixture.connect();
			try {
				await browser.send(sessionId, "Worktree cleanup agent guard", 60_000);
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
		return { fixture, socket, create, send, settle, set, enable, sweep };
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

	function stopCommands(fixture: ProcessHarness, sessionId?: string) {
		const path = join(fixture.root, "end-session-commands.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as { sessionId: string; unbind: boolean },
					)
					.filter(
						(command) =>
							sessionId === undefined || command.sessionId === sessionId,
					)
			: [];
	}

	function sessionState(fixture: ProcessHarness, sessionId: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					`SELECT provider, settled_at, (
						SELECT json_extract(value, '$.resumeSessionId') FROM provider_state
						WHERE session_id = sessions.id AND key = 'nativeThread:' || sessions.provider
					) AS providerConversationId FROM sessions WHERE id = ?`,
				)
				.get(sessionId) as {
				provider: string;
				providerConversationId: string | null;
				settled_at: number | null;
			};
		} finally {
			db.close();
		}
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
				evidence["stopCommands"] = stopCommands(fixture);
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

	it("stops a settled idle agent before removing its worktree in the same cleanup run", async () => {
		const { fixture, create, send, settle, enable, sweep } = await start();
		const session = await create("settled live agent");
		const runner = await send(session.sessionId);
		const failure = join(fixture.root, `fail-end-session-${session.sessionId}`);
		writeFileSync(failure, "fail\n");
		await settle(session.sessionId);
		await enable(session);
		expect(alive(runner.pid)).toBe(true);
		expect((await sweep("failed stop keeps live runner")).kept).toContainEqual(
			kept({ sessionId: session.sessionId, path: session.path }),
		);
		expect(existsSync(session.path)).toBe(true);
		rmSync(failure);
		const before = stopCommands(fixture, session.sessionId).length;
		const result = await sweep("stop and remove in one run");
		expect(alive(runner.pid)).toBe(false);
		expect(stopCommands(fixture, session.sessionId)).toHaveLength(before + 1);
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

	it("settles mid-turn without stopping until the completed turn requests cleanup", async () => {
		const { fixture, create, send, settle, sweep } = await start();
		const session = await create("settled during turn");
		const runner = await send(session.sessionId);
		const browser = await fixture.connect(session.sessionId);
		const turn = browser.send(session.sessionId, "local-work-turn", 60_000);
		void turn.catch(() => {});
		await vi.waitFor(
			() =>
				expect(
					sdkProof(fixture).some(
						(mark) =>
							mark["kind"] === "pre-assistant-held" &&
							mark["prompt"] === "local-work-turn",
					),
				).toBe(true),
			{ timeout: 15_000 },
		);
		try {
			await settle(session.sessionId);
			await sweep("settled during held foreground turn");
			expect(alive(runner.pid)).toBe(true);
			expect(stopCommands(fixture, session.sessionId)).toEqual([]);
			expect(existsSync(session.path)).toBe(true);
		} finally {
			writeFileSync(join(fixture.root, "release-local-work"), "release\n");
		}
		await turn;
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 15_000,
		});
		expect(stopCommands(fixture, session.sessionId)).toEqual([
			{ sessionId: session.sessionId, unbind: false },
		]);
		await browser.close();
	}, 90_000);

	it("stops only after live background work ends and requests cleanup", async () => {
		const { fixture, create, settle, sweep } = await start();
		const session = await create("settled during background work");
		const browser = await fixture.connect(session.sessionId);
		expect(
			(
				await browser.send(session.sessionId, "upgrade-background-work", 60_000)
			).chunks.join(""),
		).toBe(responseChunks("upgrade-background-work").join(""));
		const runner = fixture.marks.find(
			(mark) =>
				mark.kind === "runner-started" && mark.sessionId === session.sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Missing background runner");
		expect(
			sdkProof(fixture).some(
				(mark) =>
					mark["kind"] === "background-work" && mark["phase"] === "started",
			),
		).toBe(true);
		await settle(session.sessionId);
		await sweep("settled with live background work");
		expect(alive(runner.pid)).toBe(true);
		expect(stopCommands(fixture, session.sessionId)).toEqual([]);
		writeFileSync(
			join(fixture.root, "release-upgrade-background"),
			"release\n",
		);
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 15_000,
		});
		expect(
			sdkProof(fixture).some(
				(mark) =>
					mark["kind"] === "background-work" && mark["phase"] === "completed",
			),
		).toBe(true);
		expect(stopCommands(fixture, session.sessionId)).toEqual([
			{ sessionId: session.sessionId, unbind: false },
		]);
		await browser.close();
	}, 90_000);

	it.each([
		"failed",
		"interrupted",
	] as const)("cleans up a settled session after its %s turn ends", async (ending) => {
		const { fixture, socket, create, send, settle, sweep } = await start();
		const session = await create(`settled ${ending} turn`);
		const runner = await send(session.sessionId);
		const browser = await fixture.connect(session.sessionId);
		const cursor = browser.frames.length;
		const turn = browser.send(
			session.sessionId,
			ending === "failed"
				? "approval-failure-settled"
				: "approval-settled-interrupt",
			60_000,
		);
		void turn.catch(() => {});
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
			cursor,
			15_000,
		);
		await settle(session.sessionId);
		await sweep("settled while approval holds the turn");
		expect(alive(runner.pid)).toBe(true);
		expect(stopCommands(fixture, session.sessionId)).toEqual([]);
		if (ending === "failed") {
			await browser.answerApproval(approval, "allow");
			await turn;
		} else {
			await sendRpcRequest(socket, {
				_tag: "CancelSession",
				sessionId: session.sessionId,
				commandId: randomUUID(),
			});
		}
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 15_000,
		});
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const turns = db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(session.sessionId);
			expect(turns).toEqual([
				{ state: "completed" },
				{ state: ending === "failed" ? "error" : "interrupted" },
			]);
			evidence["turns"] = turns;
		} finally {
			db.close();
		}
		expect(stopCommands(fixture, session.sessionId)).toEqual([
			{ sessionId: session.sessionId, unbind: false },
		]);
		await browser.close();
	}, 90_000);

	it("stops with project cleanup Off, resumes the same conversation on the next message, and starts nothing on unsettle", async () => {
		const { fixture, socket, create, send, settle, sweep, set } = await start();
		await set(cleanup);
		await sendRpcRequest(socket, {
			_tag: "SetWorktreeCleanupSetting",
			scope: "project",
			projectSlug: "process-test",
			override: "off",
		});
		const session = await create("settle while cleanup Off");
		const first = await send(session.sessionId);
		const before = await vi.waitFor(
			() => {
				const state = sessionState(fixture, session.sessionId);
				expect(state.providerConversationId).toEqual(expect.any(String));
				return state;
			},
			{ timeout: 15_000 },
		);
		await settle(session.sessionId);
		await vi.waitFor(() => expect(alive(first.pid)).toBe(false), {
			timeout: 15_000,
		});
		expect(existsSync(session.path)).toBe(true);
		expect(await sweep("Off still stops but never removes")).toEqual({
			removed: [],
			kept: [],
			failed: [],
		});
		expect(sessionState(fixture, session.sessionId)).toMatchObject({
			provider: before.provider,
			providerConversationId: before.providerConversationId,
		});
		const commands = stopCommands(fixture, session.sessionId);
		expect(commands).toEqual([{ sessionId: session.sessionId, unbind: false }]);
		const browser = await fixture.connect(session.sessionId);
		const prompt = "after-settle-stop";
		expect(
			(await browser.send(session.sessionId, prompt, 60_000)).chunks.join(""),
		).toBe(responseChunks(prompt).join(""));
		const runners = fixture.marks.filter(
			(mark) =>
				mark.kind === "runner-started" && mark.sessionId === session.sessionId,
		);
		expect(runners).toHaveLength(2);
		const second = runners.at(-1);
		if (second?.kind !== "runner-started")
			throw new Error("Missing resumed runner");
		expect(second.pid).not.toBe(first.pid);
		expect(
			fixture.claudeOptions().find((options) => options.prompt === prompt)
				?.resumeId,
		).toBe(before.providerConversationId);
		expect(
			sessionState(fixture, session.sessionId).providerConversationId,
		).toBe(before.providerConversationId);
		await settle(session.sessionId);
		await vi.waitFor(() => expect(alive(second.pid)).toBe(false), {
			timeout: 15_000,
		});
		const queryCount = sdkProof(fixture).filter(
			(mark) => mark["kind"] === "query",
		).length;
		const stopCount = stopCommands(fixture, session.sessionId).length;
		const runnerCount = fixture.marks.filter(
			(mark) => mark.kind === "runner-started",
		).length;
		await settle(session.sessionId, false);
		await sweep("unsettling starts no agent");
		expect(
			fixture.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(runnerCount);
		expect(
			sdkProof(fixture).filter((mark) => mark["kind"] === "query"),
		).toHaveLength(queryCount);
		expect(stopCommands(fixture, session.sessionId)).toHaveLength(stopCount);
		expect(alive(second.pid)).toBe(false);
		evidence["conversation"] = {
			before,
			after: sessionState(fixture, session.sessionId),
			queryCount,
		};
		await browser.close();
	}, 90_000);

	it("replies in the same conversation when a message reaches admission while stop holds the inbox", async () => {
		const { fixture, create, send, settle, sweep } = await start();
		const session = await create("message during settle-stop");
		const runner = await send(session.sessionId);
		const before = await vi.waitFor(
			() => {
				const state = sessionState(fixture, session.sessionId);
				expect(state.providerConversationId).toEqual(expect.any(String));
				return state;
			},
			{ timeout: 15_000 },
		);
		const browser = await fixture.connect(session.sessionId);
		const prompt = "message-during-settle-stop";
		// 887c1afa lets disposal close without waiting for Query.interrupt's ack.
		// Hold the provider operation itself to keep this race inside inbox ownership.
		const hold = join(fixture.root, `hold-end-session-${session.sessionId}`);
		writeFileSync(hold, "hold\n");
		try {
			await settle(session.sessionId);
			await vi.waitFor(
				() =>
					expect(
						existsSync(
							join(fixture.root, `end-session-held-${session.sessionId}`),
						),
					).toBe(true),
				{ timeout: 15_000 },
			);
			expect(alive(runner.pid)).toBe(true);
			expect(existsSync(session.path)).toBe(true);
			const reply = browser.send(session.sessionId, prompt, 60_000);
			void reply.catch(() => {});
			// Sending clears settled_at before inbox admission. This durable write
			// proves the request reached the held lock before the stop is released.
			await vi.waitFor(
				() =>
					expect(
						sessionState(fixture, session.sessionId).settled_at,
					).toBeNull(),
				{ timeout: 15_000 },
			);
			expect(alive(runner.pid)).toBe(true);
			expect(
				sdkProof(fixture).filter((mark) => mark["kind"] === "query"),
			).toHaveLength(1);
			evidence["admissionDuringStop"] = sessionState(
				fixture,
				session.sessionId,
			);
			rmSync(hold, { force: true });
			expect((await reply).chunks.join("")).toBe(
				responseChunks(prompt).join(""),
			);
			expect(alive(runner.pid)).toBe(false);
			expect(
				fixture.claudeOptions().find((options) => options.prompt === prompt)
					?.resumeId,
			).toBe(before.providerConversationId);
			expect(
				sessionState(fixture, session.sessionId).providerConversationId,
			).toBe(before.providerConversationId);
			await sweep("message racing stop finished");
			expect(stopCommands(fixture, session.sessionId)).toEqual([
				{ sessionId: session.sessionId, unbind: false },
			]);
		} finally {
			rmSync(hold, { force: true });
			await browser.close();
		}
	}, 60_000);

	it("keeps an idle-exiting runner after stop is requested until its OS process exits", async () => {
		const { fixture, create, send, settle, enable, sweep } = await start({
			runnerLifecycle: { idleTimeoutMs: 1500, idleExitDelayMs: 1500 },
		});
		const session = await create("idle-exiting live agent");
		const runner = await send(session.sessionId);
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
			writeFileSync(
				join(fixture.root, `fail-end-session-${session.sessionId}`),
				"fail\n",
			);
			await settle(session.sessionId);
			await enable(session);
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

	it("stops a settled adopted runner through the manual hourly-backstop path", async () => {
		const { fixture, create, send, settle, enable, sweep } = await start();
		const session = await create("restart live agent");
		const runner = await send(session.sessionId);
		const failure = join(fixture.root, `fail-end-session-${session.sessionId}`);
		writeFileSync(failure, "fail\n");
		await settle(session.sessionId);
		await enable(session);
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
		rmSync(failure);
		const result = await sweep("hourly backstop after adoption");
		expect(alive(runner.pid)).toBe(false);
		expect(
			result.removed.some(({ sessionId }) => sessionId === session.sessionId),
		).toBe(true);
		expect(
			sdkProof(fixture).filter((mark) => mark["kind"] === "query"),
		).toHaveLength(1);
	}, 60_000);

	it("continues stopping other sessions and sweeping after one stop fails, without ending dead runners", async () => {
		const { fixture, create, send, settle, enable, sweep } = await start();
		const failed = await create("failed settle-stop");
		const healthy = await create("healthy settle-stop");
		const neverStarted = await create("no runner ever started");
		const exited = await create("runner exited before settling");
		const failedRunner = await send(failed.sessionId);
		const healthyRunner = await send(healthy.sessionId);
		const exitedRunner = await send(exited.sessionId);
		process.kill(exitedRunner.pid, "SIGTERM");
		await vi.waitFor(() => expect(alive(exitedRunner.pid)).toBe(false), {
			timeout: 15_000,
		});
		writeFileSync(
			join(fixture.root, `fail-end-session-${failed.sessionId}`),
			"fail\n",
		);
		const healthyFailure = join(
			fixture.root,
			`fail-end-session-${healthy.sessionId}`,
		);
		writeFileSync(healthyFailure, "fail\n");
		for (const session of [failed, healthy, neverStarted, exited])
			await settle(session.sessionId);
		await enable(failed);
		rmSync(healthyFailure);
		const result = await sweep("one failed stop does not block other sessions");
		expect(alive(failedRunner.pid)).toBe(true);
		expect(alive(healthyRunner.pid)).toBe(false);
		expect(result.kept).toContainEqual(
			kept({ sessionId: failed.sessionId, path: failed.path }),
		);
		// Not which run removed it: a turn finalizer can queue an automatic sweep
		// after the drain, which removes the healthy checkout before this one.
		for (const session of [healthy, neverStarted, exited])
			expect(existsSync(session.path)).toBe(false);
		expect(stopCommands(fixture, neverStarted.sessionId)).toEqual([]);
		expect(stopCommands(fixture, exited.sessionId)).toEqual([]);
		expect(
			readFileSync(join(fixture.root, "end-session-failures.ndjson"), "utf8"),
		).toContain(failed.sessionId);
	}, 120_000);

	it("keeps the worktree during immediate deletion when end_session fails with its runner alive", async () => {
		const { fixture, socket, create, send } = await start();
		const session = await create("delete failed end-session");
		const runner = await send(session.sessionId);
		writeFileSync(
			join(fixture.root, `fail-end-session-${session.sessionId}`),
			"fail\n",
		);
		const response = await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: session.sessionId,
			removeWorktrees: true,
		});
		evidence["delete"] = response;
		expect(response.ok).toBe(true);
		expect(response.worktreeWarnings?.length).toBeGreaterThan(0);
		expect(alive(runner.pid)).toBe(true);
		expect(existsSync(session.path)).toBe(true);
		expect(
			readFileSync(join(fixture.root, "end-session-failures.ndjson"), "utf8"),
		).toContain(session.sessionId);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
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
				events.filter(({ type }) => type === "session.provider_cleanup_failed"),
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
		const { fixture, create, settle, enable, sweep } = await start({
			managedOpenCode: true,
		});
		const session = await create(
			"OpenCode cleanup remains eligible",
			"opencode",
		);
		await settle(session.sessionId);
		await enable(session);
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
