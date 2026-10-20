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

// A Stop may outlive the five-second send barrier. Its confirmation belongs
// to the original claimed cohort, never a returned input's fresh attempt.
it("a slow Stop leaves the concurrently resumed fresh attempt running", async () => {
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
		await vi.waitFor(
			() =>
				expect(
					relay.mock.diagnostics.some(
						(entry) =>
							entry.event === "request" &&
							entry.detail?.startsWith(`POST /session/${sessionId}/abort`),
					),
				).toBe(true),
			{ timeout: 5_000 },
		);
		expect(
			db
				.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
				.get(inputId),
		).toEqual({ state: "queued" });
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
		releaseAbort();
		await stopping;
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
		const afterAbort = {
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
					case: "slow-stop-resume-fresh-cohort",
					outcome: "passed",
					afterAbort,
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
		releaseAbort();
		await stopping?.catch(() => {});
		db.close();
		await relay.stop();
	}
}, 30_000);
