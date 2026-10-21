import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function ledger(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
			turns: db
				.prepare(
					"SELECT id, state, run_id FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{
				id: string;
				state: string;
				run_id: string | null;
			}>,
			queued: db
				.prepare(
					"SELECT input_id FROM pending_inputs WHERE session_id = ? AND state = 'queued' ORDER BY admitted_at, rowid",
				)
				.all(sessionId) as Array<{ input_id: string }>,
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{ command_id: string; status: string }>,
			interrupted: db
				.prepare(
					"SELECT json_extract(metadata, '$.runId') AS run_id, json_extract(data, '$.reason') AS reason FROM events WHERE session_id = ? AND type = 'turn.interrupted' ORDER BY sequence",
				)
				.all(sessionId) as Array<{
				run_id: string | null;
				reason: string | null;
			}>,
		};
	} finally {
		db.close();
	}
}

function completedHistory(sessionId: string, userId: string, created: number) {
	return [
		{
			info: {
				id: userId,
				sessionID: sessionId,
				role: "user",
				time: { created },
				agent: "build",
				model: { providerID: "fake", modelID: "fake-model" },
			},
			parts: [],
		},
		{
			info: {
				id: "msg_external_reply",
				sessionID: sessionId,
				role: "assistant",
				parentID: userId,
				time: { created: created + 1, completed: created + 2 },
				modelID: "fake-model",
				providerID: "fake",
				mode: "build",
				agent: "build",
				path: { cwd: "/", root: "/" },
				cost: 0,
				tokens: {
					input: 1,
					output: 1,
					reasoning: 0,
					cache: { read: 0, write: 0 },
				},
				finish: "stop",
			},
			parts: [],
		},
	];
}

