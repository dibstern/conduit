import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("streaming cost through the fake Claude process", () => {
	it("records WebSocket payload bytes and coalesced SQLite WAL writes", async () => {
		const harness = ProcessHarness.create();
		const metricsFile = join(harness.root, "streaming-metrics.json");
		try {
			// Allow cold process imports on a busy development machine.
			await harness.restart({
				metricsFile,
				profile: true,
				startupTimeoutMs: 30_000,
				runnerStartupTimeoutMs: 20_000,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession();
			await browser.followFamily(sessionId);
			const messageCursor = browser.frames.length;
			const cursor = harness.rpcDiagnostics.wireFrames.length;
			const chunks = responseChunks("streaming-cost");
			const finalText = chunks.join("");
			const submitted = await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "queue",
					text: "streaming-cost",
				}),
			);
			expect(submitted.ok).toBe(true);
			// Wait for the detail stream itself. The harness's send convenience
			// method fences with LoadMoreHistory, which would inflate wire totals.
			const assistant = await browser.waitFor(
				(message) =>
					message["type"] === "transcript_message" &&
					message["role"] === "assistant" &&
					(message["parts"] as HistoryMessage["parts"])
						?.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("") === finalText,
				messageCursor,
				30_000,
			);
			await browser.waitForTurnEnd(sessionId, messageCursor);
			const end = harness.rpcDiagnostics.wireFrames.length;
			const messageId = assistant["id"];
			expect(messageId).toBeTruthy();
			let writes: {
				messageId: string;
				chunkChars: number;
				textChars: number;
				walBytes: number;
			}[] = [];
			await vi.waitFor(
				() => {
					const metrics = JSON.parse(readFileSync(metricsFile, "utf8")) as {
						streamingWrites: typeof writes;
					};
					writes = metrics.streamingWrites.filter(
						(write) => write.messageId === messageId,
					);
					expect(writes.length).toBeGreaterThanOrEqual(2);
					expect(writes.length).toBeLessThan(chunks.length);
					expect(writes.at(-1)?.textChars).toBe(finalText.length);
				},
				{ timeout: 5000 },
			);
			const frames = harness.rpcDiagnostics.wireFrames
				.slice(cursor, end)
				.filter(({ endpoint }) => endpoint.startsWith("ws://"));
			const detailFrames = frames.filter(({ rpcs }) =>
				rpcs.includes("SubscribeSessionDetail"),
			);
			const totalBytes = frames.reduce((sum, { bytes }) => sum + bytes, 0);
			const detailBytes = detailFrames.reduce(
				(sum, { bytes }) => sum + bytes,
				0,
			);
			const assistantParts = detailFrames
				.flatMap(({ detailParts }) => detailParts)
				.filter((part) => part.messageId === messageId);
			const streamedTextBytes = assistantParts.reduce(
				(sum, { bytes }) => sum + bytes,
				0,
			);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/8rdf-2-process-cost.json",
				JSON.stringify(
					{
						measurement:
							"received WebSocket JSON payload bytes before suffix decoding; excludes compression and frame headers",
						finalTextChars: finalText.length,
						finalTextBytes: Buffer.byteLength(finalText),
						persistedTextDeltaRows: writes.length,
						chunkCount: chunks.length,
						frames,
						totalBytes,
						detailBytes,
						streamedTextBytes,
						wireToTextRatio: totalBytes / Buffer.byteLength(finalText),
						writes,
					},
					null,
					2,
				),
			);
			expect(finalText.length).toBeGreaterThanOrEqual(10_000);
			expect(detailFrames.length).toBeGreaterThan(0);
			expect(assistantParts.some(({ suffix }) => suffix)).toBe(true);
			expect(streamedTextBytes).toBe(Buffer.byteLength(finalText));
			expect(detailBytes).toBeLessThan(Buffer.byteLength(finalText) * 60);
			expect(writes.every(({ walBytes }) => walBytes > 0)).toBe(true);
			expect(writes.at(-1)?.textChars).toBe(finalText.length);
		} finally {
			await harness.dispose();
		}
	}, 90_000);
});
