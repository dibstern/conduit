import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const OLD_BUILD = "85kb-13-before-rebuild";
const NEW_BUILD = "85kb-13-after-rebuild";
const WARM_DELAY_MS = 600;

// Failure cases: refusing a compatible old build, switching during a turn or
// before spool acknowledgment, a send waiting for replacement initialization,
// duplicate prompt/event delivery, settings being recomputed, losing the Claude
// session ID, exposing warm failure to the user, and leaking either runner.
function sdkProof(harness: ProcessHarness): ProcessMark[] {
	const path = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProcessMark);
}

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), {
		readonly: true,
	});
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			turns: db
				.prepare("SELECT state FROM turns WHERE session_id = ?")
				.all(sessionId) as Array<{ state: string }>,
			events: (
				db
					.prepare(
						"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as Array<{ type: string; data: string }>
			).map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as Record<string, unknown>,
			})),
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{ command_id: string; status: string }>,
			providerState: db
				.prepare("SELECT key, value FROM provider_state WHERE session_id = ?")
				.all(sessionId) as Array<{ key: string; value: string }>,
		};
	} finally {
		db.close();
	}
}

function queryFor(harness: ProcessHarness, pid: number) {
	const query = sdkProof(harness).find(
		(mark) => mark.kind === "query" && mark.pid === pid,
	);
	if (query?.kind !== "query") throw new Error(`Missing SDK query for ${pid}`);
	return query;
}

function childFinalizerResult(harness: ProcessHarness) {
	const db = new Database(harness.projectStorePath(), {
		readonly: true,
	});
	try {
		return db
			.prepare(
				"SELECT session_id, type, data FROM events WHERE type = 'text.delta' AND json_extract(data, '$.text') = ? ORDER BY sequence",
			)
			.all("late child finalizer result") as Array<{
			session_id: string;
			type: string;
			data: string;
		}>;
	} finally {
		db.close();
	}
}

function runnerFor(harness: ProcessHarness, sessionId: string, pid?: number) {
	const runner = harness.marks.find(
		(mark) =>
			mark.kind === "runner-started" &&
			mark.sessionId === sessionId &&
			(pid === undefined || mark.pid === pid),
	);
	if (runner?.kind !== "runner-started")
		throw new Error(`Missing runner hello for ${sessionId}`);
	return runner;
}

async function upgraded(
	harness: ProcessHarness,
	sessionId: string,
	oldPid: number,
) {
	await vi.waitFor(
		() => {
			expect(
				sdkProof(harness).some(
					(mark) =>
						mark.kind === "runner-upgrade" &&
						mark.phase === "switched" &&
						mark.sessionId === sessionId &&
						mark.oldPid === oldPid,
				),
			).toBe(true);
			expect(() => process.kill(oldPid, 0)).toThrow();
		},
		{ timeout: 10_000 },
	);
	const mark = sdkProof(harness).find(
		(mark) =>
			mark.kind === "runner-upgrade" &&
			mark.phase === "switched" &&
			mark.sessionId === sessionId &&
			mark.oldPid === oldPid,
	);
	if (mark?.kind !== "runner-upgrade" || mark.newPid === undefined)
		throw new Error("Missing switched replacement PID");
	const replacement = runnerFor(harness, sessionId, mark.newPid);
	expect(replacement.buildId).toBe(NEW_BUILD);
	expect(replacement.pid).not.toBe(oldPid);
	const query = queryFor(harness, replacement.pid);
	expect(query.sessionId).toBe(queryFor(harness, oldPid).sessionId);
	expect(
		sdkProof(harness).some(
			(mark) =>
				mark.kind === "initialization-ready" && mark.queryId === query.queryId,
		),
	).toBe(true);
	return replacement;
}

