// Measure before changing storage: payload growth, coalesced reads, or a WAL
// checkpoint must not masquerade as the cost of one projected text chunk.
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Queue, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { subscribeSessionDetail } from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { decodeSessionDetail } from "../../../src/lib/frontend/transport/session-detail-wire.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

describe("streaming storage and detail payload cost", () => {
	it("captures every committed chunk and keeps suffix payloads proportional to final text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-streaming-cost-"));
		const dbPath = join(dir, "events.db");
		const chunks = responseChunks("streaming-cost");
		const finalText = chunks.join("");
		const frameBytes: number[] = [];
		const wholeRowFrameBytes: number[] = [];
		const writes: { chunk: number; textChars: number; walBytes: number }[] = [];
		let wireTextBytes = 0;
		let decodedText = "";
		const layer = Layer.mergeAll(
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
			makePersistenceEffectLayer(
				dbPath,
				"test-project",
				undefined,
				SessionEventBusLive,
			),
			SessionEventBusLive,
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* (yield* ProjectionRunnerEffectTag).recover();
						const sql = yield* SqlClient.SqlClient;
						// This is an isolated fixture connection. Disable automatic checkpoints
						// so file growth counts every written WAL frame, including overflow pages.
						yield* sql.unsafe("PRAGMA wal_autocheckpoint = 0");
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent(
								"session.created",
								"s",
								{ sessionId: "s", title: "Cost", provider: "claude" },
								{ provider: "claude", createdAt: 1 },
							),
							canonicalEvent(
								"message.created",
								"s",
								{ sessionId: "s", messageId: "m", role: "assistant" },
								{ provider: "claude", createdAt: 2 },
							),
						]);
						const output = yield* Queue.unbounded<SessionDetailEnvelope>();
						yield* subscribeSessionDetail({ sessionId: "s" }).pipe(
							Stream.tap((frame) =>
								Effect.sync(() => {
									frameBytes.push(Buffer.byteLength(JSON.stringify(frame)));
									if (frame._tag === "upsert" && frame.item._tag === "part")
										wireTextBytes += Buffer.byteLength(
											frame.item.part.text ?? "",
										);
								}),
							),
							decodeSessionDetail,
							Stream.tap((frame) =>
								Effect.sync(() =>
									wholeRowFrameBytes.push(
										Buffer.byteLength(JSON.stringify(frame)),
									),
								),
							),
							Stream.runForEach((frame) => Queue.offer(output, frame)),
							Effect.forkScoped,
						);
						while ((yield* Queue.take(output))._tag !== "synchronized") {
							/* drain snapshot */
						}
						let textChars = 0;
						for (const [chunk, text] of chunks.entries()) {
							const before = statSync(`${dbPath}-wal`).size;
							yield* commit([
								canonicalEvent(
									"text.delta",
									"s",
									{ messageId: "m", partId: "p", text },
									{ provider: "claude", createdAt: chunk + 3 },
								),
							]);
							textChars += text.length;
							writes.push({
								chunk,
								textChars,
								walBytes: statSync(`${dbPath}-wal`).size - before,
							});
							for (;;) {
								const frame = yield* Queue.take(output);
								if (frame._tag === "upsert" && frame.item._tag === "part") {
									decodedText = frame.item.part.text ?? "";
									break;
								}
							}
						}
					}),
				).pipe(Effect.provide(layer), Effect.timeout("30 seconds")),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const totalBytes = frameBytes.reduce((sum, bytes) => sum + bytes, 0);
		const wholeRowTotalBytes = wholeRowFrameBytes.reduce(
			(sum, bytes) => sum + bytes,
			0,
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/8rdf-2-projection-cost.json",
			JSON.stringify(
				{
					measurement:
						"real SQLite projection and subscription JSON payloads, without sockets",
					finalTextChars: finalText.length,
					finalTextBytes: Buffer.byteLength(finalText),
					chunks: chunks.length,
					frameBytes,
					totalBytes,
					wholeRowFrameBytes,
					wholeRowTotalBytes,
					wireToTextRatio: totalBytes / Buffer.byteLength(finalText),
					wireTextBytes,
					writes,
				},
				null,
				2,
			),
		);
		expect(finalText.length).toBeGreaterThanOrEqual(10_000);
		expect(writes).toHaveLength(chunks.length);
		expect(writes.every(({ walBytes }) => walBytes > 0)).toBe(true);
		expect(decodedText).toBe(finalText);
		expect(wireTextBytes).toBe(Buffer.byteLength(finalText));
		expect(totalBytes).toBeLessThan(Buffer.byteLength(finalText) * 20);
		expect(wholeRowTotalBytes).toBeGreaterThan(totalBytes * 10);
	}, 35_000);
});
