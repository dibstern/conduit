import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface OutboxState {
	status: string;
	attempt_count: number;
	next_attempt_at: number | null;
}

const artifactDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ??
	join(tmpdir(), "conduit-integration-artifacts");

// Failure modes: no startup drain, an early retry, duplicate execution while
// immediate dispatch overlaps polling, a store error kills or hot-loops the
// schedule, or shutdown leaves a background fiber accessing a closed store.
describe("provider command outbox drain", () => {
	let harness: ProcessHarness | undefined;
	const cases: Array<Record<string, unknown>> = [];

	function state(fixture: ProcessHarness, inputId: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare(
					"SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(inputId) as OutboxState | undefined;
		} finally {
			db.close();
		}
	}

	function dispatches(fixture: ProcessHarness, prompt: string) {
		const path = join(fixture.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { kind: string; request?: string })
					.filter((mark) => mark.kind === "enqueue" && mark.request === prompt)
					.length
			: 0;
	}

	async function leavePending(
		prefix = "outbox",
		options: {
			stop?: boolean;
			extraSession?: boolean;
			holdClaim?: boolean;
		} = {},
	) {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
		});
		harness = fixture;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Outbox restart");
		const extraSessionId = options.extraSession
			? await browser.createSession("Independent outbox session")
			: undefined;
		const inputId = randomUUID();
		const prompt = `${prefix}-${inputId}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			// Pause after the daemon's durable commit, before a provider can run.
			// Killing this process leaves its real receipt and payload pending.
			db.exec(`CREATE TRIGGER hold_outbox_claim BEFORE UPDATE OF status
				ON provider_command_outbox WHEN NEW.command_id = '${inputId}'
				AND NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`);
		} finally {
			db.close();
		}
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		await vi.waitFor(() =>
			expect(state(fixture, inputId)).toMatchObject({
				status: "pending",
				attempt_count: 0,
			}),
		);
		expect(dispatches(fixture, prompt)).toBe(0);
		if (options.stop !== false) await fixture.kill();
		const releaseClaim = () => {
			const stopped = new Database(fixture.daemonStorePath());
			try {
				stopped.exec("DROP TRIGGER hold_outbox_claim");
			} finally {
				stopped.close();
			}
		};
		if (!options.holdClaim) releaseClaim();
		return {
			fixture,
			sessionId,
			extraSessionId,
			inputId,
			prompt,
			releaseClaim,
		};
	}

	afterEach(async ({ task }) => {
		mkdirSync(artifactDirectory, { recursive: true });
		try {
			if (task.result?.errors?.length && harness) {
				writeFileSync(
					`/tmp/82tn24-outbox-drain-${cases.length}.log`,
					harness.logTail,
				);
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					writeFileSync(
						join(artifactDirectory, "review5-stop-ledger.json"),
						JSON.stringify(
							{
								runs: db.prepare("SELECT * FROM provider_runs").all(),
								outbox: db
									.prepare(
										"SELECT command_id, request_sequence, status, run_id, error_code, attempt_count FROM provider_command_outbox",
									)
									.all(),
								pending: db
									.prepare(
										"SELECT input_id, state, admitted_at FROM pending_inputs",
									)
									.all(),
								events: db
									.prepare(
										"SELECT sequence, type, json_extract(data, '$.inputId') AS input, json_extract(metadata, '$.runId') AS run, json_extract(data, '$.reason') AS reason FROM events ORDER BY sequence DESC LIMIT 45",
									)
									.all(),
								sdk: existsSync(join(harness.root, "sdk-proof.ndjson"))
									? readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
									: "",
								runnerLog: existsSync(join(harness.configDir, "runners.log"))
									? readFileSync(join(harness.configDir, "runners.log"), "utf8")
									: "",
							},
							null,
							2,
						),
					);
				} finally {
					db.close();
				}
			}
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			harness = undefined;
			writeFileSync(
				join(artifactDirectory, "review5-provider-command-outbox-drain.json"),
				`${JSON.stringify(cases, null, 2)}\n`,
			);
		}
	});

	it("dispatches a previous process's pending row once immediately after recovery", async () => {
		const proof = {
			case: "pending-after-restart",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		// A long interval distinguishes the startup drain from the periodic one.
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "60000" },
		});
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		// Restart again: completed work must never be dispatched a second time.
		await fixture.signal("SIGINT");
		await fixture.restart();
		expect(state(fixture, inputId)?.attempt_count).toBe(1);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("waits until a retryable row's next_attempt_at before dispatching once", async () => {
		const proof = {
			case: "retry-after-deadline",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(`UPDATE provider_command_outbox SET status = 'retryable_failed',
				attempt_count = 1, next_attempt_at = ? WHERE command_id = ?`).run(
				Date.now() + 60_000,
				inputId,
			);
		} finally {
			db.close();
		}
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "50" },
		});
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(dispatches(fixture, prompt)).toBe(0);
		expect(state(fixture, inputId)?.status).toBe("retryable_failed");
		// Arm a near deadline after startup, avoiding machine-dependent startup time.
		const nextAttemptAt = Date.now() + 500;
		const live = new Database(fixture.daemonStorePath());
		try {
			live
				.prepare(
					"UPDATE provider_command_outbox SET next_attempt_at = ? WHERE command_id = ?",
				)
				.run(nextAttemptAt, inputId);
		} finally {
			live.close();
		}
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(dispatches(fixture, prompt)).toBe(0);
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		expect(Date.now()).toBeGreaterThanOrEqual(nextAttemptAt);
		await new Promise<void>((done) => setTimeout(done, 200));
		expect(state(fixture, inputId)?.attempt_count).toBe(2);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("logs a drain store failure and keeps polling after it clears", async () => {
		const proof = {
			case: "drain-failure-survives",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, inputId, prompt } = await leavePending();
		const db = new Database(fixture.daemonStorePath());
		try {
			db.exec(`CREATE TRIGGER fail_outbox_claim BEFORE UPDATE OF status
				ON provider_command_outbox WHEN NEW.command_id = '${inputId}'
				AND NEW.status = 'running'
				BEGIN SELECT RAISE(FAIL, 'injected outbox store failure'); END`);
		} finally {
			db.close();
		}
		const logFile = join(fixture.root, "outbox-drain.log");
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "50" },
			logFile,
		});
		await vi.waitFor(() =>
			expect(readFileSync(logFile, "utf8")).toContain(
				"Provider command outbox drain failed",
			),
		);
		expect(dispatches(fixture, prompt)).toBe(0);
		const live = new Database(fixture.daemonStorePath());
		try {
			live.exec("DROP TRIGGER fail_outbox_claim");
		} finally {
			live.close();
		}
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("routes a restarted pending turn's approval through the relay", async () => {
		const proof = {
			case: "restarted-approval",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, sessionId, inputId, prompt } =
			await leavePending("approval-outbox");
		await fixture.restart();
		const browser = await fixture.connect(sessionId);
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		await browser.answerApproval(approval, "allow");
		await vi.waitFor(
			() => expect(state(fixture, inputId)?.status).toBe("completed"),
			{
				timeout: 10_000,
			},
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		proof.outcome = "passed";
	});

	it("Stop returns an unclaimed handoff to the paused queue; Resume sends it first and exactly once", async () => {
		const proof = {
			case: "stop-unclaimed-handoff",
			outcome: "failed",
			dispatches: 0,
		};
		cases.push(proof);
		const { fixture, sessionId, inputId, prompt, releaseClaim } =
			await leavePending("owned-outbox", { stop: false, holdClaim: true });
		const browser = await fixture.connect(sessionId);
		const later = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: later,
				delivery: "queue",
				text: `later-${later}`,
			}),
		);
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: randomUUID() }),
		);
		releaseClaim();
		const queue = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return db
					.prepare(
						"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at, rowid",
					)
					.all(sessionId);
			} finally {
				db.close();
			}
		};
		await vi.waitFor(() =>
			expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]),
		);
		expect(state(fixture, inputId)).toMatchObject({
			status: "failed",
			attempt_count: 0,
		});
		expect(dispatches(fixture, prompt)).toBe(0);
		// Let the original foreground receipt waiter finish before restarting.
		await new Promise<void>((done) => setTimeout(done, 1250));
		expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]);
		await fixture.kill();
		await fixture.restart();
		await new Promise<void>((done) => setTimeout(done, 1250));
		expect(queue()).toEqual([{ input_id: inputId }, { input_id: later }]);
		expect(dispatches(fixture, prompt)).toBe(0);
		await (await fixture.connect(sessionId)).sendNow(sessionId, inputId);
		await vi.waitFor(
			() => {
				expect(state(fixture, later)?.status).toBe("completed");
				expect(queue()).toEqual([]);
			},
			{ timeout: 10_000 },
		);
		proof.dispatches = dispatches(fixture, prompt);
		expect(proof.dispatches).toBe(1);
		expect(dispatches(fixture, `later-${later}`)).toBe(1);
		expect(
			readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; request?: string })
				.filter((mark) => mark.kind === "enqueue")
				.map((mark) => mark.request),
		).toEqual([prompt, `later-${later}`]);
		proof.outcome = "passed";
	}, 90_000);

	it("drains another session's newly due retry while preserving a held session's order", async () => {
		const proof = {
			case: "independent-session-drains",
			outcome: "failed",
			dispatches: [] as number[],
		};
		cases.push(proof);
		const { fixture, sessionId, extraSessionId, inputId, prompt } =
			await leavePending("approval-outbox", { extraSession: true });
		if (!extraSessionId) throw new Error("Missing second session");
		const secondId = randomUUID();
		const otherId = randomUUID();
		const secondPrompt = `ordered-outbox-${secondId}`;
		const otherPrompt = `independent-outbox-${otherId}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			const source = db
				.prepare(
					"SELECT payload_json FROM provider_command_outbox WHERE command_id = ?",
				)
				.get(inputId) as { payload_json: string };
			for (const [id, targetSession, text, retry] of [
				[secondId, sessionId, secondPrompt, false],
				[otherId, extraSessionId, otherPrompt, true],
			] as const) {
				const runId = randomUUID();
				db.prepare(`INSERT INTO provider_runs (id, session_id, status, requested_at)
					VALUES (?, ?, 'pending', ?)`).run(runId, targetSession, Date.now());
				db.prepare(`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, updated_at)
					SELECT ?, ?, 'side_effect_requested', created_at, command_type, project_key, updated_at
					FROM command_receipts WHERE command_id = ?`).run(
					id,
					targetSession,
					inputId,
				);
				db.prepare(`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json,
					status, attempt_count, next_attempt_at, requested_at, updated_at)
					SELECT (SELECT MAX(request_sequence) + 1 FROM provider_command_outbox), ?, project_key, ?, provider_id,
					effect_type, ?, ?, ?, ?, ?, requested_at, updated_at FROM provider_command_outbox WHERE command_id = ?`).run(
					id,
					targetSession,
					runId,
					JSON.stringify({
						...JSON.parse(source.payload_json),
						sessionId: targetSession,
						inputId: id,
						prompt: text,
					}),
					retry ? "retryable_failed" : "pending",
					retry ? 1 : 0,
					retry ? Date.now() + 60_000 : null,
					inputId,
				);
			}
		} finally {
			db.close();
		}
		await fixture.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "25" },
		});
		const browser = await fixture.connect(sessionId);
		const approval = await browser.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		expect(state(fixture, inputId)?.status).toBe("running");
		expect(dispatches(fixture, secondPrompt)).toBe(0);
		const live = new Database(fixture.daemonStorePath());
		try {
			live
				.prepare(
					"UPDATE provider_command_outbox SET next_attempt_at = ? WHERE command_id = ?",
				)
				.run(Date.now(), otherId);
		} finally {
			live.close();
		}
		await vi.waitFor(
			() => expect(state(fixture, otherId)?.status).toBe("completed"),
			{ timeout: 10_000 },
		);
		// Many scheduled ticks have overlapped the held turn by this point.
		expect(state(fixture, inputId)).toMatchObject({
			status: "running",
			attempt_count: 1,
		});
		expect(state(fixture, secondId)).toMatchObject({
			status: "pending",
			attempt_count: 0,
		});
		expect(state(fixture, otherId)?.attempt_count).toBe(2);
		await browser.answerApproval(approval, "allow");
		await vi.waitFor(
			() => {
				expect(state(fixture, inputId)?.status).toBe("completed");
				expect(state(fixture, secondId)).toMatchObject({
					status: "completed",
					attempt_count: 1,
				});
			},
			{ timeout: 10_000 },
		);
		proof.dispatches = [prompt, secondPrompt, otherPrompt].map((text) =>
			dispatches(fixture, text),
		);
		expect(proof.dispatches).toEqual([1, 1, 1]);
		proof.outcome = "passed";
	});

	it("dispatches once when immediate sends overlap the scheduled drain", async () => {
		const proof = {
			case: "immediate-dispatch-overlap",
			outcome: "failed",
			dispatches: [] as number[],
		};
		cases.push(proof);
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
		});
		await harness.restart({
			serviceEnvironment: { CONDUIT_OUTBOX_DRAIN_INTERVAL_MS: "1" },
		});
		const fixture = harness;
		const browser = await fixture.connect();
		const sends = await Promise.all(
			Array.from({ length: 3 }, async (_, index) => {
				const sessionId = await browser.createSession(
					`Outbox overlap ${index}`,
				);
				const inputId = randomUUID();
				const prompt = `outbox-overlap-${inputId}`;
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId,
						delivery: "queue",
						text: prompt,
					}),
				);
				return { inputId, prompt };
			}),
		);
		await vi.waitFor(
			() => {
				for (const { inputId } of sends) {
					expect(state(fixture, inputId)).toMatchObject({
						status: "completed",
						attempt_count: 1,
					});
				}
			},
			{ timeout: 15_000 },
		);
		proof.dispatches = sends.map(({ prompt }) => dispatches(fixture, prompt));
		expect(proof.dispatches).toEqual([1, 1, 1]);
		proof.outcome = "passed";
	});
});