async function completed(
	harness: ProcessHarness,
	sessionId: string,
	prompts: string[],
) {
	await vi.waitFor(
		() => {
			const { events, commands } = persisted(harness, sessionId);
			expect(commands.map((command) => command.status)).toEqual(
				prompts.map(() => "completed"),
			);
			expect(new Set(commands.map((command) => command.command_id)).size).toBe(
				prompts.length,
			);
			expect(
				events.filter(
					(event) =>
						event.type === "message.created" && event.data["role"] === "user",
				),
			).toHaveLength(prompts.length);
			expect(
				events.filter((event) => event.type === "turn.completed"),
			).toHaveLength(prompts.length);
			expect(
				events.filter(
					(event) =>
						event.type === "turn.error" || event.type === "turn.interrupted",
				),
			).toEqual([]);
			for (const prompt of prompts) {
				expect(
					sdkProof(harness).filter(
						(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
					),
				).toHaveLength(1);
				for (const text of responseChunks(prompt))
					expect(
						events.filter(
							(event) =>
								event.type === "text.delta" && event.data["text"] === text,
						),
					).toHaveLength(1);
			}
		},
		{ timeout: 10_000 },
	);
}

describe("Claude runner upgrades at turn boundaries through built dist", () => {
	const fixtures: Array<{
		harness: ProcessHarness;
		artifact: string;
		details: Record<string, unknown>;
	}> = [];
	afterEach(async (context) => {
		for (const { harness, artifact, details } of fixtures) {
			const sdk = sdkProof(harness);
			const beforeCleanup = harness.proof();
			const durable =
				typeof details["sessionId"] === "string"
					? persisted(harness, details["sessionId"])
					: undefined;
			try {
				const release = join(harness.root, "release-held-initialization");
				if (
					sdk.some((mark) => mark.kind === "initialization-held") &&
					!existsSync(release)
				)
					writeFileSync(release, "cleanup release");
				if (sdk.some((mark) => mark.kind === "subagent-finalizer"))
					writeFileSync(
						join(harness.root, "release-subagent-finalizer"),
						"cleanup release",
					);
				await harness.dispose();
				expect(harness.remainingRunnerPids()).toEqual([]);
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/85kb-13-${artifact}.json`,
					JSON.stringify(
						{
							test: context.task.name,
							assertionErrors:
								context.task.result?.errors?.map((error) => error.message) ??
								[],
							...details,
							sdk,
							durable,
							beforeCleanup,
							cleanup: {
								runnerPids: harness.runnerPids(),
								remainingRunnerPids: harness.remainingRunnerPids(),
								proof: harness.proof(),
							},
						},
						null,
						2,
					),
				);
			}
		}
		fixtures.length = 0;
	});

	async function start(
		artifact: string,
		options: Parameters<typeof ProcessHarness.start>[0] = {},
	) {
		const harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			buildId: OLD_BUILD,
			...options,
		});
		const details: Record<string, unknown> = {};
		fixtures.push({ harness, artifact, details });
		const browser = await harness.connect();
		await browser.setAutoSettle(null);
		return { harness, browser, details };
	}

	it("re-adopts an idle old build, acknowledges its spool, and upgrades without another turn", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("rebuild", {
			holdRunnerAck: true,
			runnerLifecycle: { nonDefaultConfigDir: true },
		});
		const sessionId = await initial.createSession("Upgrade after rebuild");
		details["sessionId"] = sessionId;
		const prompt = "restart-upgrade-adopted";
		const pending = initial.send(sessionId, prompt).catch(() => undefined);
		await initial.waitFor((message) => message["type"] === "delta");
		const old = runnerFor(harness, sessionId);
		expect(old.buildId).toBe(OLD_BUILD);
		await harness.kill();
		await pending;
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		await vi.waitFor(() =>
			expect(
				sdkProof(harness).filter(
					(mark) => mark.kind === "emit" && mark.prompt === prompt,
				),
			).toHaveLength(3),
		);
		details["spooledBytesBeforeAdoption"] = statSync(
			`${old.socketPath}.spool`,
		).size;
		expect(details["spooledBytesBeforeAdoption"]).toBeGreaterThan(0);
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(
			harness.marks.filter(
				(mark) => mark.kind === "runner-started" && mark.pid === old.pid,
			),
		).toHaveLength(2);
		expect(
			replacement.socketPath.startsWith(`${join(harness.configDir, "r")}/`),
		).toBe(true);
		await completed(harness, sessionId, [prompt]);
		await vi.waitFor(
			() => expect(existsSync(`${old.socketPath}.spool`)).toBe(false),
			{ timeout: 5000 },
		);
		expect(JSON.stringify(await browser.history(sessionId))).toContain(
			responseChunks(prompt).join(""),
		);
		details["oldRunner"] = old;
		details["replacement"] = replacement;
	}, 40_000);

	it("sends through the old warm query during a switch and retries at that turn end", async () => {
		const { harness, details, browser: initial } = await start("send-race");
		const sessionId = await initial.createSession("Upgrade send race");
		details["sessionId"] = sessionId;
		await initial.preWarmSession(sessionId);
		const baselinePrompt = "upgrade-baseline";
		const baselineStart = process.hrtime.bigint();
		expect((await initial.send(sessionId, baselinePrompt)).chunks).toEqual(
			responseChunks(baselinePrompt),
		);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		const baseline = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === baselinePrompt,
		);
		if (baseline?.kind !== "enqueue")
			throw new Error("Missing baseline enqueue");
		const baselineMs = Number(BigInt(baseline.at) - baselineStart) / 1e6;
		await harness.kill();
		writeFileSync(join(harness.root, "hold-next-initialization"), "hold once");
		await harness.restart({
			buildId: NEW_BUILD,
			queryInitializationDelayMs: WARM_DELAY_MS,
		});
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).filter((mark) => mark.kind === "query"),
				).toHaveLength(2),
			{ timeout: 10_000 },
		);
		const candidate = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.pid !== old.pid,
		);
		if (candidate?.kind !== "query")
			throw new Error("Missing warming replacement");
		await vi.waitFor(() =>
			expect(
				sdkProof(harness).some(
					(mark) =>
						mark.kind === "initialization-held" &&
						mark.queryId === candidate.queryId,
				),
			).toBe(true),
		);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "initialization-ready" &&
					mark.queryId === candidate.queryId,
			),
		).toBe(false);
		const racePrompt = "upgrade-racing-send";
		const raceStart = process.hrtime.bigint();
		expect((await browser.send(sessionId, racePrompt)).chunks).toEqual(
			responseChunks(racePrompt),
		);
		const enqueue = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === racePrompt,
		);
		if (enqueue?.kind !== "enqueue") throw new Error("Missing racing enqueue");
		expect(enqueue.queryId).toBe(oldQuery.queryId);
		const raceMs = Number(BigInt(enqueue.at) - raceStart) / 1e6;
		// A held readiness barrier proves the send does not await warming. The
		// artifact reports the same-test latency delta; the benchmark gates +2 ms.
		expect(existsSync(join(harness.root, "release-held-initialization"))).toBe(
			false,
		);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "initialization-ready" &&
					mark.queryId === candidate.queryId,
			),
		).toBe(false);
		writeFileSync(join(harness.root, "release-held-initialization"), "release");
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(replacement.pid).not.toBe(candidate.pid);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "runner-upgrade" &&
					mark.phase === "cancelled" &&
					mark.oldPid === old.pid,
			),
		).toBe(true);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "enqueue" && mark.queryId === candidate.queryId,
			),
		).toEqual([]);
		const after = "upgrade-after-race";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await completed(harness, sessionId, [baselinePrompt, racePrompt, after]);
		details["latency"] = {
			baselineMs,
			raceMs,
			deltaMs: raceMs - baselineMs,
			warmingDelayMs: WARM_DELAY_MS,
			completedBeforeInitializationRelease: true,
		};
		details["oldRunner"] = old;
		details["cancelledCandidate"] = candidate;
		details["replacement"] = replacement;
	}, 30_000);

	it("passes the Effective Settings Snapshot byte for byte after stored settings change", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("settings-snapshot");
		await Effect.runPromise(
			initial.rpc.SetClaudeSettings({
				projectSlug: "process-test",
				overrides: { disableAllHooks: true },
				originId: initial.originId,
			}),
		);
		const sessionId = await initial.createSession("Frozen settings upgrade");
		details["sessionId"] = sessionId;
		const before = "upgrade-before-settings-change";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		expect(oldQuery.options.settings).toEqual({ disableAllHooks: true });
		const changed = await Effect.runPromise(
			initial.rpc.SetClaudeSettings({
				projectSlug: "process-test",
				overrides: { disableAllHooks: false },
				originId: initial.originId,
			}),
		);
		expect(changed.overrides).toEqual({ disableAllHooks: false });
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		expect(
			(
				await Effect.runPromise(
					browser.rpc.GetClaudeSettings({ projectSlug: "process-test" }),
				)
			).overrides,
		).toEqual({ disableAllHooks: false });
		const replacement = await upgraded(harness, sessionId, old.pid);
		const oldSnapshot = sdkProof(harness).find(
			(mark) => mark.kind === "runner-snapshot" && mark.pid === old.pid,
		);
		const newSnapshot = sdkProof(harness).find(
			(mark) => mark.kind === "runner-snapshot" && mark.pid === replacement.pid,
		);
		if (
			oldSnapshot?.kind !== "runner-snapshot" ||
			newSnapshot?.kind !== "runner-snapshot"
		)
			throw new Error("Missing Effective Settings Snapshot evidence");
		expect(newSnapshot.snapshotJson).toBe(oldSnapshot.snapshotJson);
		expect(queryFor(harness, replacement.pid).optionsJson).toBe(
			oldQuery.optionsJson,
		);
		const after = "upgrade-after-settings-change";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await completed(harness, sessionId, [before, after]);
		details["oldSnapshot"] = oldSnapshot;
		details["newSnapshot"] = newSnapshot;
		details["storedSettings"] = changed.overrides;
		details["replacement"] = replacement;
	}, 30_000);

	it("finishes a held turn on the old runner before warming the replacement", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("turn-in-flight");
		const sessionId = await initial.createSession("Uninterrupted upgrade turn");
		details["sessionId"] = sessionId;
		const prompt = "upgrade-long-turn";
		const pending = initial.send(sessionId, prompt).catch(() => undefined);
		await initial.waitFor((message) => message["type"] === "delta");
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		await harness.kill();
		await pending;
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await new Promise<void>((done) => setTimeout(done, 150));
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "warming",
			),
		).toEqual([]);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "emit" && mark.prompt === prompt,
			),
		).toHaveLength(1);
		const done = browser.waitFor(
			(message) =>
				message["type"] === "done" && message["sessionId"] === sessionId,
		);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await done)["code"]).toBe(0);
		const replacement = await upgraded(harness, sessionId, old.pid);
		await completed(harness, sessionId, [prompt]);
		const emits = sdkProof(harness).filter(
			(mark) => mark.kind === "emit" && mark.prompt === prompt,
		);
		const closed = sdkProof(harness).find(
			(mark) =>
				mark.kind === "query-closed" && mark.queryId === oldQuery.queryId,
		);
		const last = emits.at(-1);
		if (closed?.kind !== "query-closed" || last?.kind !== "emit")
			throw new Error("Missing old-query completion ordering evidence");
		expect(BigInt(closed.at)).toBeGreaterThan(BigInt(last.at));
		expect(JSON.stringify(await browser.history(sessionId))).toContain(
			responseChunks(prompt).join(""),
		);
		details["oldRunner"] = old;
		details["replacement"] = replacement;
		details["oldQueryClosedAfterFinalDelta"] = true;
	}, 30_000);

	it("keeps the old runner serving after warm failure and retries at the next turn end", async () => {
		const { harness, details, browser: initial } = await start("warm-failure");
		const sessionId = await initial.createSession(
			"Upgrade initialization failure",
		);
		details["sessionId"] = sessionId;
		const before = "upgrade-before-warm-failure";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		writeFileSync(join(harness.root, "fail-next-initialization"), "fail once");
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "runner-upgrade" &&
							mark.phase === "failed" &&
							mark.oldPid === old.pid,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		expect(existsSync(join(harness.root, "fail-next-initialization"))).toBe(
			false,
		);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "initialization-failed"),
		).toHaveLength(1);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(2);
		const retry = "upgrade-retry-after-failure";
		expect((await browser.send(sessionId, retry)).chunks).toEqual(
			responseChunks(retry),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === retry,
			),
		).toMatchObject({ queryId: oldQuery.queryId });
		const replacement = await upgraded(harness, sessionId, old.pid);
		const after = "upgrade-after-warm-failure";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await completed(harness, sessionId, [before, retry, after]);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "done" && message["code"] === 1,
			),
		).toEqual([]);
		details["oldRunner"] = old;
		details["replacement"] = replacement;
		details["failedWarmAttempts"] = 1;
	}, 30_000);

	it("keeps a pending approval answerable across a build mismatch and upgrades after the reply", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("pending-approval");
		const sessionId = await initial.createSession("Approval during upgrade");
		details["sessionId"] = sessionId;
		const prompt = "approval-upgrade-mismatch";
		const pending = initial.send(sessionId, prompt).catch(() => undefined);
		const request = await initial.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const old = runnerFor(harness, sessionId);
		await harness.kill();
		await pending;
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await new Promise<void>((done) => setTimeout(done, 150));
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "warming",
			),
		).toEqual([]);
		const done = browser.waitFor(
			(message) =>
				message["type"] === "done" && message["sessionId"] === sessionId,
		);
		await browser.answerApproval(request, "allow");
		expect((await done)["code"]).toBe(0);
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "approval" && mark.prompt === prompt,
			),
		).toEqual([{ kind: "approval", prompt, behavior: "allow" }]);
		const after = "upgrade-after-approval";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await completed(harness, sessionId, [prompt, after]);
		const durable = persisted(harness, sessionId);
		expect(
			durable.events.filter((event) => event.type === "permission.asked"),
		).toHaveLength(1);
		expect(
			durable.events.filter((event) => event.type === "permission.resolved"),
		).toHaveLength(1);
		details["request"] = request;
		details["oldRunner"] = old;
		details["replacement"] = replacement;
	}, 30_000);

	it("waits for live background work to finish after the foreground turn ended", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("background-work");
		const sessionId = await initial.createSession(
			"Background work during upgrade",
		);
		details["sessionId"] = sessionId;
		const prompt = "upgrade-background-work";
		expect((await initial.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		await completed(harness, sessionId, [prompt]);
		const old = runnerFor(harness, sessionId);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "background-work" && mark.phase === "started",
			),
		).toHaveLength(1);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await new Promise<void>((done) => setTimeout(done, 150));
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "warming",
			),
		).toEqual([]);
		writeFileSync(join(harness.root, "release-upgrade-background"), "release");
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "background-work" && mark.phase === "completed",
			),
		).toHaveLength(1);
		const after = "upgrade-after-background";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await completed(harness, sessionId, [prompt, after]);
		details["oldRunner"] = old;
		details["replacement"] = replacement;
		details["foregroundFinishedBeforeMismatch"] = true;
	}, 30_000);

	it.each([
		"before-restart",
		"during-warm",
	] as const)("keeps a notification-driven parent turn on the old runner %s until its result", async (timing) => {
		const {
			harness,
			details,
			browser: initial,
		} = await start(`nzjt-notification-${timing}`);
		const sessionId = await initial.createSession("Notification turn upgrade");
		details["sessionId"] = sessionId;
		const prompt =
			timing === "during-warm"
				? "notification-parent-turn-during-warm"
				: "notification-parent-turn";
		expect((await initial.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		await completed(harness, sessionId, [prompt]);
		const old = runnerFor(harness, sessionId);
		let candidate: Extract<ProcessMark, { kind: "query" }> | undefined;
		if (timing === "during-warm") {
			await harness.kill();
			writeFileSync(join(harness.root, "hold-next-initialization"), "hold");
			await harness.restart({ buildId: NEW_BUILD });
			await harness.connect(sessionId);
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some(
							(mark) => mark.kind === "initialization-held",
						),
					).toBe(true),
				{ timeout: 10_000 },
			);
			candidate = sdkProof(harness).find(
				(mark): mark is Extract<ProcessMark, { kind: "query" }> =>
					mark.kind === "query" && mark.pid !== old.pid,
			);
			expect(candidate).toBeDefined();
		}

		writeFileSync(join(harness.root, "release-notification-parent"), "release");
		await vi.waitFor(
			() => {
				const state = persisted(harness, sessionId);
				expect(state.session.status).toBe("busy");
				expect(state.turns).toEqual([{ state: "running" }]);
				expect(
					state.events.some(
						(event) =>
							event.type === "text.delta" &&
							event.data["text"] === "Notification parent message.",
					),
				).toBe(true);
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "notification-turn" && mark.phase === "held",
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		details["held"] = persisted(harness, sessionId);
		if (timing === "before-restart") {
			await harness.kill();
			await harness.restart({ buildId: NEW_BUILD });
			await harness.connect(sessionId);
		} else {
			writeFileSync(
				join(harness.root, "release-held-initialization"),
				"release",
			);
			await vi.waitFor(
				() => {
					expect(
						sdkProof(harness).some(
							(mark) =>
								mark.kind === "runner-upgrade" &&
								mark.phase === "cancelled" &&
								mark.oldPid === old.pid,
						),
					).toBe(true);
					if (candidate) expect(() => process.kill(candidate.pid, 0)).toThrow();
				},
				{ timeout: 10_000 },
			);
		}
		// The fake is between parent messages, with no conduit send waiter and
		// no live background task. Only the unfinished SDK turn protects it.
		await new Promise<void>((done) => setTimeout(done, 250));
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(persisted(harness, sessionId)).toMatchObject({
			session: { status: "busy" },
			turns: [{ state: "running" }],
			commands: [{ status: "completed" }],
		});
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "switched",
			),
		).toEqual([]);
		if (timing === "before-restart")
			expect(
				sdkProof(harness).filter(
					(mark) => mark.kind === "runner-upgrade" && mark.phase === "warming",
				),
			).toEqual([]);

		writeFileSync(join(harness.root, "release-notification-result"), "release");
		const replacement = await upgraded(harness, sessionId, old.pid);
		await vi.waitFor(() => {
			const state = persisted(harness, sessionId);
			expect(state.session.status).toBe("idle");
			expect(state.turns).toEqual([{ state: "completed" }]);
			expect(state.commands).toHaveLength(1);
			expect(state.commands[0]?.status).toBe("completed");
			expect(
				state.events.filter((event) => event.type === "turn.completed"),
			).toHaveLength(2);
			expect(
				state.events.filter(
					(event) =>
						event.type === "turn.interrupted" || event.type === "turn.error",
				),
			).toEqual([]);
		});
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(1);
		details["oldRunner"] = old;
		details["cancelledCandidate"] = candidate;
		details["replacement"] = replacement;
		details["notificationHadNoSendCommand"] = true;
	}, 40_000);

	it("re-adopts the old runner and cleans an abandoned replacement after a crash while warming", async () => {
		const { harness, details, browser: initial } = await start("warming-crash");
		const sessionId = await initial.createSession("Crash during upgrade");
		details["sessionId"] = sessionId;
		const before = "upgrade-before-candidate-crash";
		await initial.send(sessionId, before);
		await completed(harness, sessionId, [before]);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		await harness.kill();
		await harness.restart({
			buildId: NEW_BUILD,
			queryInitializationDelayMs: 5000,
		});
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).filter((mark) => mark.kind === "query"),
				).toHaveLength(2),
			{ timeout: 5000 },
		);
		const candidate = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.pid !== old.pid,
		);
		if (candidate?.kind !== "query")
			throw new Error("Missing unready candidate before crash");
		const abandoned = runnerFor(harness, sessionId, candidate.pid);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "initialization-ready" &&
					mark.queryId === candidate.queryId,
			),
		).toBe(false);
		const adoptionCursor = harness.marks.length;
		await harness.kill();
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(() => process.kill(candidate.pid, 0)).not.toThrow();
		writeFileSync(join(harness.root, "hold-next-initialization"), "hold once");
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		expect(
			harness.marks
				.slice(adoptionCursor)
				.some((mark) => mark.kind === "runner-started" && mark.pid === old.pid),
		).toBe(true);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).filter(
						(mark) => mark.kind === "initialization-held",
					),
				).toHaveLength(1),
			{ timeout: 5000 },
		);
		const held = sdkProof(harness).find(
			(mark) =>
				mark.kind === "query" &&
				mark.pid !== old.pid &&
				mark.pid !== candidate.pid,
		);
		if (held?.kind !== "query")
			throw new Error("Missing held replacement after recovery");
		const after = "upgrade-after-candidate-crash";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: oldQuery.queryId });
		expect(existsSync(join(harness.root, "release-held-initialization"))).toBe(
			false,
		);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "initialization-ready" && mark.queryId === held.queryId,
			),
		).toBe(false);
		writeFileSync(join(harness.root, "release-held-initialization"), "release");
		await vi.waitFor(
			() => {
				expect(() => process.kill(candidate.pid, 0)).toThrow();
				expect(existsSync(abandoned.socketPath)).toBe(false);
			},
			{ timeout: 6000 },
		);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "enqueue" && mark.queryId === candidate.queryId,
			),
		).toEqual([]);
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(replacement.pid).not.toBe(candidate.pid);
		await completed(harness, sessionId, [before, after]);
		details["oldRunner"] = old;
		details["abandonedCandidate"] = abandoned;
		details["heldCandidate"] = held;
		details["replacement"] = replacement;
	}, 40_000);

	it("review regression: persists a pending subagent finalizer before upgrading", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-subagent-finalizer", {
			subagentPollTimeoutMs: 30_000,
		});
		const sessionId = await initial.createSession(
			"Upgrade waits for subagent finalizer",
		);
		details["sessionId"] = sessionId;
		const prompt = "review-subagent-finalizer";
		expect((await initial.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		const old = runnerFor(harness, sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "subagent-finalizer" &&
							mark.phase === "started" &&
							mark.pid === old.pid,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		await completed(harness, sessionId, [prompt]);
		expect(persisted(harness, sessionId).events).toContainEqual(
			expect.objectContaining({
				type: "tool.running",
				data: expect.objectContaining({
					partId: "review-finalizer-tool",
					metadata: expect.objectContaining({ status: "completed" }),
				}),
			}),
		);
		expect(childFinalizerResult(harness)).toEqual([]);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		await harness.connect(sessionId);
		// Keep catch-up held long enough to expose replacement startup under load.
		await new Promise<void>((done) => setTimeout(done, 4000));
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			harness.marks.filter(
				(mark) => mark.kind === "runner-spawned" && mark.pid !== old.pid,
			),
		).toEqual([]);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "runner-upgrade" && mark.phase === "warming",
			),
		).toEqual([]);
		writeFileSync(join(harness.root, "release-subagent-finalizer"), "release");
		await vi.waitFor(
			() => expect(childFinalizerResult(harness)).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const replacement = await upgraded(harness, sessionId, old.pid);
		await completed(harness, sessionId, [prompt]);
		expect(childFinalizerResult(harness)[0]?.session_id).not.toBe(sessionId);
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "subagent-finalizer" &&
					mark.phase === "completed" &&
					mark.pid === old.pid,
			),
		).toBe(true);
		details["oldRunner"] = old;
		details["replacement"] = replacement;
		details["childResult"] = childFinalizerResult(harness);
	}, 40_000);

	it("review regression: preserves the Claude cursor when its first turn was interrupted", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-first-interrupt");
		const sessionId = await initial.createSession(
			"Interrupted first-turn upgrade",
		);
		details["sessionId"] = sessionId;
		const prompt = "stall-review-first-interrupt";
		const pending = initial.send(sessionId, prompt).catch(() => undefined);
		await initial.waitFor((message) => message["type"] === "delta");
		const old = runnerFor(harness, sessionId);
		const originalQuery = queryFor(harness, old.pid);
		await vi.waitFor(() =>
			expect(
				sdkProof(harness).some(
					(mark) =>
						mark.kind === "system-init" &&
						mark.queryId === originalQuery.queryId,
				),
			).toBe(true),
		);
		await Effect.runPromise(
			initial.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await pending;
		await vi.waitFor(
			() => {
				const state = persisted(harness, sessionId);
				expect(
					state.events.filter((event) => event.type === "turn.interrupted"),
				).toHaveLength(1);
				expect(
					state.events.filter((event) => event.type === "turn.completed"),
				).toEqual([]);
			},
			{ timeout: 5000 },
		);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(queryFor(harness, replacement.pid).sessionId).toBe(
			originalQuery.sessionId,
		);
		const after = "review-resume-after-first-interrupt";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		await vi.waitFor(
			() => {
				const state = persisted(harness, sessionId);
				expect(
					state.events.filter((event) => event.type === "turn.interrupted"),
				).toHaveLength(1);
				expect(
					state.events.filter((event) => event.type === "turn.completed"),
				).toHaveLength(1);
				expect(
					state.events.filter((event) => event.type === "turn.error"),
				).toEqual([]);
				expect(state.commands).toHaveLength(2);
				expect(state.commands.map((command) => command.status)).toEqual([
					"failed",
					"completed",
				]);
			},
			{ timeout: 5000 },
		);
		for (const sent of [prompt, after])
			expect(
				sdkProof(harness).filter(
					(mark) => mark.kind === "enqueue" && mark.prompt === sent,
				),
			).toHaveLength(1);
		details["originalClaudeSessionId"] = originalQuery.sessionId;
		details["replacement"] = replacement;
	}, 40_000);

	it.each([
		"live",
		"incoming",
	] as const)("merge regression: the actual first upgraded send uses the %s resume cursor", async (cursorSource) => {
		const {
			harness,
			details,
			browser: initial,
		} = await start(
			cursorSource === "live"
				? "merge-first-send-cursor"
				: "incoming-resume-cursor",
		);
		const sessionId = await initial.createSession("Actual resumed first send");
		details["sessionId"] = sessionId;
		const interrupted = "stall-merge-first-turn";
		const pending = initial.send(sessionId, interrupted).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) => mark.kind === "emit" && mark.prompt === interrupted,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const old = runnerFor(harness, sessionId);
		const originalQuery = queryFor(harness, old.pid);
		await Effect.runPromise(
			initial.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await pending;
		await vi.waitFor(
			() => {
				const state = persisted(harness, sessionId);
				expect(state.commands.map((command) => command.status)).toEqual([
					"failed",
				]);
				expect(
					state.events.filter((event) => event.type === "turn.interrupted"),
				).toHaveLength(1);
				expect(
					state.providerState.find(({ key }) => key === "resumeSessionId"),
				).toBeUndefined();
			},
			{ timeout: 10_000 },
		);
		details["providerStateBeforeUpgrade"] = persisted(
			harness,
			sessionId,
		).providerState;
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const warmed = queryFor(harness, replacement.pid);
		const expectedResume =
			cursorSource === "incoming" ? randomUUID() : originalQuery.sessionId;
		if (cursorSource === "incoming") {
			const db = new Database(harness.projectStorePath());
			try {
				db.prepare(
					"INSERT INTO provider_state (session_id, key, value) VALUES (?, 'resumeSessionId', ?)",
				).run(sessionId, expectedResume);
			} finally {
				db.close();
			}
		}
		const after = "merge-actual-first-upgraded-send";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		const enqueue = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === after,
		);
		if (enqueue?.kind !== "enqueue")
			throw new Error("Missing actual first-send enqueue");
		if (cursorSource === "live") expect(enqueue.queryId).toBe(warmed.queryId);
		else expect(enqueue.queryId).not.toBe(warmed.queryId);
		const actualQueryId = enqueue.queryId;
		const actualQuery = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.queryId === actualQueryId,
		);
		expect(actualQuery).toMatchObject({ sessionId: expectedResume });
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(cursorSource === "live" ? 2 : 3);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toHaveLength(1);
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.map(
						(command) => command.status,
					),
				).toEqual(["failed", "completed"]),
			{ timeout: 10_000 },
		);
		details["originalClaudeSessionId"] = originalQuery.sessionId;
		details["expectedResumeSessionId"] = expectedResume;
		details["actualFirstSendQuery"] = actualQuery;
		details["replacement"] = replacement;
	}, 40_000);

	it("clears a rejected live cursor after upgrade and retries on a fresh Claude session", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("invalidated-resume-cursor");
		const sessionId = await initial.createSession("Rejected upgraded cursor");
		details["sessionId"] = sessionId;
		const interrupted = "stall-invalidated-resume-first-turn";
		const pending = initial.send(sessionId, interrupted).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) => mark.kind === "emit" && mark.prompt === interrupted,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const old = runnerFor(harness, sessionId);
		const original = queryFor(harness, old.pid);
		await Effect.runPromise(
			initial.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await pending;
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.map(({ status }) => status),
				).toEqual(["failed"]),
			{ timeout: 10_000 },
		);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const warmed = queryFor(harness, replacement.pid);
		writeFileSync(
			join(harness.root, "rejected-resume-session-id"),
			original.sessionId,
		);
		const rejected = "invalidated-resume-rejected-send";
		await Effect.runPromise(
			browser.rpc.SendMessage({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				commandId: randomUUID(),
				text: rejected,
			}),
		);
		await vi.waitFor(
			() => {
				expect(
					sdkProof(harness).filter((mark) => mark.kind === "resume-rejected"),
				).toEqual([
					{
						kind: "resume-rejected",
						prompt: rejected,
						queryId: warmed.queryId,
						sessionId: original.sessionId,
					},
				]);
				const state = persisted(harness, sessionId);
				expect(state.commands.map(({ status }) => status)).toEqual([
					"failed",
					"failed",
				]);
				expect(
					state.providerState.find(({ key }) => key === "resumeSessionId"),
				).toBeUndefined();
			},
			{ timeout: 10_000 },
		);
		details["providerStateAfterRejection"] = persisted(
			harness,
			sessionId,
		).providerState;
		const retried = "invalidated-resume-fresh-send";
		const retry = browser.send(sessionId, retried).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) => mark.kind === "enqueue" && mark.prompt === retried,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const enqueue = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === retried,
		);
		if (enqueue?.kind !== "enqueue") throw new Error("Missing retry enqueue");
		const actualQueryId = enqueue.queryId;
		const fresh = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.queryId === actualQueryId,
		);
		if (fresh?.kind !== "query") throw new Error("Missing retry query");
		details["originalClaudeSessionId"] = original.sessionId;
		details["freshClaudeSessionId"] = fresh.sessionId;
		details["replacement"] = replacement;
		expect(fresh.sessionId).not.toBe(original.sessionId);
		expect(fresh.pid).toBe(replacement.pid);
		expect((await retry)?.chunks).toEqual(responseChunks(retried));
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "resume-rejected"),
		).toHaveLength(1);
		for (const prompt of [interrupted, rejected, retried])
			expect(
				sdkProof(harness).filter(
					(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
				),
			).toHaveLength(1);
		await vi.waitFor(
			() => {
				const state = persisted(harness, sessionId);
				expect(state.commands.map(({ status }) => status)).toEqual([
					"failed",
					"failed",
					"completed",
				]);
				expect(
					state.events.filter((event) => event.type === "turn.completed"),
				).toHaveLength(1);
				expect(
					state.providerState.find(({ key }) => key === "resumeSessionId")
						?.value,
				).toBe(fresh.sessionId);
			},
			{ timeout: 10_000 },
		);
	}, 40_000);

	it("merge regression: recreating an upgraded query replays file settings changed after the switch", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("merge-file-settings-recreation");
		const settingsFile = join(harness.root, "claude/settings.json");
		writeFileSync(
			settingsFile,
			JSON.stringify({
				autoCompactEnabled: false,
				cleanupPeriodDays: 9,
			}),
		);
		const sessionId = await initial.createSession(
			"Frozen later query generations",
		);
		details["sessionId"] = sessionId;
		const before = "merge-settings-before-switch";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const original = queryFor(harness, old.pid);
		await completed(harness, sessionId, [before]);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const warmed = queryFor(harness, replacement.pid);
		expect(JSON.parse(warmed.optionsJson)["settingSources"]).toEqual([
			"user",
			"project",
			"local",
		]);
		expect(warmed.effectiveSettingsJson).toBe(original.effectiveSettingsJson);
		const firstWarmSend = "merge-settings-first-warm-send";
		await browser.send(sessionId, firstWarmSend);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === firstWarmSend,
			),
		).toMatchObject({ queryId: warmed.queryId });
		await completed(harness, sessionId, [before, firstWarmSend]);
		const unsupportedEdits = {
			autoCompactEnabled: true,
			cleanupPeriodDays: 99,
			permissions: { allow: ["Bash(printf merge-healthy*)"] },
		};
		writeFileSync(settingsFile, JSON.stringify(unsupportedEdits));
		const healthy = "merge-settings-healthy-query-after-unsupported-edit";
		expect((await browser.send(sessionId, healthy)).chunks).toEqual(
			responseChunks(healthy),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === healthy,
			),
		).toMatchObject({ queryId: warmed.queryId });
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(2);
		await completed(harness, sessionId, [before, firstWarmSend, healthy]);
		details["unsupportedEditsWhileQueryHealthy"] = unsupportedEdits;
		details["healthyQueryAfterUnsupportedEdit"] = warmed.queryId;
		writeFileSync(
			settingsFile,
			JSON.stringify({
				autoCompactEnabled: true,
				cleanupPeriodDays: 99,
			}),
		);
		const interrupted = "stall-merge-settings-recreate";
		const pending = browser.send(sessionId, interrupted).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).find(
						(mark) => mark.kind === "enqueue" && mark.prompt === interrupted,
					),
				).toMatchObject({ queryId: warmed.queryId }),
			{ timeout: 10_000 },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await pending;
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).events.filter(
						(event) => event.type === "turn.interrupted",
					),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const after = "merge-settings-after-query-recreation";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		const enqueue = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === after,
		);
		if (enqueue?.kind !== "enqueue")
			throw new Error("Missing recreated query enqueue");
		const recreatedQueryId = enqueue.queryId;
		const recreated = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.queryId === recreatedQueryId,
		);
		if (recreated?.kind !== "query")
			throw new Error("Missing recreated SDK query");
		expect(recreated.queryId).not.toBe(warmed.queryId);
		expect(recreated.pid).toBe(replacement.pid);
		expect(recreated.sessionId).toBe(original.sessionId);
		expect(recreated.effectiveSettingsJson).toBe(
			original.effectiveSettingsJson,
		);
		expect(JSON.parse(recreated.effectiveSettingsJson)).toMatchObject({
			autoCompactEnabled: false,
			cleanupPeriodDays: 9,
		});
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(3);
		await vi.waitFor(
			() =>
				expect(
					persisted(harness, sessionId).commands.map(
						(command) => command.status,
					),
				).toEqual([
					"completed",
					"completed",
					"completed",
					"failed",
					"completed",
				]),
			{ timeout: 10_000 },
		);
		details["frozenEffectiveSettingsJson"] = original.effectiveSettingsJson;
		details["mutatedSettingsFile"] = JSON.parse(
			readFileSync(settingsFile, "utf8"),
		) as unknown;
		details["actualRecreatedQuery"] = recreated;
		details["replacement"] = replacement;
	}, 40_000);

	it("regression: recreating an upgraded query rereads changed settings when replay is impossible", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("unreplayable-file-settings-recreation");
		// Project instructions make replay impossible, as in any real repository.
		writeFileSync(join(harness.projectDir, "CLAUDE.md"), "Project rules.\n");
		const settingsFile = join(harness.root, "claude/settings.json");
		writeFileSync(settingsFile, JSON.stringify({ autoCompactEnabled: false }));
		const sessionId = await initial.createSession("Unreplayable settings");
		details["sessionId"] = sessionId;
		const before = "unreplayable-before-switch";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		await completed(harness, sessionId, [before]);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const warmed = queryFor(harness, replacement.pid);
		// The user edits settings after the switch, e.g. saving a default effort.
		writeFileSync(settingsFile, JSON.stringify({ autoCompactEnabled: true }));
		const interrupted = "stall-unreplayable-recreate";
		const pending = browser.send(sessionId, interrupted).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).find(
						(mark) => mark.kind === "enqueue" && mark.prompt === interrupted,
					),
				).toMatchObject({ queryId: warmed.queryId }),
			{ timeout: 10_000 },
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await pending;
		const after = "unreplayable-after-query-recreation";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		const enqueue = sdkProof(harness).find(
			(mark) => mark.kind === "enqueue" && mark.prompt === after,
		);
		if (enqueue?.kind !== "enqueue")
			throw new Error("Missing recreated query enqueue");
		const recreated = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.queryId === enqueue.queryId,
		);
		if (recreated?.kind !== "query")
			throw new Error("Missing recreated SDK query");
		expect(recreated.queryId).not.toBe(warmed.queryId);
		expect(recreated.pid).toBe(replacement.pid);
		// Like a runner that was never upgraded, the new query reads the files natively.
		expect(JSON.parse(recreated.optionsJson)["settingSources"]).toEqual([
			"user",
			"project",
			"local",
		]);
		expect(JSON.parse(recreated.effectiveSettingsJson)).toMatchObject({
			autoCompactEnabled: true,
		});
		details["actualRecreatedQuery"] = recreated;
	}, 40_000);

	it("merge regression: live controls invalidate a replacement still warming", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("merge-live-controls-warming");
		const sessionId = await initial.createSession(
			"Control changes during warming",
		);
		details["sessionId"] = sessionId;
		const before = "merge-controls-before-restart";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const original = queryFor(harness, old.pid);
		await completed(harness, sessionId, [before]);
		writeFileSync(join(harness.root, "hold-next-initialization"), "hold once");
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).filter((mark) => mark.kind === "query"),
				).toHaveLength(2),
			{ timeout: 10_000 },
		);
		const stale = sdkProof(harness).find(
			(mark) => mark.kind === "query" && mark.pid !== old.pid,
		);
		if (stale?.kind !== "query")
			throw new Error("Missing held control-race candidate");
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).find(
						(mark) =>
							mark.kind === "initialization-held" &&
							mark.queryId === stale.queryId,
					),
				).toBeDefined(),
			{ timeout: 10_000 },
		);
		const modelId =
			original.options.model === "claude-opus-4"
				? "claude-sonnet-4"
				: "claude-opus-4";
		const payload = {
			projectSlug: "process-test",
			sessionId,
			originId: browser.originId,
		};
		await Effect.runPromise(
			browser.rpc.SwitchModel({ ...payload, providerId: "claude", modelId }),
		);
		await Effect.runPromise(
			browser.rpc.SwitchVariant({ ...payload, variant: "high" }),
		);
		await Effect.runPromise(
			browser.rpc.SwitchPermissionMode({ ...payload, mode: "full" }),
		);
		await vi.waitFor(
			() => {
				const updates = sdkProof(harness).filter(
					(mark) =>
						mark.kind === "query-update" && mark.queryId === original.queryId,
				);
				expect(updates).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ model: modelId }),
						expect.objectContaining({ effort: "high" }),
						expect.objectContaining({ permissionMode: "bypassPermissions" }),
					]),
				);
			},
			{ timeout: 10_000 },
		);
		expect(existsSync(join(harness.root, "release-held-initialization"))).toBe(
			false,
		);
		writeFileSync(join(harness.root, "release-held-initialization"), "release");
		await vi.waitFor(
			() => {
				expect(
					sdkProof(harness).find(
						(mark) =>
							mark.kind === "runner-upgrade" &&
							mark.phase === "cancelled" &&
							mark.newPid === stale.pid,
					),
				).toBeDefined();
				expect(() => process.kill(stale.pid, 0)).toThrow();
			},
			{ timeout: 10_000 },
		);
		const replacement = await upgraded(harness, sessionId, old.pid);
		expect(replacement.pid).not.toBe(stale.pid);
		const warmed = queryFor(harness, replacement.pid);
		const desiredControls = {
			model: modelId,
			effort: "high",
			permissionMode: "bypassPermissions",
		};
		expect(warmed.options).toMatchObject(desiredControls);
		expect(
			sdkProof(harness).filter(
				(mark) =>
					mark.kind === "runner-upgrade" &&
					mark.phase === "switched" &&
					mark.newPid === stale.pid,
			),
		).toEqual([]);
		expect(
			sdkProof(harness).filter(
				(mark) => mark.kind === "enqueue" && mark.queryId === stale.queryId,
			),
		).toEqual([]);
		const queryCount = sdkProof(harness).filter(
			(mark) => mark.kind === "query",
		).length;
		expect(queryCount).toBe(3);
		const boundary = "merge-controls-retry-boundary";
		expect((await browser.send(sessionId, boundary)).chunks).toEqual(
			responseChunks(boundary),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === boundary,
			),
		).toMatchObject({ queryId: warmed.queryId, liveOptions: desiredControls });
		const after = "merge-controls-actual-warm-send";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: warmed.queryId, liveOptions: desiredControls });
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(queryCount);
		await completed(harness, sessionId, [before, boundary, after]);
		details["discardedCandidate"] = stale;
		details["desiredControls"] = desiredControls;
		details["actualWarmedQuery"] = warmed;
		details["queryCountAfterActualSend"] = queryCount;
		details["replacement"] = replacement;
	}, 40_000);

	it("review regression: releases the retired runner's sink without clearing its replacement", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-sink-cleanup", { upgradeSinkProof: true });
		const sessionId = await initial.createSession(
			"Retired runner sink cleanup",
		);
		details["sessionId"] = sessionId;
		const prompt = "upgrade-long-turn";
		const pending = initial.send(sessionId, prompt).catch(() => undefined);
		await initial.waitFor((message) => message["type"] === "delta");
		const old = runnerFor(harness, sessionId);
		await harness.kill();
		await pending;
		const recoveryCursor = harness.marks.length;
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const done = browser.waitFor(
			(message) =>
				message["type"] === "done" && message["sessionId"] === sessionId,
		);
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await done)["code"]).toBe(0);
		await vi.waitFor(
			() =>
				expect(
					harness.marks
						.slice(recoveryCursor)
						.some(
							(mark) =>
								mark.kind === "runtime-sink" &&
								mark.phase === "allocated" &&
								mark.sessionId === sessionId,
						),
				).toBe(true),
			{ timeout: 5000 },
		);
		const allocated = harness.marks
			.slice(recoveryCursor)
			.find(
				(mark) =>
					mark.kind === "runtime-sink" &&
					mark.phase === "allocated" &&
					mark.sessionId === sessionId,
			);
		if (allocated?.kind !== "runtime-sink")
			throw new Error("Missing recovered sink allocation");
		const replacement = await upgraded(harness, sessionId, old.pid);
		await vi.waitFor(
			() =>
				expect(
					harness.marks
						.slice(recoveryCursor)
						.some(
							(mark) =>
								mark.kind === "runtime-sink" &&
								mark.phase === "released" &&
								mark.sinkId === allocated.sinkId &&
								mark.activeSinks === 0,
						),
				).toBe(true),
			{ timeout: 6000 },
		);
		const after = "review-send-after-sink-cleanup";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: queryFor(harness, replacement.pid).queryId });
		await completed(harness, sessionId, [prompt, after]);
		details["oldSink"] = allocated;
		details["sinkLifecycle"] = harness.marks
			.slice(recoveryCursor)
			.filter((mark) => mark.kind === "runtime-sink");
		details["replacement"] = replacement;
	}, 40_000);

	it("review regression: reuses the warmed replacement after live model effort and permission changes", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-live-settings");
		const sessionId = await initial.createSession(
			"Live settings survive runner upgrade",
		);
		details["sessionId"] = sessionId;
		const before = "review-before-live-settings";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const originalQuery = queryFor(harness, old.pid);
		const modelId =
			originalQuery.options.model === "claude-opus-4"
				? "claude-sonnet-4"
				: "claude-opus-4";
		const payload = {
			projectSlug: "process-test",
			sessionId,
			originId: initial.originId,
		};
		await Effect.runPromise(
			initial.rpc.SwitchModel({ ...payload, providerId: "claude", modelId }),
		);
		await Effect.runPromise(
			initial.rpc.SwitchVariant({ ...payload, variant: "high" }),
		);
		await Effect.runPromise(
			initial.rpc.SwitchPermissionMode({ ...payload, mode: "full" }),
		);
		const changed = "review-live-settings-applied";
		expect((await initial.send(sessionId, changed)).chunks).toEqual(
			responseChunks(changed),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === changed,
			),
		).toMatchObject({
			queryId: originalQuery.queryId,
			liveOptions: {
				model: modelId,
				effort: "high",
				permissionMode: "bypassPermissions",
			},
		});
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		await harness.kill();
		await harness.restart({
			buildId: NEW_BUILD,
			queryInitializationDelayMs: 1000,
		});
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const warmQuery = queryFor(harness, replacement.pid);
		expect(warmQuery.options).toMatchObject({
			model: modelId,
			effort: "high",
			permissionMode: "bypassPermissions",
		});
		const queriesBeforeSend = sdkProof(harness).filter(
			(mark) => mark.kind === "query",
		);
		expect(queriesBeforeSend).toHaveLength(2);
		const replacementPayload = {
			projectSlug: "process-test",
			sessionId,
			originId: browser.originId,
		};
		// Model and variant selections are ephemeral server state. Restore them
		// before the first send, while no live context can change the warmed query.
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				...replacementPayload,
				providerId: "claude",
				modelId,
			}),
		);
		await Effect.runPromise(
			browser.rpc.SwitchVariant({ ...replacementPayload, variant: "high" }),
		);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(queriesBeforeSend.length);
		const after = "review-live-settings-after-upgrade";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(queriesBeforeSend.length);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({
			queryId: warmQuery.queryId,
			liveOptions: {
				model: modelId,
				effort: "high",
				permissionMode: "bypassPermissions",
			},
		});
		details["queryCountAfterFirstReplacementSend"] = sdkProof(harness).filter(
			(mark) => mark.kind === "query",
		).length;
		const pickerModelId =
			modelId === "claude-opus-4" ? "claude-sonnet-4" : "claude-opus-4";
		await Effect.runPromise(
			browser.rpc.SwitchModel({
				...replacementPayload,
				providerId: "claude",
				modelId: pickerModelId,
			}),
		);
		await Effect.runPromise(
			browser.rpc.SwitchVariant({ ...replacementPayload, variant: "medium" }),
		);
		await Effect.runPromise(
			browser.rpc.SwitchPermissionMode({ ...replacementPayload, mode: "ask" }),
		);
		const pickerChanged = "review-picker-change-after-upgrade";
		expect((await browser.send(sessionId, pickerChanged)).chunks).toEqual(
			responseChunks(pickerChanged),
		);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(queriesBeforeSend.length);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === pickerChanged,
			),
		).toMatchObject({
			queryId: warmQuery.queryId,
			liveOptions: {
				model: pickerModelId,
				effort: "medium",
				permissionMode: "default",
			},
		});
		await completed(harness, sessionId, [
			before,
			changed,
			after,
			pickerChanged,
		]);
		details["desiredLiveOptions"] = {
			model: modelId,
			effort: "high",
			permissionMode: "bypassPermissions",
		};
		details["laterPickerOptions"] = {
			model: pickerModelId,
			effort: "medium",
			permissionMode: "default",
		};
		details["warmedReplacementQuery"] = warmQuery;
		details["queryCountBeforeFirstReplacementSend"] = queriesBeforeSend.length;
		details["queryCountAfterLaterPickerSend"] = sdkProof(harness).filter(
			(mark) => mark.kind === "query",
		).length;
	}, 40_000);

	it("review regression: preserves effective hooks and auto compact settings after all file tiers change", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-file-settings");
		mkdirSync(join(harness.projectDir, ".claude"), { recursive: true });
		const user = join(harness.root, "claude/settings.json");
		const project = join(harness.projectDir, ".claude/settings.json");
		const local = join(harness.projectDir, ".claude/settings.local.json");
		writeFileSync(
			user,
			JSON.stringify({
				autoCompactEnabled: true,
				disableAllHooks: true,
				attribution: { commit: "frozen-user-commit", pr: "frozen-user-pr" },
				hooks: {
					SessionStart: [
						{
							hooks: [{ type: "command", command: "printf frozen-user-hook" }],
						},
					],
				},
			}),
		);
		writeFileSync(
			project,
			JSON.stringify({
				autoCompactEnabled: false,
				attribution: { commit: "frozen-project-commit" },
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{ type: "command", command: "printf frozen-project-hook" },
							],
						},
					],
				},
			}),
		);
		writeFileSync(
			local,
			JSON.stringify({
				autoCompactEnabled: false,
				attribution: { pr: "frozen-local-pr" },
				hooks: {
					Stop: [
						{
							hooks: [{ type: "command", command: "printf frozen-local-hook" }],
						},
					],
				},
			}),
		);
		await Effect.runPromise(
			initial.rpc.SetClaudeSettings({
				projectSlug: "process-test",
				overrides: { disableAllHooks: false },
				originId: initial.originId,
			}),
		);
		const sessionId = await initial.createSession(
			"File settings stay fixed across upgrade",
		);
		details["sessionId"] = sessionId;
		const before = "upgrade-long-turn";
		const firstTurn = initial.send(sessionId, before).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness)
						.filter((mark) => mark.kind === "emit" && mark.prompt === before)
						.map((mark) => (mark.kind === "emit" ? mark.text : undefined)),
				).toEqual([responseChunks(before)[0]]),
			{ timeout: 10_000 },
		);
		expect(
			persisted(harness, sessionId).events.filter(
				(event) => event.type === "turn.completed",
			),
		).toEqual([]);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		expect(JSON.parse(oldQuery.effectiveSettingsJson)).toEqual({
			autoCompactEnabled: false,
			disableAllHooks: false,
			showThinkingSummaries: true,
			attribution: { commit: "frozen-project-commit", pr: "frozen-local-pr" },
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "printf frozen-user-hook" }] },
				],
				PreToolUse: [
					{
						hooks: [{ type: "command", command: "printf frozen-project-hook" }],
					},
				],
				Stop: [
					{ hooks: [{ type: "command", command: "printf frozen-local-hook" }] },
				],
			},
		});
		const transcriptDir = join(
			harness.root,
			"claude/projects",
			harness.projectDir.replaceAll(/[\\/]/g, "-"),
		);
		mkdirSync(transcriptDir, { recursive: true });
		const transcript = join(transcriptDir, `${oldQuery.sessionId}.jsonl`);
		writeFileSync(
			transcript,
			`${JSON.stringify({
				type: "assistant",
				sessionId: oldQuery.sessionId,
				uuid: "review-settings-transcript",
				parentUuid: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Ordinary SDK session history" }],
				},
			})}\n`,
		);
		expect(existsSync(join(transcriptDir, "memory"))).toBe(false);
		details["ordinarySdkTranscript"] = transcript;
		writeFileSync(
			user,
			JSON.stringify({
				autoCompactEnabled: true,
				disableAllHooks: true,
				attribution: { commit: "mutated-user-commit", pr: "mutated-user-pr" },
				hooks: {
					SessionStart: [
						{
							hooks: [{ type: "command", command: "printf mutated-user-hook" }],
						},
					],
				},
			}),
		);
		writeFileSync(
			project,
			JSON.stringify({
				autoCompactEnabled: true,
				attribution: { commit: "mutated-project-commit" },
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{ type: "command", command: "printf mutated-project-hook" },
							],
						},
					],
				},
			}),
		);
		writeFileSync(
			local,
			JSON.stringify({
				autoCompactEnabled: true,
				attribution: { pr: "mutated-local-pr" },
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: "printf mutated-local-hook" },
							],
						},
					],
				},
			}),
		);
		details["settingsMutatedDuringForegroundTurn"] = true;
		writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
		expect((await firstTurn)?.chunks).toEqual(responseChunks(before));
		await completed(harness, sessionId, [before]);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		const replacement = await upgraded(harness, sessionId, old.pid);
		const newQuery = queryFor(harness, replacement.pid);
		expect(newQuery.effectiveSettingsJson).toBe(oldQuery.effectiveSettingsJson);
		const after = "review-after-file-settings-change";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(2);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: newQuery.queryId });
		await completed(harness, sessionId, [before, after]);
		details["oldEffectiveSettingsJson"] = oldQuery.effectiveSettingsJson;
		details["newEffectiveSettingsJson"] = newQuery.effectiveSettingsJson;
		details["mutatedFiles"] = [user, project, local].map((path) => ({
			path,
			contents: JSON.parse(readFileSync(path, "utf8")) as unknown,
		}));
		details["replacement"] = replacement;
	}, 40_000);

	it("review regression: defers changed ordinary settings when descendant instructions would be displaced", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-descendant-instructions");
		const descendantDir = join(harness.projectDir, "packages/fixture");
		mkdirSync(descendantDir, { recursive: true });
		const instructions = join(descendantDir, "CLAUDE.md");
		writeFileSync(instructions, "Use the fixture package conventions.\n");
		const settings = join(harness.root, "claude/settings.json");
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: false }));
		const sessionId = await initial.createSession(
			"Discovered instructions preserve native sources",
		);
		details["sessionId"] = sessionId;
		const before = "review-before-descendant-settings-change";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		expect(JSON.parse(oldQuery.effectiveSettingsJson)).toMatchObject({
			autoCompactEnabled: false,
		});
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: true }));
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "runner-upgrade" &&
							mark.phase === "failed" &&
							mark.oldPid === old.pid,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "runner-upgrade" &&
					mark.phase === "switched" &&
					mark.oldPid === old.pid,
			),
		).toBe(false);
		const after = "review-old-runner-with-descendant-instructions";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: oldQuery.queryId });
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		await completed(harness, sessionId, [before, after]);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "done" && message["code"] === 1,
			),
		).toEqual([]);
		details["oldRunner"] = old;
		details["descendantInstructions"] = {
			path: instructions,
			contents: readFileSync(instructions, "utf8"),
		};
		details["changedOrdinarySettings"] = JSON.parse(
			readFileSync(settings, "utf8"),
		) as unknown;
		details["upgradeDeferred"] = true;
	}, 40_000);

	it("review regression: defers changed trust-sensitive file settings while the old runner serves", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-trust-settings");
		mkdirSync(join(harness.projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(harness.root, "claude/settings.json"),
			JSON.stringify({ permissions: { defaultMode: "default" } }),
		);
		const sessionId = await initial.createSession(
			"Trust settings preserve native sources",
		);
		details["sessionId"] = sessionId;
		const before = "review-before-trust-settings-change";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		const changed = join(harness.projectDir, ".claude/settings.json");
		writeFileSync(
			changed,
			JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
		);
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "runner-upgrade" &&
							mark.phase === "failed" &&
							mark.oldPid === old.pid,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).some(
				(mark) =>
					mark.kind === "runner-upgrade" &&
					mark.phase === "switched" &&
					mark.oldPid === old.pid,
			),
		).toBe(false);
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		const after = "review-old-runner-after-trust-change";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: oldQuery.queryId });
		await completed(harness, sessionId, [before, after]);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "done" && message["code"] === 1,
			),
		).toEqual([]);
		details["oldRunner"] = old;
		details["changedTrustSettings"] = JSON.parse(
			readFileSync(changed, "utf8"),
		) as unknown;
		details["upgradeDeferred"] = true;
	}, 40_000);

	it("review regression: defers changed ordinary settings when legacy MCP configuration would be displaced", async () => {
		const {
			harness,
			details,
			browser: initial,
		} = await start("review-legacy-mcp");
		const legacyConfig = join(harness.root, "claude/.config.json");
		writeFileSync(
			legacyConfig,
			JSON.stringify({
				mcpServers: {
					fixture: { command: "fake-claude-mcp", args: ["--fixture"] },
				},
			}),
		);
		const settings = join(harness.root, "claude/settings.json");
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: false }));
		const sessionId = await initial.createSession(
			"Legacy MCP configuration preserves native sources",
		);
		details["sessionId"] = sessionId;
		const before = "review-before-legacy-mcp-settings-change";
		await initial.send(sessionId, before);
		const old = runnerFor(harness, sessionId);
		const oldQuery = queryFor(harness, old.pid);
		expect(JSON.parse(oldQuery.effectiveSettingsJson)).toMatchObject({
			autoCompactEnabled: false,
		});
		writeFileSync(settings, JSON.stringify({ autoCompactEnabled: true }));
		await harness.kill();
		await harness.restart({ buildId: NEW_BUILD });
		const browser = await harness.connect(sessionId);
		await vi.waitFor(
			() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "runner-upgrade" &&
							mark.phase === "failed" &&
							mark.oldPid === old.pid,
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		expect(() => process.kill(old.pid, 0)).not.toThrow();
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		const after = "review-old-runner-with-legacy-mcp";
		expect((await browser.send(sessionId, after)).chunks).toEqual(
			responseChunks(after),
		);
		expect(
			sdkProof(harness).find(
				(mark) => mark.kind === "enqueue" && mark.prompt === after,
			),
		).toMatchObject({ queryId: oldQuery.queryId });
		expect(
			sdkProof(harness).filter((mark) => mark.kind === "query"),
		).toHaveLength(1);
		await completed(harness, sessionId, [before, after]);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "done" && message["code"] === 1,
			),
		).toEqual([]);
		details["oldRunner"] = old;
		details["legacyMcpConfiguration"] = {
			path: legacyConfig,
			contents: JSON.parse(readFileSync(legacyConfig, "utf8")) as unknown,
		};
		details["changedOrdinarySettings"] = JSON.parse(
			readFileSync(settings, "utf8"),
		) as unknown;
		details["upgradeDeferred"] = true;
	}, 40_000);
});
