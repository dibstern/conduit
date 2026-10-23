// Failure modes: replay resamples a mid-turn save, legacy sends erase a
// retained policy, replacements inherit stale settings, and A -> B -> A saves go stale.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface Send {
	pid: number;
	commandId: string;
	inputId: string;
	hasPolicy: boolean;
	days?: number | null;
}

interface ConfigRead {
	pid: number;
	api: string;
	boundary: "startup" | "writer" | "runtime";
}

let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];
let evidence: Record<string, unknown> = {};
const rollbackDist = process.env["CONDUIT_TEST_ROLLBACK_DIST"];
const currentDist = process.env["CONDUIT_TEST_DIST"];
const build = currentDist ? { dist: currentDist } : {};

function sends(fixture: ProcessHarness): Send[] {
	const path = join(fixture.root, "policy-wire.ndjson");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Send)
		: [];
}

function preload(fixture: ProcessHarness): string {
	const path = join(fixture.root, "policy-probe.mjs");
	writeFileSync(
		path,
		`import { Socket } from "node:net";
import fs, { appendFileSync, existsSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const root = ${JSON.stringify(fixture.root)};
const configPath = ${JSON.stringify(join(fixture.configDir, "daemon.json"))};
appendFileSync(root + "/probe-pids.ndjson", JSON.stringify(process.pid) + "\\n");
for (const [owner, key] of [[fs, "readFileSync"], [fs, "readFile"], [promises, "readFile"], [fs, "openSync"], [fs, "open"], [promises, "open"], [fs, "createReadStream"]]) {
  const original = owner[key];
  owner[key] = function (...args) {
    const path = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
    const read = !key.toLowerCase().includes("open") || args[1] === undefined || String(args[1]).startsWith("r");
    if (path === configPath && read) {
      const stack = new Error().stack ?? "";
      const boundary = stack.includes("config-persistence-layer") ? "writer"
        : stack.includes("daemon-foreground") || stack.includes("process-harness-server") ? "startup" : "runtime";
      appendFileSync(root + "/config-reads.ndjson", JSON.stringify({ pid: process.pid, api: key, boundary, stack }) + "\\n");
      const legacyDaemon = existsSync(root + "/rollback-daemon") && !/claude-session-runner\.(js|ts)$/.test(process.argv[1] ?? "");
      if (boundary === "runtime" && !legacyDaemon && !existsSync(root + "/legacy-launch")) throw new Error("Runtime daemon config read forbidden");
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
const write = Socket.prototype.write;
Socket.prototype.write = function (...args) {
  if (typeof args[0] === "string" && args[0].startsWith("{")) {
    let messages;
    try { messages = args[0].trim().split("\\n").map((line) => JSON.parse(line)); } catch {}
    if (messages) {
      for (const message of messages) {
        if (message.type === "hello" && message.config && existsSync(root + "/legacy-launch")) delete message.config.autoSettleAfterDays;
        if (message.type !== "command" || message.command?.type !== "send-turn") continue;
        if (existsSync(root + "/legacy-peer")) {
          delete message.command.autoSettleAfterDays;
          delete message.command.input.autoSettleAfterDays;
        }
        appendFileSync(root + "/policy-wire.ndjson", JSON.stringify({ pid: process.pid,
          commandId: message.commandId, inputId: message.command.input.inputId,
          hasPolicy: Object.hasOwn(message.command, "autoSettleAfterDays"),
          days: message.command.autoSettleAfterDays }) + "\\n");
      }
      args[0] = messages.map((message) => JSON.stringify(message) + "\\n").join("");
    }
  }
  return write.apply(this, args);
};
`,
	);
	return `--import=${path}`;
}

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	const wire = sends(fixture);
	const configReads: ConfigRead[] = existsSync(
		join(fixture.root, "config-reads.ndjson"),
	)
		? readFileSync(join(fixture.root, "config-reads.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as ConfigRead)
		: [];
	const pidPath = join(fixture.root, "probe-pids.ndjson");
	const probePids = existsSync(pidPath)
		? readFileSync(pidPath, "utf8").trim().split("\n").map(Number)
		: [];
	const legacyLaunch = existsSync(join(fixture.root, "legacy-launch"));
	const runnerPids = fixture.marks.flatMap((mark) =>
		mark.kind === "runner-started" ? [mark.pid] : [],
	);
	const runtimeRunnerReads = configReads.filter(
		({ boundary, pid }) => boundary === "runtime" && runnerPids.includes(pid),
	);
	writeFileSync(join(fixture.root, "release-upgrade-turn"), "cleanup");
	try {
		await fixture.dispose();
		if (!legacyLaunch && evidence["mode"] !== "rollback")
			expect(
				configReads.filter(({ boundary }) => boundary === "runtime"),
			).toEqual([]);
		if (!legacyLaunch) expect(runtimeRunnerReads).toEqual([]);
		for (const generation of fixture.proof().generations)
			expect(probePids).toContain(generation.pid);
		for (const runner of fixture.marks.filter(
			(mark) => mark.kind === "runner-started",
		))
			if (runner.kind === "runner-started")
				expect(probePids).toContain(runner.pid);
		expect(fixture.remainingRunnerPids()).toEqual([]);
	} finally {
		scenarios.push({
			name: task.name,
			result: task.result?.state,
			failures: task.result?.errors?.map(({ message }) => message),
			...evidence,
			wire,
			configReads,
			runtimeRunnerReads,
			runtimeConfigReads: configReads.filter(
				({ boundary }) => boundary === "runtime",
			).length,
			probePids,
			generations: fixture.proof().generations,
			remainingRunnerPids: fixture.remainingRunnerPids(),
		});
		mkdirSync("test-results/82tn18-fix4", { recursive: true });
		writeFileSync(
			"test-results/82tn18-fix4/config-replay.json",
			JSON.stringify({ bead: "conduit-test-82tn.18", scenarios }, null, 2),
		);
		harness = undefined;
		evidence = {};
	}
});

