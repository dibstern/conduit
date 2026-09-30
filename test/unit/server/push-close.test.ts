import { createECDH } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { AlertLedgerLive } from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import type { Logger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sendPushForEventEffect } from "../../../src/lib/relay/sse-wiring.js";
import { PushNotificationManager } from "../../../src/lib/server/push.js";

it("releases a claim after the endpoint closes without response or error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-close-"));
	const requests: http.ClientRequest[] = [];
	const responses: number[] = [];
	const errors: Error[] = [];
	const warnings: unknown[][] = [];
	// Keep Node's HTTP parser and web-push encoder; replace only the network.
	const transport = vi
		.spyOn(https, "request")
		.mockImplementation((_url, options, callback) => {
			const first = requests.length === 0;
			const socket = new Duplex({
				read() {},
				write(_chunk, _encoding, done) {
					done();
				},
				final(done) {
					done();
				},
			});
			const request = http.request({
				...options,
				createConnection: () => socket,
			});
			request.on("response", (response) => {
				responses.push(response.statusCode ?? 0);
				callback?.(response);
			});
			request.on("error", (error) => errors.push(error));
			request.on("finish", () =>
				socket.push(
					first
						? "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
						: "HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
				),
			);
			requests.push(request);
			return request;
		});
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: () => Effect.void,
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	});
	const log: Logger = {
		debug: () => {},
		verbose: () => {},
		info: () => {},
		warn: (...args) => {
			warnings.push(args);
		},
		error: () => {},
		child: () => log,
	};
	try {
		const manager = new PushNotificationManager({ configDir: dir });
		await manager.init();
		const ecdh = createECDH("prime256v1");
		manager.addSubscription("device", {
			endpoint: "https://push.example/a",
			keys: {
				p256dh: ecdh.generateKeys().toString("base64url"),
				auth: Buffer.alloc(16).toString("base64url"),
			},
		});
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "s1", {
						sessionId: "s1",
						title: "Question",
						provider: "opencode",
					}),
				]);
				const send = sendPushForEventEffect(
					manager,
					{
						type: "ask_user",
						sessionId: "s1",
						toolId: "question",
						questions: [],
					},
					log,
					{ sessionId: "s1" },
				);
				yield* send;
				expect(requests[0]?.destroyed).toBe(true);
				expect(responses).toEqual([]);
				expect(errors).toEqual([]);
				expect(warnings).toHaveLength(1);
				yield* send;
				yield* send;
				expect(requests).toHaveLength(2);
				expect(responses).toEqual([201]);
				expect(warnings).toHaveLength(1);
			}).pipe(
				Effect.timeout("1 second"),
				Effect.provide(AlertLedgerLive),
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(
							join(dir, "events.db"),
							createAllEffectProjectors(),
							bus,
						),
						bus,
					),
				),
			),
		);
	} finally {
		for (const request of requests) request.destroy();
		transport.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});
