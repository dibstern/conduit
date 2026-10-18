// Failure cases: an authenticated browser removes or replaces the PIN without
// knowing it; restart overrides bypass SetPin; CLI PIN changes require a current
// PIN or leave browser sockets authorized; spoofed XFF prefixes evade lockout.
// Run after building: CONDUIT_TEST_DIST=dist pnpm exec vitest run
// --config vitest.integration.config.ts test/integration/daemon/pin-guard.test.ts
import { once } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Result as Either, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const DIST = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const LOG = join("test-results", "pin-guard", "run.log");

describe("browser PIN guard over the shared daemon RPC", () => {
	let harness: ProcessHarness | undefined;
	const sockets = new Set<WebSocket>();
	const record = (step: string, result: unknown) =>
		appendFileSync(LOG, `${JSON.stringify({ step, result })}\n`);

	beforeAll(() => {
		mkdirSync(join("test-results", "pin-guard"), { recursive: true });
		writeFileSync(LOG, "");
		record("start", { dist: DIST });
	});

	afterEach(async () => {
		for (const ws of sockets) ws.terminate();
		sockets.clear();
		await harness?.dispose();
		harness = undefined;
		record("cleanup", { ok: true });
	});

	async function start() {
		harness = ProcessHarness.create({ dist: DIST, foregroundCli: true });
		await harness.restart({ skipBrowserProbe: true, startupTimeoutMs: 60_000 });
		const generation = harness.generations[0];
		if (!generation) throw new Error("Isolated daemon generation is missing");
		record("daemon ready", { pid: generation.pid, port: generation.port });
		return {
			port: generation.port,
			socketPath: join(harness.configDir, "relay.sock"),
		};
	}

	function browserProtocol(port: number, headers: Record<string, string>) {
		return RpcClient.layerProtocolSocket({ retrySchedule: Schedule.stop }).pipe(
			Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
			Layer.provide(
				Layer.succeed(Socket.WebSocketConstructor)((url) => {
					const ws = new WebSocket(url, { headers });
					sockets.add(ws);
					ws.once("close", (code, reason) =>
						record("browser closed", { code, reason: reason.toString() }),
					);
					// ws implements EventTarget, but its type omits browser-only fields.
					return ws as unknown as globalThis.WebSocket;
				}),
			),
			Layer.provide(RpcSerialization.layerJson),
		);
	}

	it("requires the current PIN and revokes browser sockets after browser and CLI changes", async () => {
		const { port, socketPath } = await start();
		const set = await sendRpcRequest(socketPath, {
			_tag: "SetPin",
			pin: "1234",
		});
		record("CLI sets initial PIN without currentPin", set);
		expect(set).toEqual({ ok: true });

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcClient.make(WsRpcGroup);
					const missing = yield* Effect.result(client.SetPin({ pin: null }));
					record("browser missing currentPin", missing);
					expect(missing).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "SetPinRejected", reason: "wrong_pin" },
					});
					const wrong = yield* Effect.result(
						client.SetPin({ pin: null, currentPin: "9999" }),
					);
					record("browser wrong currentPin", wrong);
					expect(wrong).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "SetPinRejected", reason: "wrong_pin" },
					});
					const removed = yield* client.SetPin({
						pin: null,
						currentPin: "1234",
					});
					record("browser correct currentPin removes PIN", removed);
					expect(removed).toEqual({ ok: true });
				}),
			).pipe(
				Effect.provide(browserProtocol(port, { "x-relay-pin": "1234" })),
				Effect.timeout("10 seconds"),
			),
		);
		const disabled = await sendRpcRequest(socketPath, { _tag: "GetStatus" });
		record("status after browser removal", disabled);
		expect(disabled.pinEnabled).toBe(false);

		const observer = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
		sockets.add(observer);
		await once(observer, "open", { signal: AbortSignal.timeout(5000) });
		record("second browser open before CLI change", {
			readyState: observer.readyState,
		});
		const closed = new Promise<{ code: number; reason: string }>((done) =>
			observer.once("close", (code, reason) =>
				done({ code, reason: reason.toString() }),
			),
		);
		const reset = await sendRpcRequest(socketPath, {
			_tag: "SetPin",
			pin: "1234",
		});
		record("CLI resets PIN without currentPin", reset);
		expect(reset).toEqual({ ok: true });
		const closure = await closed;
		record("second browser revoked by CLI", closure);
		expect(closure.code).toBe(4001);
		const enabled = await sendRpcRequest(socketPath, { _tag: "GetStatus" });
		record("CLI still usable after revocation", enabled);
		expect(enabled.pinEnabled).toBe(true);
	}, 120_000);

	it("shares the login lockout across browser connections with different spoofed XFF prefixes", async () => {
		const { port, socketPath } = await start();
		const set = await sendRpcRequest(socketPath, {
			_tag: "SetPin",
			pin: "1234",
		});
		record("fresh daemon CLI PIN", set);
		expect(set).toEqual({ ok: true });
		const login = await fetch(`http://127.0.0.1:${port}/auth`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: "1234" }),
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("PIN login did not issue a session cookie");
		record("cookie login", { status: login.status });
		for (let attempt = 1; attempt <= 6; attempt++) {
			// Emulate a proxy appending the real IP after a changing spoofed prefix.
			const forwarded = `203.0.113.${attempt}, 198.51.100.25, , `;
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* Effect.result(
							client.SetPin({ pin: null, currentPin: "9999" }),
						);
					}),
				).pipe(
					Effect.provide(
						browserProtocol(port, { cookie, "x-forwarded-for": forwarded }),
					),
					Effect.timeout("5 seconds"),
				),
			);
			record("wrong browser attempt", { attempt, forwarded, result });
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "SetPinRejected",
					reason: attempt < 5 ? "wrong_pin" : "locked_out",
				},
			});
			if (
				Either.isFailure(result) &&
				result.failure._tag === "SetPinRejected" &&
				result.failure.reason === "locked_out"
			) {
				expect(result.failure.retryAfterSeconds).toBeGreaterThan(0);
				expect(result.failure.retryAfterSeconds).toBeLessThanOrEqual(900);
			}
		}
	}, 120_000);
});
