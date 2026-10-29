// Failure modes: recovery drops a frozen effort or skill, skips the native
// rewind boundary, or sends a continuation's empty admission text as its prompt.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";

describe("Codex unjournaled commands through daemon recovery", () => {
	let harness: ProcessHarness | undefined;
	let sessionId = "";
	let artifactRoot = "";
	let capturePath = "";
	let reportPath = "";
	let tracePath = "";
	let earlierCapture: TraceRow[] = [];
	let gatePath = "";

	function writeTrace(trace: TraceRow[], path = tracePath) {
		writeFileSync(
			path,
			`${trace.map((row) => JSON.stringify(row).replaceAll("/workspace", harness?.projectDir ?? "/workspace")).join("\n")}\n`,
		);
	}

	function requests(method: string) {
		return [...earlierCapture, ...rows<TraceRow>(capturePath)]
			.filter(({ dir, message }) => dir === "out" && message?.method === method)
			.map(({ message }) => message?.params);
	}

	async function start(name: string, holdBeforeSend = false) {
		artifactRoot = resolve(`test-results/codex-command-recovery/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		capturePath = join(artifactRoot, "capture.jsonl");
		reportPath = join(artifactRoot, "trace-report.jsonl");
		writeFileSync(capturePath, "");
		writeFileSync(reportPath, "");
		earlierCapture = [];
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			logLevel: "warn",
			runnerLifecycle: { idleTimeoutMs: null },
		});
		const fixture = harness;
		tracePath = join(fixture.root, "turn.jsonl");
		const discoveryPath = join(fixture.root, "discovery.jsonl");
		const usagePath = join(fixture.root, "usage.jsonl");
		const mapPath = join(fixture.root, "trace-map.json");
		const serviceMapPath = join(fixture.root, "service-trace-map.json");
		const signedOutPath = join(fixture.root, "signed-out.jsonl");
		const discoveryCapture = join(artifactRoot, "discovery-capture.jsonl");
		gatePath = join(fixture.root, "trace-gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		writeFileSync(discoveryCapture, "");
		const discovery = fixtureRows("skills-list");
		const accountReply = discovery.find(
			({ message }) => message?.result && "account" in message.result,
		)?.message;
		if (!accountReply) throw new Error("Missing captured account response");
		const signedInAccount = signedInCodexDiscoveryTrace().find(
			({ message }) => message?.result?.["account"],
		)?.message?.result;
		if (!signedInAccount) throw new Error("Missing signed-in account response");
		accountReply.result = signedInAccount;
		writeTrace(discovery, discoveryPath);
		writeTrace(fixtureRows("usage-read"), usagePath);
		writeTrace(fixtureRows("model-list"), signedOutPath);
		writeFileSync(
			mapPath,
			JSON.stringify({
				"*": {
					"codex-discovery": { trace: discoveryPath },
					"codex-discovery-auth": { trace: discoveryPath },
					"codex-usage": { trace: usagePath },
					"codex-turn": { trace: tracePath, capture: capturePath },
				},
			}),
		);
		writeFileSync(serviceMapPath, readFileSync(mapPath));
		let initial = true;
		const restart = (hold = false) =>
			fixture.restart({
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
				serviceEnvironment: {
					CONDUIT_TEST_CODEX_TRACE_MAP: serviceMapPath,
					CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
					CONDUIT_CODEX_APP_SERVER_TRACE: initial ? discoveryPath : tracePath,
					CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
					...(hold ? { CONDUIT_TEST_HOLD_RUNNER_OUTPUT: "send-turn" } : {}),
				},
			});
		await restart(holdBeforeSend);
		initial = false;
		const browser = await fixture.connect();
		const accountId = await vi.waitFor(
			async () => {
				const account = (await browser.instances()).instances.find(
					({ driver }) => driver === "codex",
				);
				expect(account).toBeDefined();
				if (!account) throw new Error("Missing signed-in Codex account");
				return account.id;
			},
			{ timeout: TIMEOUT },
		);
		// The outbox strips this environment; recovery must resolve the account again.
		const env = {
			NODE_ENV: "test",
			CONDUIT_TEST_CODEX_TRACE_MAP: mapPath,
			// A capture pump would block its own close while the response is gated.
			CONDUIT_TEST_CODEX_TRANSPORTS: discoveryCapture,
		};
		await fixture.requestRpc({
			_tag: "UpdateInstance",
			instanceId: accountId,
			env,
		});
		expect(await codexModels(browser, accountId)).toContainEqual(
			expect.objectContaining({ id: MODEL }),
		);
		// Only this account's current environment can discover its signed-in catalog.
		writeFileSync(
			serviceMapPath,
			JSON.stringify({
				"*": {
					"codex-discovery": { trace: signedOutPath },
					"codex-discovery-auth": { trace: signedOutPath },
					"codex-usage": { trace: usagePath },
					"codex-turn": { trace: tracePath, capture: capturePath },
				},
			}),
		);
		sessionId = await browser.createSession(name, accountId, "codex", {
			modelId: MODEL,
			variant: "high",
			contextWindow: "",
			permissionMode: "ask",
		});
		return {
			fixture,
			browser,
			id: sessionId,
			accountId,
			env,
			restart,
			discoveryCapture,
		};
	}

	async function held(fixture: ProcessHarness, id: string, previousSends = 0) {
		await vi.waitFor(
			() =>
				expect(
					rows<Record<string, unknown>>(join(fixture.root, "sdk-proof.ndjson")),
				).toContainEqual(
					expect.objectContaining({ kind: "held-output", type: "send-turn" }),
				),
			{ timeout: TIMEOUT },
		);
		expect(requests("turn/start")).toHaveLength(previousSends);
		const runner = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === id,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Missing owned runner");
		const journal = join(dirname(runner.socketPath), "sends", id);
		expect(existsSync(journal) ? readdirSync(journal) : []).toEqual([]);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const input = db
				.prepare<[string], { payload_json: string }>(
					"SELECT payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1",
				)
				.get(id);
			expect(
				(
					JSON.parse(input?.payload_json ?? "{}") as {
						account?: { env?: unknown };
					}
				).account?.env,
			).toBeUndefined();
		} finally {
			db.close();
		}
	}

	async function completed(fixture: ProcessHarness, id: string, count: number) {
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
					Array.from({ length: count }, () => "completed"),
				),
			{ timeout: TIMEOUT },
		);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const state = sessionId ? snapshot(fixture, sessionId) : undefined;
		const log = join(fixture.configDir, "runners.log");
		const runnerLog = existsSync(log) ? readFileSync(log, "utf8") : "";
		await fixture.dispose();
		writeFileSync(join(artifactRoot, "runners.log"), runnerLog);
		writeFileSync(
			join(artifactRoot, "evidence.json"),
			`${JSON.stringify(
				{
					result: task.result?.state,
					state,
					process: fixture.proof(),
					traceReports: rows<AppServerTraceReport>(reportPath),
				},
				null,
				2,
			)}\n`,
		);
		harness = undefined;
		sessionId = "";
		expect(fixture.remainingRunnerPids()).toEqual([]);
	});

	it(
		"keeps the chosen Codex effort and skill when recovering an unjournaled turn",
		async () => {
			const { fixture, browser, id, restart } = await start(
				"effort-and-skill",
				true,
			);
			writeTrace(fixtureRows("turn-skill"));
			const pending = browser
				.send(id, "/fixture-skill Say hello", TIMEOUT)
				.catch(() => undefined);
			await held(fixture, id);
			await fixture.kill();
			await pending;
			await restart();
			await completed(fixture, id, 1);
			expect(requests("turn/start")[0]).toMatchObject({ effort: "high" });
			expect(requests("turn/start")[0]?.["input"]).toContainEqual({
				type: "skill",
				name: "fixture-skill",
				path: join(fixture.projectDir, ".agents/skills/fixture-skill/SKILL.md"),
			});
		},
		TIMEOUT * 3,
	);

	it(
		"stops an unjournaled Codex turn while recovery prepare is waiting for discovery",
		async () => {
			const { fixture, browser, id, restart, discoveryCapture } = await start(
				"stop-prepare",
				true,
			);
			writeTrace(fixtureRows("basic"));
			const pending = browser
				.send(id, "Say hello", TIMEOUT)
				.catch(() => undefined);
			await held(fixture, id);
			await fixture.kill();
			await pending;
			writeFileSync(discoveryCapture, "");
			writeFileSync(gatePath, "0");
			await restart();
			await vi.waitFor(
				() =>
					expect(rows<{ scenario: string }>(discoveryCapture)).toContainEqual(
						expect.objectContaining({ scenario: "codex-discovery" }),
					),
				{ timeout: 10_000 },
			);
			expect(requests("turn/start")).toEqual([]);
			const after = await fixture.connect(id);
			await Effect.runPromise(
				after.rpc.CancelSession({ sessionId: id, commandId: randomUUID() }),
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "turn.interrupted",
							metadata: expect.objectContaining({ runId: expect.any(String) }),
						}),
					),
				{ timeout: TIMEOUT },
			);
			expect(snapshot(fixture, id).events).not.toContainEqual(
				expect.objectContaining({ type: "turn.error" }),
			);
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await after.getModels();
			expect(requests("turn/start")).toEqual([]);
		},
		TIMEOUT * 3,
	);

	it(
		"reverts the native Codex thread before recovering an unjournaled rewind turn",
		async () => {
			const { fixture, browser, id, restart } = await start("rewind");
			const trace = fixtureRows("rewind-revert");
			writeTrace(trace);
			for (const prompt of [
				"Say hello",
				"Say hello again",
				"Say hello a third time",
			])
				await browser.send(id, prompt, TIMEOUT);
			await completed(fixture, id, 3);
			const target = (await browser.history(id)).filter(
				({ role }) => role === "user",
			)[1];
			if (!target) throw new Error("Missing rewind target");
			await fixture.kill();
			await restart(true);
			const before = await fixture.connect(id);
			await Effect.runPromise(
				before.rpc.RewindSession({ sessionId: id, messageId: target.id }),
			);
			const pending = before
				.send(id, "Continue after rewind", TIMEOUT)
				.catch(() => undefined);
			await held(fixture, id, 3);
			await fixture.kill();
			await pending;
			await restart();
			await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(4), {
				timeout: TIMEOUT,
			});
			const boundary = trace.find(
				({ message }) => message?.method === "thread/revert",
			)?.message?.params;
			expect(requests("thread/revert")).toEqual([
				expect.objectContaining({
					threadId: boundary?.["threadId"],
					beforeTurnId: boundary?.["beforeTurnId"],
				}),
			]);
			// Removed messages leave historical turn accounting in place.
			await completed(fixture, id, 4);
			const after = await fixture.connect(id);
			expect(
				(await after.history(id))
					.filter(({ role }) => role === "user")
					.map(({ text }) => text),
			).toEqual(["Say hello", "Continue after rewind"]);
		},
		TIMEOUT * 4,
	);

	it(
		"recovers the historical prompt for an unjournaled Codex continuation",
		async () => {
			const { fixture, browser, id, accountId, env, restart } =
				await start("continuation");
			await fixture.requestRpc({
				_tag: "SetUsageLimitsSetting",
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					order: [],
					warnAt: 80,
				},
			});
			writeTrace(fixtureRows("usage-limit"));
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({ type: "session.usage_limited" }),
					),
				{ timeout: TIMEOUT },
			);
			const { addedInstanceId: target } = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "Continuation account",
				driver: "codex",
				configDir: join(
					fixture.configDir,
					"codex",
					"accounts",
					encodeURIComponent(accountId),
				),
				env,
			});
			if (!target) throw new Error("Missing continuation account");
			await codexModels(browser, target);
			const next = fixtureRows("basic");
			const thread = next.find(
				({ message }) => message?.method === "thread/start",
			)?.message;
			const native = requests("turn/start")[0]?.["threadId"];
			if (!thread || typeof native !== "string")
				throw new Error("Missing native thread");
			const previous = next.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			const resumed = JSON.parse(
				JSON.stringify(next).replaceAll(String(previous), native),
			) as TraceRow[];
			const open = resumed.find(
				({ message }) => message?.method === "thread/start",
			)?.message;
			if (!open) throw new Error("Missing captured thread open");
			open.method = "thread/resume";
			open.params = { threadId: native };
			earlierCapture = rows<TraceRow>(capturePath);
			writeFileSync(capturePath, "");
			writeTrace(resumed);
			await fixture.kill();
			await restart(true);
			await fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId: id,
				instanceId: target,
				expectedInstanceId: accountId,
			});
			await held(fixture, id, 1);
			await fixture.kill();
			await restart();
			await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(2), {
				timeout: TIMEOUT,
			});
			expect(requests("turn/start").at(-1)?.["input"]).toContainEqual(
				expect.objectContaining({ type: "text", text: "Say hello" }),
			);
			await completed(fixture, id, 1);
		},
		TIMEOUT * 4,
	);
});
