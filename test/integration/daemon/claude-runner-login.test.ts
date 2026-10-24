import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	historicalRunnerBundle,
	launchHistoricalRunners,
} from "../../helpers/historical-runner-bundle.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// This revision actually compared captured shell values. The older default
// historical fixture predates that comparison and cannot expose the regression.
const PRE_DECLARED_LOGIN_COMMIT = "5c2a14f12daedcd760ef7c00d875dddb2b80b46f";
const currentDist = () => resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");

function readMarks(harness: ProcessHarness): ProcessMark[] {
	const path = join(harness.root, "sdk-proof.ndjson");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
		: [];
}

function durable(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			turns: db
				.prepare("SELECT state FROM turns WHERE session_id = ? ORDER BY rowid")
				.all(sessionId),
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId),
			events: db
				.prepare(
					"SELECT sequence, type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{
				sequence: number;
				type: string;
				data: string;
			}>,
		};
	} finally {
		db.close();
	}
}

function queryFor(harness: ProcessHarness, prompt: string) {
	const marks = readMarks(harness);
	const enqueued = marks.filter(
		(mark) => mark.kind === "enqueue" && mark.request === prompt,
	);
	expect(enqueued).toHaveLength(1);
	const enqueue = enqueued[0];
	if (enqueue?.kind !== "enqueue") throw new Error("Missing SDK prompt intake");
	const query = marks.find(
		(mark) => mark.kind === "query" && mark.queryId === enqueue.queryId,
	);
	if (query?.kind !== "query") throw new Error("Missing SDK query");
	return query;
}

async function assertRetained(
	harness: ProcessHarness,
	sessionId: string,
	query: ReturnType<typeof queryFor>,
	prompt: string,
	markCursor: number,
) {
	expect(queryFor(harness, prompt)).toMatchObject({
		pid: query.pid,
		queryId: query.queryId,
		sessionId: query.sessionId,
	});
	expect(harness.remainingRunnerPids()).toContain(query.pid);
	expect(
		readMarks(harness).filter(
			(mark) => mark.kind === "query-closed" && mark.queryId === query.queryId,
		),
	).toEqual([]);
	const admissions = harness.marks
		.slice(markCursor)
		.filter(
			(mark) =>
				mark.kind === "runner-admission" &&
				mark.sessionId === sessionId &&
				mark.command === "send-turn",
		);
	expect(admissions.length).toBeGreaterThan(0);
	for (const admission of admissions)
		expect(admission).toMatchObject({ decision: "Use" });
	await vi.waitFor(
		() => {
			const state = durable(harness, sessionId);
			expect(state.commands).toHaveLength(2);
			expect(state.commands).toEqual(
				state.commands.map(() =>
					expect.objectContaining({ status: "completed" }),
				),
			);
			expect(
				state.events.filter(({ type }) => type === "run.started"),
			).toHaveLength(2);
			expect(
				state.events.filter(({ type }) => type === "turn.completed"),
			).toHaveLength(2);
			expect(
				state.events.filter(
					({ type }) => type === "turn.error" || type === "turn.interrupted",
				),
			).toEqual([]);
		},
		{ timeout: 5_000 },
	);
}