for (const mode of [
	"restart",
	"legacy-send",
	"rollback",
	"legacy-command",
] as const) {
	it.skipIf(mode === "rollback" && !rollbackDist)(
		`retains an admitted disabled idle policy through ${mode}`,
		async () => {
			evidence = { mode };
			const fixture = ProcessHarness.create({
				...build,
				restartProof: true,
				buildId: "82tn18-config-replay",
				runnerLifecycle: { idleDayMs: 250 },
			});
			harness = fixture;
			const serviceEnvironment = { NODE_OPTIONS: preload(fixture) };
			await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
			const browser = await fixture.connect();
			await browser.setAutoSettle(null);
			const sessionId = await browser.createSession("Retained admission");
			const held = browser
				.send(sessionId, "upgrade-long-turn", 90_000)
				.catch(() => undefined);
			await fixture.waitForMark((mark) => mark.kind === "assistant-held");
			const runner = await fixture.waitForMark(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (runner.kind !== "runner-started") throw new Error("Missing runner");
			const original = sends(fixture)[0];
			expect(original?.days).toBeNull();
			if (mode === "restart" || mode === "legacy-command")
				await browser.setAutoSettle(1);
			if (mode === "legacy-send")
				writeFileSync(join(fixture.root, "legacy-peer"), "omit metadata");
			await fixture.kill();
			await held;
			if (mode === "rollback")
				writeFileSync(
					join(fixture.root, "rollback-daemon"),
					"old daemon reads are allowed",
				);
			if (mode === "legacy-command") {
				const db = new Database(fixture.daemonStorePath());
				try {
					db.prepare(
						"UPDATE provider_command_outbox SET payload_json = json_remove(payload_json, '$.autoSettleAfterDays') WHERE session_id = ?",
					).run(sessionId);
				} finally {
					db.close();
				}
			}
			await fixture.restart({
				...(mode === "rollback" && rollbackDist ? { dist: rollbackDist } : {}),
				startupTimeoutMs: 90_000,
				serviceEnvironment,
			});
			await vi.waitFor(() => expect(sends(fixture)).toHaveLength(2), {
				timeout: 15_000,
			});
			const replay = sends(fixture)[1];
			expect(replay?.commandId).toBe(original?.commandId);
			if (mode === "restart") expect.soft(replay?.days).toBeNull();
			else if (mode === "legacy-command") expect(replay?.days).toBe(1);
			else expect(replay?.hasPolicy).toBe(false);
			writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				await vi.waitFor(
					() =>
						expect(
							db
								.prepare<[string], { state: string }>(
									"SELECT state FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
								)
								.get(sessionId)?.state,
						).toBe("completed"),
					{ timeout: 30_000 },
				);
			} finally {
				db.close();
			}
			await setTimeout(1400);
			evidence = {
				mode,
				sessionId,
				runner,
				retainedRunner: existsSync(runner.socketPath),
			};
			if (mode === "legacy-command") {
				await vi.waitFor(() =>
					expect(existsSync(runner.socketPath)).toBe(false),
				);
			} else expect(existsSync(runner.socketPath)).toBe(true);
		},
		120_000,
	);
}

