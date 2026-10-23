// The browser replay runs the full UI. This seam also runs without Chromium:
// the real Svelte recap state, RPC transport and relay, with mock OpenCode.
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TurnRecapState } from "../../../src/lib/frontend/stores/turn-recap.svelte.js";
import { disposeRuntime } from "../../../src/lib/frontend/transport/runtime.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { segmentTurns } from "../../../src/lib/frontend/utils/turns.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { isRecord } from "../../../src/lib/utils.js";
import { createReplayHarness } from "../../e2e/helpers/e2e-harness.js";
import { seedPagedRecapTurn } from "../../e2e/helpers/recap-history.js";

beforeEach(async () => {
	await mkdir("test-results", { recursive: true });
});

afterEach(async () => {
	await disposeRuntime();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("a paged turn retains its stored identity through the real history RPC", async () => {
	const harness = await createReplayHarness("chat-simple");
	try {
		const { sessionId, turnId } = await seedPagedRecapTurn(harness);
		vi.stubGlobal("WebSocket", WebSocket);
		vi.stubGlobal("location", new URL(harness.relayBaseUrl));
		const history = await rpc("LoadMoreHistory", { sessionId });
		expect(history.hasMore).toBe(true);
		expect(history.messages).toHaveLength(50);
		// The legacy converter reads these decoded arrays without mutating them.
		const [turn] = segmentTurns(
			historyToChatMessages(history.messages as HistoryMessage[]),
			false,
		);
		expect(turn?.user).toBeUndefined();
		expect(turn?.id).toMatch(/^turn-/);
		await writeFile(
			"test-results/xy45-paged-turn.json",
			JSON.stringify(
				{ turnId, displayId: turn?.id, storeId: turn?.storeId },
				null,
				2,
			),
		);
		expect(turn?.storeId).toBe(turnId);
		if (!turn?.storeId) throw new Error("Missing stored turn identity");
		await expect(
			rpc("ListRecaps", { sessionId, turnId: turn.id }),
		).rejects.toMatchObject({
			message: expect.stringContaining("Unknown turn"),
		});
		await expect(
			rpc("ListRecaps", { sessionId, turnId: turn.storeId }),
		).resolves.toEqual([]);
	} finally {
		await disposeRuntime();
		await harness.stop();
	}
});

it("an unknown turn terminates the real recap client feed", async () => {
	const harness = await createReplayHarness("chat-simple");
	let stop: (() => void) | undefined;
	try {
		vi.stubGlobal("WebSocket", WebSocket);
		vi.stubGlobal("location", new URL(harness.relayBaseUrl));
		const send = vi.spyOn(WebSocket.prototype, "send");
		const attempts = () =>
			send.mock.calls.flatMap(([data]) => {
				if (typeof data !== "string") return [];
				const decoded: unknown = JSON.parse(data);
				return (Array.isArray(decoded) ? decoded : [decoded]).filter(
					(frame) => isRecord(frame) && frame["tag"] === "SubscribeRecaps",
				);
			});
		const recap = new TurnRecapState();
		const sessionId = harness.projectUrl.split("/").at(-1);
		if (!sessionId) throw new Error("Missing replay session");
		stop = recap.connect(sessionId, "turn-display-only", true);
		await expect.poll(() => attempts().length).toBeGreaterThan(0);
		await setTimeout(3_500);
		await writeFile(
			"test-results/xy45-recap-feed.json",
			JSON.stringify({ attempts: attempts(), error: recap.error }, null, 2),
		);
		expect(attempts()).toHaveLength(1);
		expect(recap.error).toContain("Unknown turn");
	} finally {
		stop?.();
		await Promise.resolve();
		await disposeRuntime();
		await harness.stop();
	}
});
