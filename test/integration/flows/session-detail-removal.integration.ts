import Database from "better-sqlite3";
import { Effect, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

type Harness = Awaited<ReturnType<typeof createRelayHarness>>;

/** The first `take` envelopes of a detail stream resumed from `cursor`. */
const resume = async (
	harness: Harness,
	sessionId: string,
	cursor: number,
	take: number,
) => {
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
								sessionId,
								resumeFromSequence: cursor,
							}),
							take,
						),
					);
				}).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(
						Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
					),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			),
		);
		return Array.from(envelopes);
	} finally {
		Object.assign(globalThis, { WebSocket: previousWebSocket });
	}
};

const waitUntil = async (done: () => boolean) => {
	for (let attempt = 0; !done() && attempt < 200; attempt++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(done()).toBe(true);
};

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

				expect(await resume(harness, sessionId, cursor.value, 3)).toEqual([
					{
						_tag: "remove",
						id: "rewound-message",
						sequence: removal.version,
					},
					{
						_tag: "upsert",
						item: { _tag: "rewind", messageId: null },
						sequence: removal.version,
					},
					{ _tag: "synchronized" },
				]);
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

	it("resumes after a part removal with the removal and the message it moved", async () => {
		const harness = await createRelayHarness();
		try {
			const client = await harness.connectWsClient();
			await client.waitForInitialState();
			const sessionId = "ses_part_removal";
			const messageId = "trimmed-message";
			harness.mock.emitTestEvent("session.created", {
				info: { id: sessionId, title: "Trim" },
			});
			harness.mock.emitTestEvent("message.created", {
				sessionID: sessionId,
				messageID: messageId,
				info: { role: "assistant" },
			});
			for (const id of ["kept-part", "removed-part"])
				harness.mock.emitTestEvent("message.part.updated", {
					sessionID: sessionId,
					part: {
						id,
						sessionID: sessionId,
						messageID: messageId,
						type: "text",
						text: id,
					},
				});
			const db = new Database(harness.eventsDbPath);
			try {
				const hasPart = () =>
					db
						.prepare("SELECT 1 FROM message_parts WHERE id = ?")
						.get("removed-part") !== undefined;
				await waitUntil(hasPart);
				const cursor = db
					.prepare("SELECT value FROM read_model_counter WHERE id = 1")
					.get() as { value: number };
				harness.mock.emitTestEvent("message.part.removed", {
					sessionID: sessionId,
					messageID: messageId,
					partID: "removed-part",
				});
				await waitUntil(() => !hasPart());
				const removal = db
					.prepare(
						"SELECT version FROM message_part_tombstones WHERE part_id = ?",
					)
					.get("removed-part") as { version: number };

				// Only what moved: the part's removal and its message's header, not
				// the part that stayed, then the held rows every resume re-sends.
				expect(await resume(harness, sessionId, cursor.value, 4)).toMatchObject(
					[
						{
							_tag: "remove",
							id: JSON.stringify([messageId, "removed-part"]),
							sequence: removal.version,
						},
						{
							_tag: "upsert",
							item: { _tag: "message", message: { id: messageId } },
							sequence: removal.version,
						},
						{
							_tag: "upsert",
							item: { _tag: "rewind", messageId: null },
							sequence: removal.version,
						},
						{ _tag: "synchronized" },
					],
				);
				const page = await client.loadMoreHistory(sessionId);
				expect(
					page.messages
						.find((message) => message.id === messageId)
						?.parts?.map((part) => part.id),
				).toEqual(["kept-part"]);
			} finally {
				db.close();
			}
		} finally {
			await harness.stop();
		}
	}, 45_000);
});