// Failure modes: recovery only visits outbox sends and strands an observed run,
// uncertain status ends a live run, a finished observed run blocks queue resume,
// or an old startup probe ends a subsequently accepted run.
describe("observed OpenCode run ownership across daemon downtime", () => {
	let harness: ProcessHarness | undefined;
	const cases: Array<Record<string, unknown>> = [];
	let proof: Record<string, unknown>;

	afterEach(async ({ task }) => {
		try {
			if (task.result?.errors?.length && harness)
				writeFileSync(
					`/tmp/82tn24-review-${proof["case"]}.log`,
					harness.logTail,
				);
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn24-run-ownership-review.json",
				`${JSON.stringify({ cases }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	async function externalRun(queue = true) {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"External OpenCode run",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		const directory = realpathSync(fixture.projectDir);
		const userId = "msg_external_user";
		const created = Date.now();
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "busy" });
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: {
					info: {
						id: userId,
						sessionID: sessionId,
						role: "user",
						time: { created },
					},
				},
			},
		});
		await vi.waitFor(() =>
			expect(
				ledger(fixture, sessionId).turns.map(({ state }) => state),
			).toEqual(["running"]),
		);
		const inputId = randomUUID();
		if (queue)
			expect(
				await Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId,
						text: "after the external run",
						delivery: "queue",
					}),
				),
			).toEqual({ ok: true, sessionId, handedOff: false });
		const before = ledger(fixture, sessionId);
		expect(before.commands).toEqual([]);
		expect(before.queued).toEqual(queue ? [{ input_id: inputId }] : []);
		expect(before.runs.map(({ status }) => status)).toEqual(["running"]);
		const runId = before.runs[0]?.id;
		if (!runId) throw new Error("External acceptance has no owned run");
		proof["before"] = {
			run: "running",
			turn: "running",
			outboxCommands: 0,
			queuedInputs: Number(queue),
		};
		await fixture.kill();
		writeFileSync(
			join(fixture.configDir, "fake-opencode-history.json"),
			JSON.stringify({
				[sessionId]: completedHistory(sessionId, userId, created),
			}),
		);
		return { fixture, sessionId, directory, inputId, runId, userId };
	}

	async function expectRecovered(
		context: Awaited<ReturnType<typeof externalRun>>,
	) {
		const { fixture, sessionId, runId, inputId, userId } = context;
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.session.status).toBe("idle");
				expect(state.runs.find(({ id }) => id === runId)?.status).toBe(
					"interrupted",
				);
				expect(state.turns.find(({ id }) => id === userId)).toEqual({
					id: userId,
					state: "interrupted",
					run_id: runId,
				});
				expect(state.interrupted).toEqual([
					{
						run_id: runId,
						reason: "OpenCode session idle after daemon downtime",
					},
				]);
				expect(state.queued).toEqual([{ input_id: inputId }]);
				expect(state.commands).toEqual([]);
			},
			{ timeout: 15_000 },
		);
		const browser = await fixture.connect(sessionId);
		await browser.followSession(sessionId);
		await vi.waitFor(() =>
			expect(
				browser.frames.flatMap(({ message }) => {
					if (
						message["type"] !== "session_detail" ||
						message["sessionId"] !== sessionId
					)
						return [];
					const items =
						message["_tag"] === "snapshot"
							? message["rows"]
							: [message["item"]];
					return Array.isArray(items) ? items : [];
				}),
			).toContainEqual(
				expect.objectContaining({
					_tag: "inbox",
					inbox: expect.objectContaining({ paused: true }),
				}),
			),
		);
		proof["recovered"] = {
			run: "interrupted",
			turn: "interrupted",
			session: "idle",
			queuePaused: true,
			queuedInputs: 1,
			providerSends: 0,
		};
		await browser.sendNow(sessionId, inputId);
		expect(
			await Effect.runPromise(
				browser.rpc["input.sendNow"]({
					sessionId,
					inputId,
					originId: browser.originId,
				}),
			),
		).toMatchObject({ ok: false, reason: "already_started" });
		await vi.waitFor(
			() => {
				const state = ledger(fixture, sessionId);
				expect(state.queued).toEqual([]);
				expect(state.commands).toEqual([
					{ command_id: inputId, status: "completed" },
				]);
				expect(
					fixture
						.opencodeRequestBodies()
						.filter(
							({ method, path, body }) =>
								method === "POST" &&
								path === `/session/${sessionId}/prompt_async` &&
								body.includes("after the external run"),
						),
				).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);
		proof["after"] = {
			run: "interrupted",
			turn: "interrupted",
			ownedInterruptions: 1,
			interruptionReason: "OpenCode session idle after daemon downtime",
			queuedInputs: 0,
			providerSends: 1,
		};
	}

	it("interrupts an observed run missed during downtime and allows its queue to resume once", async () => {
		proof = { case: "observed-run-finished-offline", outcome: "failed" };
		cases.push(proof);
		const context = await externalRun();
		await context.fixture.setOpenCodeStatus(
			context.directory,
			context.sessionId,
			{
				type: "idle",
			},
		);
		await context.fixture.restart({ skipBrowserProbe: true });
		await expectRecovered(context);
	}, 60_000);

	it.each([
		"busy",
		"unavailable",
	] as const)("preserves an observed run while its restart probe is %s, then retries recovery", async (status) => {
		proof = { case: `observed-run-${status}-probe`, outcome: "failed" };
		cases.push(proof);
		const context = await externalRun();
		const { fixture, sessionId, directory, inputId, runId } = context;
		const failure = join(fixture.configDir, "fake-opencode-status-failure");
		if (status === "unavailable") writeFileSync(failure, "503");
		const beforeReads = fixture
			.opencodeRequests()
			.filter(({ url }) => url.split("?")[0] === "/session/status").length;
		await fixture.restart({ skipBrowserProbe: true });
		await fixture.connect();
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequests()
						.filter(({ url }) => url.split("?")[0] === "/session/status")
						.length,
				).toBeGreaterThan(beforeReads),
			{ timeout: 15_000 },
		);
		const held = ledger(fixture, sessionId);
		expect(held.runs).toEqual([{ id: runId, status: "running" }]);
		expect(held.turns.map(({ state }) => state)).toEqual(["running"]);
		expect(held.commands).toEqual([]);
		expect(held.queued).toEqual([{ input_id: inputId }]);
		proof["uncertainProbe"] = {
			run: "running",
			turn: "running",
			queuedInputs: 1,
			providerSends: 0,
		};
		await fixture.kill();
		rmSync(failure, { force: true });
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await fixture.restart({ skipBrowserProbe: true });
		await expectRecovered(context);
	}, 90_000);

	it("cannot apply an old startup idle probe to a newly accepted native run", async () => {
		proof = { case: "observed-run-stale-startup-probe", outcome: "failed" };
		cases.push(proof);
		const { fixture, sessionId, directory, runId } = await externalRun(false);
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		const heldBefore = fixture.opencodeHeldStatusReads().length;
		await fixture.holdOpenCodeStatusReads();
		const restarting = fixture.restart({
			skipBrowserProbe: true,
			startupTimeoutMs: 30_000,
		});
		// Attach a handler while the test drives SSE during pending startup.
		void restarting.catch(() => {});
		const nextUserId = "msg_new_external_user";
		let nextRunId: string | undefined;
		try {
			await vi.waitFor(
				() =>
					expect(fixture.opencodeHeldStatusReads().length).toBeGreaterThan(
						heldBefore,
					),
				{ timeout: 15_000 },
			);
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await vi.waitFor(() =>
				expect(
					ledger(fixture, sessionId).runs.find(({ id }) => id === runId)
						?.status,
				).toBe("completed"),
			);
			await fixture.emitOpenCodeEvent({
				directory,
				payload: {
					id: randomUUID(),
					type: "message.updated",
					properties: {
						info: {
							id: nextUserId,
							sessionID: sessionId,
							role: "user",
							time: { created: Date.now() },
						},
					},
				},
			});
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "busy" });
			await vi.waitFor(() => {
				const next = ledger(fixture, sessionId).turns.find(
					({ id }) => id === nextUserId,
				);
				expect(next?.state).toBe("running");
				expect(next?.run_id).toBeTruthy();
				expect(next?.run_id).not.toBe(runId);
				nextRunId = next?.run_id ?? undefined;
			});
		} catch (error) {
			const state = ledger(fixture, sessionId);
			proof["probeWaitFailure"] = {
				runs: state.runs.map(({ status }) => status),
				interruptions: state.interrupted.map(({ reason }) => reason),
				statusRequests: fixture
					.opencodeRequests()
					.filter(({ url }) => url.split("?")[0] === "/session/status").length,
			};
			throw error;
		} finally {
			await fixture.releaseOpenCodeStatusReads();
			await restarting;
		}
		const after = ledger(fixture, sessionId);
		expect(after.runs).toEqual([
			{ id: runId, status: "completed" },
			{ id: nextRunId, status: "running" },
		]);
		expect(after.turns.find(({ id }) => id === nextUserId)).toEqual({
			id: nextUserId,
			state: "running",
			run_id: nextRunId,
		});
		expect(after.interrupted).toEqual([]);
		expect(after.commands).toEqual([]);
		proof["afterStaleProbe"] = {
			originalRun: "completed",
			newRun: "running",
			newTurn: "running",
			ownedInterruptions: 0,
			providerSends: 0,
		};
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await vi.waitFor(() =>
			expect(
				ledger(fixture, sessionId).runs.find(({ id }) => id === nextRunId)
					?.status,
			).toBe("completed"),
		);
	}, 60_000);
});
