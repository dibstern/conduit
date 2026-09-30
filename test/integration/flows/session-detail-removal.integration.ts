import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import Database from "better-sqlite3";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

describe("session detail removal over WebSocket", () => {
	it("resumes after a rewind removal and pages without the removed message", async () => {
		const harness = await createRelayHarness();
		try {
			const client = await harness.connectWsClient();
			await client.waitForInitialState();
			const sessionId = "ses_detail_removal";
			harness.mock.emitTestEvent("session.created", {
				info: { id: sessionId, title: "Rewind" },
			});
			harness.mock.emitTestEvent("message.created", {
				sessionID: sessionId,
				messageID: "rewound-message",
				info: { role: "user" },
			});
			const db = new Database(harness.eventsDbPath);
			try {
				const hasMessage = () =>
					db
						.prepare("SELECT 1 FROM messages WHERE id = ?")
						.get("rewound-message") !== undefined;
				for (let attempt = 0; !hasMessage() && attempt < 200; attempt++)
					await new Promise((resolve) => setTimeout(resolve, 10));
				expect(hasMessage()).toBe(true);
				const cursor = db
					.prepare("SELECT value FROM read_model_counter WHERE id = 1")
					.get() as { value: number };
				harness.mock.emitTestEvent("message.removed", {
					sessionID: sessionId,
					messageID: "rewound-message",
				});
				for (let attempt = 0; hasMessage() && attempt < 200; attempt++)
					await new Promise((resolve) => setTimeout(resolve, 10));
				expect(hasMessage()).toBe(false);
				const removal = db
					.prepare(
						"SELECT version FROM message_tombstones WHERE message_id = ?",
					)
					.get("rewound-message") as { version: number };

				const previousWebSocket = globalThis.WebSocket;
				Object.assign(globalThis, { WebSocket });
				try {
					const envelopes = await Effect.runPromise(
						Effect.scoped(
							Effect.gen(function* () {
								const rpc = yield* RpcClient.make(WsRpcGroup);
								return yield* Stream.runCollect(
									Stream.take(
										rpc.SubscribeSessionDetail({
											projectSlug: "integration-test",
											sessionId,
											resumeFromSequence: cursor.value,
										}),
										2,
									),
								);
							}).pipe(
								Effect.provide(RpcClient.layerProtocolSocket()),
								Effect.provide(
									Socket.layerWebSocket(
										`ws://127.0.0.1:${harness.relayPort}/rpc`,
									),
								),
								Effect.provide(Socket.layerWebSocketConstructorGlobal),
								Effect.provide(RpcSerialization.layerJson),
							),
						),
					);
					expect(Array.from(envelopes)).toEqual([
						{
							_tag: "remove",
							id: "rewound-message",
							sequence: removal.version,
						},
						{ _tag: "synchronized" },
					]);
				} finally {
					Object.assign(globalThis, { WebSocket: previousWebSocket });
				}
				const page = await client.loadMoreHistory(sessionId);
				expect(page.messages.map((message) => message.id)).not.toContain(
					"rewound-message",
				);
			} finally {
				db.close();
			}
		} finally {
			await harness.stop();
		}
	}, 45_000);
});