async function recordEvidence(
	harness: ProcessHarness | undefined,
	sessionId: string | undefined,
	evidence: Record<string, unknown>,
	path: string,
) {
	try {
		if (harness) {
			try {
				evidence["beforeCleanup"] = harness.proof();
				evidence["sdk"] = readMarks(harness);
				if (sessionId) evidence["durable"] = durable(harness, sessionId);
				const log = join(harness.root, "login-daemon.log");
				if (existsSync(log)) evidence["log"] = readFileSync(log, "utf8");
				const omissions = join(harness.root, "login-snapshot-omissions.ndjson");
				if (existsSync(omissions))
					evidence["snapshotOmissions"] = readFileSync(omissions, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as unknown);
			} finally {
				await harness.dispose();
				evidence["cleanup"] = harness.proof();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
		}
	} finally {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(path, JSON.stringify(evidence, null, 2));
	}
}

// Strip only wire metadata after the first turn. Both generations retain the
// real query and original capture; the daemon receives the incomplete snapshot.
function omitReattachedLogin(harness: ProcessHarness) {
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`const loginNet = await import("node:net");
const loginAppend = (await import("node:fs")).appendFileSync;
const loginWrite = loginNet.Socket.prototype.write;
loginNet.Socket.prototype.write = function(chunk, ...args) {
  if (/claude-session-runner\\.(?:js|ts)$/.test(process.argv[1] ?? "") &&
      existsSync(join(root, "omit-reattached-login")) &&
      (typeof chunk === "string" || Buffer.isBuffer(chunk))) {
    const wasBuffer = Buffer.isBuffer(chunk);
    const rewritten = chunk.toString().split("\\n").map(line => {
      if (!line) return line;
      let message;
      try { message = JSON.parse(line); } catch { return line; }
      const snapshot = message.type === "hello" ? message.upgradeState?.snapshot :
        message.type === "upgrade-state" ? message.state?.snapshot : undefined;
      const before = Object.keys(snapshot?.input ?? {});
      if (snapshot?.input) {
        delete snapshot.input.account;
        delete snapshot.input.instanceId;
        delete snapshot.input.shellEnv;
      }
      if (message.type === "hello" || message.type === "upgrade-state") {
        loginAppend(join(root, "login-snapshot-omissions.ndjson"), JSON.stringify({
          pid: process.pid, type: message.type, hadSnapshot: !!snapshot,
          quiescent: (message.upgradeState ?? message.state)?.quiescent,
          before, after: Object.keys(snapshot?.input ?? {}),
        }) + "\\n");
      }
      return JSON.stringify(message);
    }).join("\\n");
    chunk = wasBuffer ? Buffer.from(rewritten) : rewritten;
  }
  return loginWrite.call(this, chunk, ...args);
};\n`,
	);
}

// Failures: a legacy runner attempts a busy rebind, a send never reaches the
// SDK, a retry duplicates intake, or the query/background task is replaced.
it("delivers through a legacy runner's background work after shell recapture", async (context) => {
	const evidence: Record<string, unknown> = { passed: false };
	let harness: ProcessHarness | undefined;
	let sessionId: string | undefined;
	try {
		const historical = await historicalRunnerBundle(PRE_DECLARED_LOGIN_COMMIT);
		evidence["historical"] = historical;
		if (!historical.available) context.skip(historical.reason);
		if (!historical.available) return;
		harness = ProcessHarness.create({
			dist: currentDist(),
			buildId: historical.buildId,
			restartProof: true,
			shellEnvProof: true,
			logLevel: "info",
		});
		launchHistoricalRunners(harness, historical);
		const fixture = harness;
		const profile = join(harness.root, "home/.zprofile");
		const captures = join(harness.root, "home/captures");
		const captureCount = () =>
			existsSync(captures) ? readFileSync(captures, "utf8").length : 0;
		writeFileSync(
			profile,
			`${readFileSync(profile, "utf8")}printf x >> "$ZDOTDIR/captures"\nexport VOLATILE_SHELL_TOKEN="capture-$(wc -c < "$ZDOTDIR/captures")"\n`,
		);
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 25_000,
			logFile: join(harness.root, "login-daemon.log"),
		});
		const browser = await harness.connect();
		sessionId = await browser.createSession("Legacy volatile shell recapture");
		expect(
			(await browser.send(sessionId, "login-background-work")).chunks.join(""),
		).toBe(responseChunks("login-background-work").join(""));
		const query = queryFor(harness, "login-background-work");
		evidence["originalQuery"] = query;
		expect(
			harness.marks.find(
				(mark) => mark.kind === "runner-started" && mark.pid === query.pid,
			),
		).toMatchObject({ buildId: historical.buildId, declaresLogin: false });
		await vi.waitFor(
			() => {
				const snapshot = readMarks(fixture)
					.reverse()
					.find(
						(mark) => mark.kind === "runner-snapshot" && mark.pid === query.pid,
					);
				expect(
					snapshot?.kind === "runner-snapshot"
						? JSON.parse(snapshot.snapshotJson).input.shellEnv
								?.VOLATILE_SHELL_TOKEN
						: undefined,
				).toBeDefined();
			},
			{ timeout: 10_000 },
		);
		const before = captureCount();
		writeFileSync(profile, `${readFileSync(profile, "utf8")}\n`);
		await vi.waitFor(() => expect(captureCount()).toBeGreaterThan(before), {
			timeout: 10_000,
		});
		evidence["captures"] = { before, after: captureCount() };
		const markCursor = harness.marks.length;
		const prompt = "after-legacy-volatile-recapture";
		const reply = await browser.send(sessionId, prompt, 15_000);
		evidence["reply"] = reply;
		expect(reply.chunks.join("")).toBe(responseChunks(prompt).join(""));
		await assertRetained(harness, sessionId, query, prompt, markCursor);
		expect(
			readMarks(harness).filter(
				(mark) =>
					mark.kind === "background-work" && mark.queryId === query.queryId,
			),
		).toEqual([expect.objectContaining({ phase: "started" })]);
		evidence["transcript"] = await browser.history(sessionId);
		evidence["passed"] = true;
	} catch (cause) {
		evidence["error"] = cause instanceof Error ? cause.stack : String(cause);
		throw cause;
	} finally {
		await recordEvidence(
			harness,
			sessionId,
			evidence,
			"test-results/wh8g-legacy-shell-recapture.json",
		);
	}
}, 300_000);