it("keeps disk-based idle behaviour for a legacy launch without any snapshot", async () => {
	const fixture = ProcessHarness.create({
		...build,
		runnerLifecycle: { idleDayMs: 250 },
	});
	harness = fixture;
	writeFileSync(join(fixture.root, "legacy-peer"), "no send metadata");
	writeFileSync(join(fixture.root, "legacy-launch"), "no launch snapshot");
	await fixture.restart({
		startupTimeoutMs: 90_000,
		serviceEnvironment: { NODE_OPTIONS: preload(fixture) },
	});
	const browser = await fixture.connect();
	await browser.setAutoSettle(null);
	const sessionId = await browser.createSession("Legacy launch");
	await browser.send(sessionId, "legacy-launch-send");
	const runner = await fixture.waitForMark(
		(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
	);
	if (runner.kind !== "runner-started") throw new Error("Missing runner");
	await setTimeout(1400);
	expect(existsSync(runner.socketPath)).toBe(true);
	await browser.setAutoSettle(1);
	await vi.waitFor(() => expect(existsSync(runner.socketPath)).toBe(false), {
		timeout: 10_000,
	});
	evidence = { sessionId, runner, legacyLaunchFollowedDiskSetting: true };
}, 120_000);

for (const driver of ["claude", "cursor"] as const) {
	for (const mode of driver === "claude"
		? (["upgrade", "prewarm"] as const)
		: (["upgrade"] as const)) {
		it(`initializes ${driver} ${mode} replacements from current daemon memory`, async () => {
			const fixture = ProcessHarness.create({
				...build,
				restartProof: driver === "claude",
				buildId: "82tn18-replacement-before",
				runnerLifecycle: { idleDayMs: 500 },
			});
			harness = fixture;
			const serviceEnvironment = {
				NODE_OPTIONS: preload(fixture),
				...(driver === "cursor"
					? {
							CURSOR_API_KEY: "",
							CONDUIT_CURSOR_SDK_TRACE: resolve(
								"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
							),
						}
					: {}),
			};
			await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
			const browser = await fixture.connect();
			const instanceId =
				driver === "cursor"
					? (
							await fixture.requestRpc({
								_tag: "AddInstance",
								name: "Replacement policy",
								driver: "cursor",
								env: { CURSOR_API_KEY: "fake-config-memory-key" },
							})
						).addedInstanceId
					: undefined;
			await browser.setAutoSettle(null);
			const sessionId = await browser.createSession(
				"Current replacement policy",
				instanceId,
				driver,
				driver === "cursor"
					? {
							modelId: "composer-2.5",
							contextWindow: "",
							permissionMode: "full",
						}
					: undefined,
			);
			await browser.send(
				sessionId,
				driver === "cursor" ? "Say hello" : "earlier-policy",
			);
			const old = await fixture.waitForMark(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (old.kind !== "runner-started") throw new Error("Missing runner");
			evidence = { driver, mode, sessionId, old };
			await browser.setAutoSettle(1);
			await fixture.kill();
			if (mode === "prewarm") {
				process.kill(old.pid, "SIGKILL");
				await vi.waitFor(
					() => expect(() => process.kill(old.pid, 0)).toThrow(),
					{ timeout: 10_000 },
				);
			}
			await fixture.restart({
				buildId:
					mode === "upgrade"
						? "82tn18-replacement-after"
						: "82tn18-replacement-before",
				startupTimeoutMs: 90_000,
				serviceEnvironment,
			});
			if (mode === "prewarm") {
				const reconnected = await fixture.connect(sessionId);
				await reconnected.preWarmSession(sessionId);
			}
			const replacement = await fixture.waitForMark(
				(mark) =>
					mark.kind === "runner-started" &&
					mark.sessionId === sessionId &&
					mark.pid !== old.pid,
			);
			if (replacement.kind !== "runner-started")
				throw new Error("Missing replacement");
			await vi.waitFor(
				() => expect(existsSync(replacement.socketPath)).toBe(false),
				{ timeout: 10_000 },
			);
			expect(sends(fixture).map(({ days }) => days)).toEqual([null]);
			evidence = {
				driver,
				mode,
				sessionId,
				old,
				replacement,
				replacementUsedCurrentPolicyWithoutSend: true,
			};
		}, 120_000);
	}
}

it("uses A -> B -> A settings saves on the next turn without config reads", async () => {
	const fixture = ProcessHarness.create({
		...build,
		runnerLifecycle: { idleDayMs: 250 },
	});
	harness = fixture;
	await fixture.restart({
		startupTimeoutMs: 90_000,
		serviceEnvironment: { NODE_OPTIONS: preload(fixture) },
	});
	const browser = await fixture.connect();
	await browser.setAutoSettle(null);
	const sessionId = await browser.createSession("A to B to A");
	await browser.send(sessionId, "policy-A");
	await browser.setAutoSettle(1);
	await browser.setAutoSettle(null);
	await browser.send(sessionId, "policy-A-again");
	const runner = await fixture.waitForMark(
		(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
	);
	if (runner.kind !== "runner-started") throw new Error("Missing runner");
	await setTimeout(1400);
	expect(existsSync(runner.socketPath)).toBe(true);
	await browser.setAutoSettle(1);
	await browser.send(sessionId, "policy-B");
	await vi.waitFor(() => expect(existsSync(runner.socketPath)).toBe(false), {
		timeout: 10_000,
	});
	expect(sends(fixture).map(({ days }) => days)).toEqual([null, null, 1]);
	evidence = { sessionId, runner, nextTurnsUsedLatestMemory: true };
}, 120_000);

it("terminalizes a dead runner's admitted command and uses current policy only for the next turn", async () => {
	const fixture = ProcessHarness.create({
		...build,
		restartProof: true,
		runnerLifecycle: { idleDayMs: 250 },
	});
	harness = fixture;
	const serviceEnvironment = { NODE_OPTIONS: preload(fixture) };
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const browser = await fixture.connect();
	await browser.setAutoSettle(null);
	const sessionId = await browser.createSession("Dead runner admission");
	const held = browser
		.send(sessionId, "upgrade-long-turn", 90_000)
		.catch(() => undefined);
	await fixture.waitForMark((mark) => mark.kind === "assistant-held");
	const runner = await fixture.waitForMark(
		(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
	);
	if (runner.kind !== "runner-started") throw new Error("Missing runner");
	await browser.setAutoSettle(1);
	await fixture.kill();
	await held;
	process.kill(runner.pid, "SIGKILL");
	await vi.waitFor(() => expect(() => process.kill(runner.pid, 0)).toThrow(), {
		timeout: 10_000,
	});
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const command = db.prepare<
			[string],
			{ status: string; payload_json: string }
		>(
			"SELECT status, payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
		);
		await vi.waitFor(
			() => expect(command.get(sessionId)?.status).toBe("failed"),
			{ timeout: 30_000 },
		);
		expect(
			JSON.parse(command.get(sessionId)?.payload_json ?? "{}"),
		).toHaveProperty("autoSettleAfterDays", null);
	} finally {
		db.close();
	}
	// Recovery must not execute the dead runner's command a second time.
	expect(sends(fixture)).toHaveLength(1);
	const reconnected = await fixture.connect(sessionId);
	await reconnected.send(sessionId, "after-dead-runner");
	expect(sends(fixture).map(({ days }) => days)).toEqual([null, 1]);
	evidence = { sessionId, runner, deadCommandFailedWithoutResend: true };
}, 120_000);

it("retains Cursor's admitted command snapshot through restart without runtime config reads", async () => {
	const fixture = ProcessHarness.create({
		...build,
		buildId: "82tn18-cursor-before",
		runnerLifecycle: { idleDayMs: 250 },
	});
	harness = fixture;
	const gate = join(fixture.root, "cursor-stream.gate");
	const capture = join(fixture.root, "cursor-capture.ndjson");
	writeFileSync(gate, "hold");
	const serviceEnvironment = {
		NODE_OPTIONS: preload(fixture),
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: resolve(
			"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
		),
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
	};
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const { addedInstanceId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Policy owner",
		driver: "cursor",
		env: { CURSOR_API_KEY: "fake-config-memory-key" },
	});
	if (!addedInstanceId) throw new Error("Missing Cursor account");
	const browser = await fixture.connect();
	await browser.setAutoSettle(null);
	const sessionId = await browser.createSession(
		"Cursor policy",
		addedInstanceId,
		"cursor",
		{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
	);
	const held = browser
		.send(sessionId, "Say hello", 90_000)
		.catch(() => undefined);
	await vi.waitFor(
		() =>
			expect(readFileSync(capture, "utf8")).toContain('"kind":"run.handle"'),
		{ timeout: 30_000 },
	);
	const runner = await fixture.waitForMark(
		(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
	);
	if (runner.kind !== "runner-started") throw new Error("Missing runner");
	await browser.setAutoSettle(1);
	await fixture.kill();
	await held;
	await fixture.restart({
		buildId: "82tn18-cursor-before",
		startupTimeoutMs: 90_000,
		serviceEnvironment,
	});
	await vi.waitFor(() => expect(sends(fixture)).toHaveLength(2), {
		timeout: 15_000,
	});
	expect(sends(fixture).map(({ days }) => days)).toEqual([null, null]);
	expect(sends(fixture)[1]?.commandId).toBe(sends(fixture)[0]?.commandId);
	rmSync(gate);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		await vi.waitFor(
			() =>
				expect(
					db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ?",
						)
						.get(sessionId)?.state,
				).toBe("completed"),
			{ timeout: 30_000 },
		);
	} finally {
		db.close();
	}
	const active = runner;
	await setTimeout(1400);
	evidence = {
		sessionId,
		runner,
		active,
		cursorKeptAdmissionAcrossRestart: existsSync(active.socketPath),
	};
	expect(existsSync(active.socketPath)).toBe(true);
}, 120_000);
