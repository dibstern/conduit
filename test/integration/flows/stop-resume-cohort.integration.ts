import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

const artifactDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ??
	join(tmpdir(), "conduit-integration-artifacts");

// An empty Stop returns unused reservations without aborting native work.
// Explicit resume gets a fresh attempt, never the stopped reservation.
it("an empty Stop resumes an unused input in a fresh cohort without native abort", async () => {
	const recording = loadOpenCodeRecording("chat-simple");
	const relay = await createRelayHarness(
		{
			...recording,
			interactions: recording.interactions.filter(
				(entry) => entry.kind === "rest",
			),
		},
		{ defaultModel: "opencode/big-pickle" },
	);
	const db = new Database(relay.eventsDbPath);
	try {
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = String(
			(
				await client.createSession("Slow Stop", {
					providerId: "opencode",
					model: {
						providerId: "opencode",
						modelId: "big-pickle",
						variant: "",
						contextWindow: "",
					},
				})
			)["id"],
		);
		await client.viewSession(sessionId);
		const inputId = randomUUID();
		db.exec(`CREATE TRIGGER hold_claim BEFORE UPDATE OF status
			ON provider_command_outbox WHEN NEW.command_id = '${inputId}'
			AND NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`);
		await client.sendMessage("Resume C after Stop", {
			commandId: inputId,
			sessionId,
		});
		const outbox = () =>
			db
				.prepare(
					"SELECT status, run_id, attempt_count FROM provider_command_outbox WHERE command_id = ? ORDER BY request_sequence DESC LIMIT 1",
				)
				.get(inputId) as {
				status: string;
				run_id: string;
				attempt_count: number;
			};
		await vi.waitFor(() =>
			expect(outbox()).toMatchObject({ status: "pending", attempt_count: 0 }),
		);
		const originalRun = outbox().run_id;
		await client.cancelSession(sessionId);
		expect(
			relay.mock.diagnostics.some(
				(entry) =>
					entry.event === "request" &&
					entry.detail?.startsWith(`POST /session/${sessionId}/abort`),
			),
		).toBe(false);
		expect(
			db
				.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
				.get(inputId),
		).toEqual({ state: "queued" });
		expect(outbox()).toMatchObject({
			run_id: originalRun,
			status: "failed",
			attempt_count: 0,
		});
		expect(
			relay.mock.requestBodies.filter((entry) =>
				entry.path.endsWith("/prompt_async"),
			),
		).toHaveLength(0);
		db.exec("DROP TRIGGER hold_claim");
		await client.rpcCall((rpc) =>
			rpc["input.sendNow"]({
				sessionId,
				originId: client.getClientId(),
				inputId,
			}),
		);
		await vi.waitFor(
			() =>
				expect(outbox()).toMatchObject({ status: "running", attempt_count: 1 }),
			{ timeout: 10_000 },
		);
		const freshRun = outbox().run_id;
		expect(freshRun).not.toBe(originalRun);
		await vi.waitFor(() =>
			expect(
				relay.mock.requestBodies.filter(
					(entry) => entry.path === `/session/${sessionId}/prompt_async`,
				),
			).toHaveLength(1),
		);
		const submitted = relay.mock.requestBodies.find(
			(entry) => entry.path === `/session/${sessionId}/prompt_async`,
		);
		const body = JSON.parse(submitted?.body ?? "null") as { messageID: string };
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "busy" } },
			},
			{
				type: "message.updated",
				properties: {
					info: {
						id: body.messageID,
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
						agent: "build",
						model: { providerID: "opencode", modelID: "big-pickle" },
					},
				},
			},
		]);
		const run = () =>
			db
				.prepare("SELECT status, started_at FROM provider_runs WHERE id = ?")
				.get(freshRun) as { status: string; started_at: number | null };
		await vi.waitFor(() =>
			expect(run()).toMatchObject({
				status: "running",
				started_at: expect.any(Number),
			}),
		);
		expect(run().status).toBe("running");
		expect(
			db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId),
		).toEqual({ status: "busy" });
		expect(outbox().status).toBe("running");
		expect(
			db
				.prepare("SELECT status FROM command_receipts WHERE command_id = ?")
				.get(inputId),
		).toEqual({ status: "side_effect_requested" });
		const afterStop = {
			run: run().status,
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId),
			accepted: run().started_at !== null,
			outbox: outbox().status,
			receipt: db
				.prepare("SELECT status FROM command_receipts WHERE command_id = ?")
				.get(inputId),
		};
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		await vi.waitFor(() => expect(run().status).toBe("completed"));
		expect(outbox().status).toBe("completed");
		expect(
			db
				.prepare("SELECT status FROM command_receipts WHERE command_id = ?")
				.get(inputId),
		).toEqual({ status: "side_effect_completed" });
		expect(
			db
				.prepare("SELECT status, started_at FROM provider_runs WHERE id = ?")
				.get(originalRun),
		).toEqual({ status: "interrupted", started_at: null });
		mkdirSync(artifactDirectory, { recursive: true });
		writeFileSync(
			join(artifactDirectory, "review6-v3-proof.json"),
			JSON.stringify(
				{
					case: "empty-stop-resume-fresh-cohort",
					outcome: "passed",
					afterStop,
					afterNativeEnd: {
						run: run().status,
						outbox: outbox().status,
						receipt: db
							.prepare(
								"SELECT status FROM command_receipts WHERE command_id = ?",
							)
							.get(inputId),
					},
					unusedReservation: db
						.prepare(
							"SELECT status, started_at FROM provider_runs WHERE id = ?",
						)
						.get(originalRun),
					modelRequests: relay.mock.requestBodies.filter((entry) =>
						entry.path.endsWith("/prompt_async"),
					).length,
				},
				null,
				2,
			),
		);
	} catch (error) {
		mkdirSync(artifactDirectory, { recursive: true });
		writeFileSync(
			join(artifactDirectory, "review6-v3-failure.json"),
			JSON.stringify(
				{
					runs: db
						.prepare(
							"SELECT id, session_id, status, started_at FROM provider_runs",
						)
						.all(),
					outbox: db
						.prepare(
							"SELECT command_id, run_id, status, attempt_count, error_code FROM provider_command_outbox",
						)
						.all(),
					pending: db
						.prepare("SELECT input_id, session_id, state FROM pending_inputs")
						.all(),
					events: db
						.prepare(
							"SELECT sequence, type, data FROM events ORDER BY sequence DESC LIMIT 20",
						)
						.all(),
					requests: relay.mock.requestBodies,
					diagnostics: relay.mock.diagnostics.slice(-15),
				},
				null,
				2,
			),
		);
		throw error;
	} finally {
		db.close();
		await relay.stop();
	}
}, 30_000);

