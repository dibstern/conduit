import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	createReplayHarness,
	type ReplayHarness,
} from "../../e2e/helpers/e2e-harness.js";

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
const evidenceDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";

function rpc<A, E>(
	harness: ReplayHarness,
	call: (client: Client) => Effect.Effect<A, E>,
) {
	return Effect.runPromise(
		Effect.scoped(Effect.flatMap(makeClient, call)).pipe(
			Effect.provide(RpcClient.layerProtocolSocket()),
			Effect.provide(
				Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
			),
			Effect.provide(Socket.layerWebSocketConstructorGlobal),
			Effect.provide(RpcSerialization.layerJson),
		),
	);
}

function ledger(harness: ReplayHarness) {
	const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
	try {
		return {
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs ORDER BY requested_at, rowid",
				)
				.all() as { id: string; status: string }[],
			turns: db
				.prepare("SELECT state, run_id FROM turns ORDER BY requested_at, rowid")
				.all() as { state: string; run_id: string | null }[],
			commands: db
				.prepare(
					"SELECT command_id, status FROM provider_command_outbox WHERE effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all() as { command_id: string; status: string }[],
			queued: db
				.prepare(
					"SELECT input_id FROM pending_inputs WHERE state = 'queued' ORDER BY admitted_at, rowid",
				)
				.all() as { input_id: string }[],
			ends: db
				.prepare(
					"SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE type IN ('turn.interrupted', 'turn.error', 'turn.completed') ORDER BY sequence",
				)
				.all() as { type: string; run_id: string | null }[],
		};
	} finally {
		db.close();
	}
}

