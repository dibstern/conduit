// ─── Integration: Session Switch History ──────────────────────────────────────
// Verifies the bug fix: switching sessions broadcasts history_page so agent
// output doesn't disappear when switching away and back.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Session Switch History", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	// ── Core regression: switching back to a session with messages ────────

	it("switch_session broadcasts history_page with session messages", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session (assigned on connect)
		const initialSwitched = client.getReceivedOfType("session_switched");
		expect(initialSwitched.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const sessionA = initialSwitched[0]!["id"] as string;

		// Send a message to create conversation history in session A
		client.clearReceived();
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for the full model round-trip
		await client.waitFor("done", { timeout: 80_000 });
		client.clearReceived();

		// Create a new session (auto-switches away from session A)
		client.send({ type: "new_session", title: "Switch Away Target" });
		const switchedToB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedToB["id"]).toBeTruthy();
		client.clearReceived();

		// Switch back to session A
		client.send({ type: "switch_session", sessionId: sessionA });

		// Should receive session_switched for session A
		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedBack["id"]).toBe(sessionA);

		// Should receive history_page for session A (the bug fix)
		const historyPage = await client.waitFor("history_page", {
			timeout: 5_000,
			predicate: (m) => m["sessionId"] === sessionA,
		});

		expect(historyPage["sessionId"]).toBe(sessionA);
		expect(Array.isArray(historyPage["messages"])).toBe(true);
		const messages = historyPage["messages"] as unknown[];
		// At least the user message should be in history
		expect(messages.length).toBeGreaterThan(0);
		expect(typeof historyPage["hasMore"]).toBe("boolean");

		await client.close();
	}, 120_000);

	// ── Mid-stream switch: partial response preserved in history ─────────

	it("switching away mid-stream then back preserves full conversation content", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Use the initial session
		const initialSwitched = client.getReceivedOfType("session_switched");
		expect(initialSwitched.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const sessionA = initialSwitched[0]!["id"] as string;

		// Ask something that produces a longer, multi-part response.
		const userPrompt =
			"List 5 interesting facts about the number pi (π). " +
			"Number each fact 1 through 5 and write 2-3 sentences for each.";

		client.clearReceived();
		client.send({ type: "message", text: userPrompt });

		// Wait for the first streaming delta — proof the model started responding
		const firstDelta = await client.waitFor("delta", {
			timeout: 60_000,
		});
		const deltaSnippet = (firstDelta["text"] as string).trim();
		expect(deltaSnippet.length).toBeGreaterThan(0);

		// Collect a few more deltas so we have substantial streamed text
		await new Promise((r) => setTimeout(r, 2_000));
		const allDeltas = client.getReceivedOfType("delta");
		const streamedText = allDeltas.map((d) => d["text"] as string).join("");
		expect(streamedText.length).toBeGreaterThan(0);

		// ── Switch away mid-stream ──────────────────────────────────────
		client.send({
			type: "new_session",
			title: "Mid-Stream Switch Target",
		});
		const switchedToB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedToB["id"]).toBeTruthy();

		// Wait long enough for the model to finish processing session A
		// in the background.
		await new Promise((r) => setTimeout(r, 30_000));

		// ── Switch back ─────────────────────────────────────────────────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		const historyPage = await client.waitFor("history_page", {
			timeout: 5_000,
			predicate: (m) => m["sessionId"] === sessionA,
		});

		// ── Helpers ─────────────────────────────────────────────────────

		// OpenCode messages may nest role in `info` or at top level
		const getRole = (m: Record<string, unknown>): string => {
			if (typeof m["role"] === "string") return m["role"];
			const info = m["info"] as Record<string, unknown> | undefined;
			if (info && typeof info["role"] === "string") return info["role"];
			return "";
		};

		// Extract all text content from a message's parts
		const getTextContent = (m: Record<string, unknown>): string => {
			const parts = (m["parts"] ?? []) as Array<Record<string, unknown>>;
			return parts
				.filter((p) => p["type"] === "text")
				.map((p) => String(p["text"] ?? p["content"] ?? ""))
				.join("");
		};

		// ── Verify conversation structure ───────────────────────────────
		const messages = historyPage["messages"] as Array<Record<string, unknown>>;
		expect(messages.length).toBeGreaterThanOrEqual(2);

		// Find our specific messages by content
		const piUserMsg = messages.find(
			(m) => getRole(m) === "user" && getTextContent(m).includes("pi"),
		);
		expect(piUserMsg).toBeTruthy();

		// The assistant response for our pi prompt
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const piUserIdx = messages.indexOf(piUserMsg!);
		const assistantMsgs = messages
			.slice(piUserIdx + 1)
			.filter((m) => getRole(m) === "assistant");
		expect(assistantMsgs.length).toBeGreaterThan(0);
		const assistantMsg = assistantMsgs[0];

		// ── Verify user message content ─────────────────────────────────
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const userText = getTextContent(piUserMsg!);
		expect(userText).toContain("pi");

		// ── Verify assistant response content ───────────────────────────
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const assistantText = getTextContent(assistantMsg!);
		// The completed response should have real substance
		expect(assistantText.length).toBeGreaterThan(50);

		// The first delta we captured mid-stream should appear in the
		// completed assistant text
		expect(assistantText).toContain(deltaSnippet);

		// The streamed text we captured before switching should be
		// a prefix of (or contained within) the final response.
		const safePrefix = streamedText.slice(0, Math.min(streamedText.length, 40));
		if (safePrefix.length > 5) {
			expect(assistantText).toContain(safePrefix);
		}

		await client.close();
	}, 120_000);

	// ── Empty session: history_page with empty messages ──────────────────

	it("switch to empty session broadcasts history_page with empty messages", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Create session B (no messages sent to it)
		client.clearReceived();
		client.send({ type: "new_session", title: "Empty Session B" });
		const switchedB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionB = switchedB["id"] as string;

		// Create session C to switch away from B
		client.clearReceived();
		client.send({ type: "new_session", title: "Empty Session C" });
		await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		client.clearReceived();

		// Switch back to session B
		client.send({ type: "switch_session", sessionId: sessionB });
		await client.waitFor("session_switched", { timeout: 5_000 });

		const historyPage = await client.waitFor("history_page", {
			timeout: 5_000,
			predicate: (m) => m["sessionId"] === sessionB,
		});

		expect(historyPage["sessionId"]).toBe(sessionB);
		expect(Array.isArray(historyPage["messages"])).toBe(true);
		expect((historyPage["messages"] as unknown[]).length).toBe(0);
		expect(historyPage["hasMore"]).toBe(false);

		await client.close();
	});

	// ── Multi-client: broadcast to all connected clients ────────────────

	it("history_page is broadcast to all connected clients", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Record initial session
		const initial1 = client1.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const sessionA = initial1[0]!["id"] as string;

		// client1 creates session B (both receive session_switched)
		client1.clearReceived();
		client2.clearReceived();
		client1.send({
			type: "new_session",
			title: "Multi-Client History Test",
		});
		const switchedB = await client1.waitFor("session_switched", {
			timeout: 5_000,
		});
		await client2.waitFor("session_switched", { timeout: 5_000 });
		expect(switchedB["id"]).toBeTruthy();
		client1.clearReceived();
		client2.clearReceived();

		// client1 switches back to session A
		client1.send({ type: "switch_session", sessionId: sessionA });

		// Both clients should receive history_page (it's a broadcast)
		const [hp1, hp2] = await Promise.all([
			client1.waitFor("history_page", {
				timeout: 5_000,
				predicate: (m) => m["sessionId"] === sessionA,
			}),
			client2.waitFor("history_page", {
				timeout: 5_000,
				predicate: (m) => m["sessionId"] === sessionA,
			}),
		]);

		expect(hp1["sessionId"]).toBe(sessionA);
		expect(hp2["sessionId"]).toBe(sessionA);
		expect(Array.isArray(hp1["messages"])).toBe(true);
		expect(Array.isArray(hp2["messages"])).toBe(true);

		await client1.close();
		await client2.close();
	});

	// ── Rapid switches: last history_page matches final session ──────────

	it("rapid switches: last history_page matches final session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record initial session
		const initial = client.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const sessionA = initial[0]!["id"] as string;

		// Create sessions B and C
		client.clearReceived();
		client.send({ type: "new_session", title: "Rapid B" });
		const switchedB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionB = switchedB["id"] as string;

		client.clearReceived();
		client.send({ type: "new_session", title: "Rapid C" });
		const switchedC = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionC = switchedC["id"] as string;

		// Fire 3 rapid switch_session commands without awaiting between sends
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionB });
		client.send({ type: "switch_session", sessionId: sessionA });
		client.send({ type: "switch_session", sessionId: sessionC });

		// Wait for all three to complete
		await new Promise((r) => setTimeout(r, 3_000));

		const historyPages = client.getReceivedOfType("history_page");
		expect(historyPages.length).toBeGreaterThanOrEqual(1);

		// The last history_page should match the final switch target
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const lastPage = historyPages[historyPages.length - 1]!;
		expect(lastPage["sessionId"]).toBe(sessionC);

		// All history_page messages should have valid session IDs
		const validIds = new Set([sessionA, sessionB, sessionC]);
		for (const hp of historyPages) {
			expect(validIds.has(hp["sessionId"] as string)).toBe(true);
		}

		await client.close();
	});
});