it("a captured Stop holds a resumed input until native abort settles", async () => {
	const recording = loadOpenCodeRecording("chat-simple");
	const relay = await createRelayHarness(
		{
			...recording,
			interactions: recording.interactions.filter(
				(entry) => entry.kind === "rest",
			),
		},
		{ defaultModel: "opencode/big-pickle" },
	);
	const db = new Database(relay.eventsDbPath);
	let releaseAbort = () => {};
	let stopping: Promise<void> | undefined;
	let resuming: Promise<unknown> | undefined;
	try {
		const client = await relay.connectWsClient();
		await client.waitForInitialState();
		const sessionId = String(
			(await client.createSession("Captured Stop", { providerId: "opencode" }))[
				"id"
			],
		);
		await client.viewSession(sessionId);
		const activeInputId = randomUUID();
		await client.sendMessage("Captured owner", {
			sessionId,
			commandId: activeInputId,
		});
		await vi.waitFor(() =>
			expect(
				relay.mock.requestBodies.filter((entry) =>
					entry.path.endsWith("/prompt_async"),
				),
			).toHaveLength(1),
		);
		const active = db
			.prepare(
				"SELECT run_id FROM provider_command_outbox WHERE command_id = ?",
			)
			.get(activeInputId) as { run_id: string };
		const activeBody = JSON.parse(
			relay.mock.requestBodies.find((entry) =>
				entry.path.endsWith("/prompt_async"),
			)?.body ?? "null",
		) as { messageID: string };
		relay.mock.injectSSEEvents([
			{
				type: "message.updated",
				properties: {
					info: {
						id: activeBody.messageID,
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
						agent: "build",
						model: { providerID: "opencode", modelID: "big-pickle" },
					},
				},
			},
		]);
		await vi.waitFor(() =>
			expect(
				db
					.prepare("SELECT status FROM provider_runs WHERE id = ?")
					.get(active.run_id),
			).toEqual({ status: "running" }),
		);
		const inputId = randomUUID();
		await client.sendMessage("Resume after captured Stop", {
			sessionId,
			commandId: inputId,
		});
		relay.mock.abortHold = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		relay.mock.setExactResponse(
			"POST",
			`/session/${sessionId}/abort`,
			200,
			true,
		);
		stopping = client.cancelSession(sessionId);
		void stopping.catch(() => {});
		await vi.waitFor(() =>
			expect(
				relay.mock.diagnostics.some(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`POST /session/${sessionId}/abort`),
				),
			).toBe(true),
		);
		resuming = client.rpcCall((rpc) =>
			rpc["input.sendNow"]({
				sessionId,
				originId: client.getClientId(),
				inputId,
			}),
		);
		void resuming.catch(() => {});
		const whileHeld = {
			input: db
				.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
				.get(inputId),
			modelRequests: relay.mock.requestBodies.filter((entry) =>
				entry.path.endsWith("/prompt_async"),
			).length,
		};
		expect(whileHeld).toEqual({ input: { state: "queued" }, modelRequests: 1 });
		releaseAbort();
		relay.mock.injectSSEEvents([
			{
				type: "session.status",
				properties: { sessionID: sessionId, status: { type: "idle" } },
			},
		]);
		await stopping;
		await resuming;
		await vi.waitFor(
			() =>
				expect(
					relay.mock.requestBodies.filter((entry) =>
						entry.path.endsWith("/prompt_async"),
					),
				).toHaveLength(2),
			{ timeout: 10_000 },
		);
		const resumed = db
			.prepare(
				"SELECT run_id, status FROM provider_command_outbox WHERE command_id = ?",
			)
			.get(inputId) as { run_id: string; status: string };
		expect(resumed).toMatchObject({ status: "running" });
		expect(resumed.run_id).not.toBe(active.run_id);
		expect(
			db
				.prepare("SELECT status FROM provider_runs WHERE id = ?")
				.get(active.run_id),
		).toEqual({ status: "completed" });
		mkdirSync(artifactDirectory, { recursive: true });
		writeFileSync(
			join(artifactDirectory, "captured-stop-resume-proof.json"),
			JSON.stringify(
				{
					case: "captured-stop-holds-resume-until-native-abort",
					passed: true,
					sessionId,
					whileHeld,
					capturedRunId: active.run_id,
					resumed,
					nativeCalls: relay.mock.requestBodies,
				},
				null,
				2,
			),
		);
	} finally {
		releaseAbort();
		await stopping?.catch(() => {});
		await resuming?.catch(() => {});
		db.close();
		await relay.stop();
	}
}, 30_000);