// Failure modes: cleanup loses the accepted run, an early interruption leaves
// its reservation busy, restart drains a paused queue, or slash interrupts twice.
describe("Claude run ownership through the browser's in-process replay relay", () => {
	let harness: ReplayHarness | undefined;
	const cases: {
		case: string;
		outcome: string;
		turns?: string[];
		ownedEnds?: number;
	}[] = [];

	afterEach(async () => {
		try {
			await harness?.stop();
		} finally {
			harness = undefined;
			mkdirSync(evidenceDirectory, { recursive: true });
			writeFileSync(
				`${evidenceDirectory}/82tn24-round3-in-process.json`,
				`${JSON.stringify({ cases }, null, 2)}\n`,
			);
		}
	});

	for (const status of ["pending", "running"] as const) {
		it(`refuses a model mismatch while Alpha's first run is ${status}`, async () => {
			const proof: (typeof cases)[number] = {
				case: `first-${status}-model-mismatch`,
				outcome: "failed",
			};
			cases.push(proof);
			harness = await createReplayHarness("chat-streaming", {
				claudeReplay: {
					turns: ["pong-thinking-text-turn"],
					holdBefore: { turn: 1, message: status === "pending" ? 5 : 6 },
					models: [
						{
							id: "claude-fable-5",
							name: "Claude Fable 5",
							providerId: "claude",
						},
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							providerId: "claude",
						},
					],
				},
			});
			const fixture = harness;
			const sessionId = decodeURIComponent(
				fixture.projectUrl.slice("/s/".length),
			);
			const alpha = randomUUID();
			const bravo = randomUUID();
			expect(
				await rpc(fixture, (client) =>
					client["input.submit"]({
						sessionId,
						inputId: alpha,
						text: "Alpha",
						delivery: "queue",
					}),
				),
			).toMatchObject({ ok: true });
			await fixture.claudeReplayer?.held();
			expect(ledger(fixture).runs.map((run) => run.status)).toEqual([status]);
			await rpc(fixture, (client) =>
				client.SwitchModel({
					sessionId,
					providerId: "claude",
					modelId: "claude-sonnet-5",
				}),
			);
			expect(
				await rpc(fixture, (client) =>
					client["input.submit"]({
						sessionId,
						inputId: bravo,
						text: "Bravo",
						delivery: "steer",
					}),
				),
			).toEqual({ ok: false, reason: "model_differs" });
			expect(
				ledger(fixture).commands.map((command) => command.command_id),
			).toEqual([alpha]);
			fixture.claudeReplayer?.release();
			await vi.waitFor(() =>
				expect(ledger(fixture).runs.map((run) => run.status)).toEqual([
					"completed",
				]),
			);
			fixture.claudeReplayer?.assertComplete();
			proof.turns = ledger(fixture).turns.map((turn) => turn.state);
			proof.ownedEnds = ledger(fixture).ends.length;
			proof.outcome = "passed";
		}, 60_000);
	}

	for (const timing of ["accepted", "queued"] as const) {
		for (const action of ["stop", "restart", "slash"] as const) {
			it(`${timing} ${action} closes only its own run and leaves subsequent inputs deliverable`, async () => {
				const proof: (typeof cases)[number] = {
					case: `${timing}-${action}`,
					outcome: "failed",
				};
				cases.push(proof);
				harness = await createReplayHarness("chat-streaming", {
					claudeReplay: {
						turns: [
							"pong-thinking-text-turn",
							"pong-thinking-text-turn",
							...(action === "stop"
								? ["pong-thinking-text-turn" as const]
								: []),
						],
						delayMs: 300,
						...(action === "slash"
							? {
									holdBefore: {
										turn: 1,
										message: timing === "accepted" ? 6 : 5,
									},
								}
							: {}),
					},
				});
				const fixture = harness;
				const sessionId = decodeURIComponent(
					fixture.projectUrl.slice("/s/".length),
				);
				const a = randomUUID();
				const b = randomUUID();
				const c = randomUUID();
				const submit = (
					inputId: string,
					text: string,
					delivery: "queue" | "steer" = "queue",
				) =>
					rpc(fixture, (client) =>
						client["input.submit"]({
							sessionId,
							inputId,
							text,
							delivery,
							originId: "run-ownership-replay",
						}),
					);
				expect(await submit(a, "Alpha")).toMatchObject({ ok: true });
				await vi.waitFor(
					() =>
						expect(
							timing === "accepted"
								? ledger(fixture).runs.some((run) => run.status === "running")
								: ledger(fixture).commands.some(
										(command) => command.status === "running",
									),
						).toBe(true),
					{ timeout: 15_000 },
				);
				if (action === "slash") {
					expect(await submit(b, "/compact", "steer")).toMatchObject({
						ok: true,
					});
				} else {
					expect(await submit(b, "Bravo")).toMatchObject({ ok: true });
					if (action === "stop")
						expect(await submit(c, "Charlie")).toMatchObject({ ok: true });
					if (action === "restart") await fixture.restart();
					else
						expect(
							await rpc(fixture, (client) =>
								client.CancelSession({ sessionId, commandId: randomUUID() }),
							),
						).toMatchObject({ ok: true });
				}
				await vi.waitFor(
					() => {
						const state = ledger(fixture);
						expect(["interrupted", "error"]).toContain(state.turns[0]?.state);
						expect(
							state.ends.filter((event) => event.type === "turn.interrupted"),
						).toHaveLength(1);
						if (action !== "slash") {
							expect(
								state.commands.map((command) => command.command_id),
							).toEqual([a]);
							expect(state.queued.map((input) => input.input_id)).toEqual(
								action === "stop" ? [b, c] : [b],
							);
						}
					},
					{ timeout: 15_000 },
				);
				if (action !== "slash") {
					expect(
						await rpc(fixture, (client) =>
							client["input.sendNow"]({ sessionId, inputId: b }),
						),
					).toMatchObject({ ok: true });
				}
				await vi.waitFor(
					() => {
						const state = ledger(fixture);
						expect(state.turns.map((turn) => turn.state)).toEqual([
							"interrupted",
							"completed",
							...(action === "stop" ? ["completed"] : []),
						]);
						expect(state.queued).toEqual([]);
						expect(
							state.runs.every(
								(run) => !["pending", "running"].includes(run.status),
							),
						).toBe(true);
					},
					{ timeout: 30_000 },
				);
				const final = ledger(fixture);
				expect(new Set(final.turns.map((turn) => turn.run_id)).size).toBe(
					final.turns.length,
				);
				expect(final.ends.every((event) => event.run_id !== null)).toBe(true);
				proof.turns = final.turns.map((turn) => turn.state);
				proof.ownedEnds = final.ends.length;
				proof.outcome = "passed";
			}, 90_000);
		}
	}
});