// Failures: absent account metadata selects Wait/rebind, restart replaces the
// idle runner, or a reply succeeds only after recreating its native query.
it.for(["legacy", "current"] as const)(
	"keeps an idle %s runner after restart with missing login metadata",
	{ timeout: 300_000 },
	async (generation, context) => {
		const evidence: Record<string, unknown> = { passed: false, generation };
		let harness: ProcessHarness | undefined;
		let sessionId: string | undefined;
		try {
			const historical =
				generation === "legacy" ? await historicalRunnerBundle() : undefined;
			evidence["historical"] = historical;
			if (historical && !historical.available) context.skip(historical.reason);
			if (historical && !historical.available) return;
			harness = ProcessHarness.create({
				dist: currentDist(),
				...(historical ? { buildId: historical.buildId } : {}),
				restartProof: true,
				logLevel: "info",
			});
			if (historical) launchHistoricalRunners(harness, historical);
			omitReattachedLogin(harness);
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 25_000,
				logFile: join(harness.root, "login-daemon.log"),
			});
			let browser = await harness.connect();
			const configDir = join(harness.root, "retained-account");
			mkdirSync(configDir);
			const account = await harness.requestRpc({
				_tag: "AddInstance",
				name: "Retained login",
				driver: "claude",
				configDir,
				env: { ACCOUNT_OWNER: "retained-account" },
			});
			if (!account.addedInstanceId) throw new Error("Missing fixture account");
			sessionId = await browser.createSession(
				`Restart ${generation} login`,
				account.addedInstanceId,
			);
			const initial = `before-${generation}-login-restart`;
			await browser.preWarmSession(sessionId);
			const warmQuery = readMarks(harness).find(
				(mark) => mark.kind === "query" && mark.runnerSessionId === sessionId,
			);
			expect(warmQuery).toBeDefined();
			await browser.send(sessionId, initial);
			const query = queryFor(harness, initial);
			expect(query).toEqual(warmQuery);
			evidence["originalQuery"] = query;
			const markCursor = harness.marks.length;
			writeFileSync(join(harness.root, "omit-reattached-login"), "omit");
			await harness.kill();
			expect(harness.remainingRunnerPids()).toContain(query.pid);
			await harness.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 25_000,
				logFile: join(harness.root, "login-daemon.log"),
			});
			browser = await harness.connect(sessionId);
			const adopted = harness.marks
				.slice(markCursor)
				.find(
					(mark) => mark.kind === "runner-started" && mark.pid === query.pid,
				);
			expect(adopted).toMatchObject({
				declaresLogin: generation === "current",
			});
			const omissions = readFileSync(
				join(harness.root, "login-snapshot-omissions.ndjson"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as { pid: number; type: string; after: string[] },
				);
			expect(omissions).toContainEqual(
				expect.objectContaining({
					pid: query.pid,
					type: "hello",
					quiescent: true,
				}),
			);
			for (const omission of omissions) {
				expect(omission.after).not.toContain("account");
				expect(omission.after).not.toContain("instanceId");
				expect(omission.after).not.toContain("shellEnv");
			}
			const prompt = `after-${generation}-login-restart`;
			const reply = await browser.send(sessionId, prompt, 15_000);
			evidence["reply"] = reply;
			expect(reply.chunks.join("")).toBe(responseChunks(prompt).join(""));
			await assertRetained(harness, sessionId, query, prompt, markCursor);
			evidence["transcript"] = await browser.history(sessionId);
			evidence["passed"] = true;
		} catch (cause) {
			evidence["error"] = cause instanceof Error ? cause.stack : String(cause);
			throw cause;
		} finally {
			await recordEvidence(
				harness,
				sessionId,
				evidence,
				`test-results/u1y3i-4-${generation}-login-restart.json`,
			);
		}
	},
);
