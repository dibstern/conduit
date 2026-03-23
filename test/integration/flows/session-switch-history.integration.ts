// ─── Integration: Session Switch History ──────────────────────────────────────
// Verifies that switching sessions delivers history embedded in session_switched
// so agent output doesn't disappear when switching away and back.

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
		await client.waitFor("done", { timeout: 5_000 });
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

		// History is embedded in session_switched (not a separate history_page).
		// May arrive as `events` (cache path) or `history` (REST fallback).
		const history = switchedBack["history"] as
			| { messages: unknown[]; hasMore: boolean }
			| undefined;
		const events = switchedBack["events"] as unknown[] | undefined;

		if (history) {
			expect(Array.isArray(history.messages)).toBe(true);
			// At least the user message should be in history
			expect(history.messages.length).toBeGreaterThan(0);
			expect(typeof history.hasMore).toBe("boolean");
		} else if (events) {
			// Cache path: events array with user_message/delta entries
			expect(events.length).toBeGreaterThan(0);
		} else {
			// Must have one or the other for a session with messages
			expect.unreachable(
				"session_switched contained neither events nor history",
			);
		}

		await client.close();
	}, 30_000);

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
			timeout: 5_000,
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

		// Wait for session A to finish processing in the background.
		// The mock completes SSE delivery in <1s; 3s is ample for the relay
		// to cache all events and finalize the session.
		await new Promise((r) => setTimeout(r, 3_000));

		// ── Switch back ─────────────────────────────────────────────────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
			predicate: (m) => m["id"] === sessionA,
		});

		// History is embedded in session_switched (not a separate history_page).
		// It may be in `history.messages` (REST fallback) or `events` (cache path).
		const history = switchedBack["history"] as
			| { messages: Array<Record<string, unknown>> }
			| undefined;
		const events = switchedBack["events"] as
			| Array<Record<string, unknown>>
			| undefined;

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

		// session_switched embeds history in two possible shapes:
		//   1. Cache path: `events` array of relay events (user_message, delta, etc.)
		//   2. REST fallback: `history.messages` with pre-rendered message objects
		if (events) {
			// Cache path: verify user_message and delta events
			const userMsgEvt = events.find(
				(e) =>
					e["type"] === "user_message" &&
					String(e["text"] ?? "").includes("pi"),
			);
			expect(userMsgEvt).toBeTruthy();

			const deltaEvts = events.filter((e) => e["type"] === "delta");
			expect(deltaEvts.length).toBeGreaterThan(0);

			const allDeltaText = deltaEvts
				.map((d) => String(d["text"] ?? ""))
				.join("");
			expect(allDeltaText.length).toBeGreaterThan(50);
			expect(allDeltaText).toContain(deltaSnippet);

			const safePrefix = streamedText.slice(
				0,
				Math.min(streamedText.length, 40),
			);
			if (safePrefix.length > 5) {
				expect(allDeltaText).toContain(safePrefix);
			}
		} else if (history?.messages) {
			// REST fallback: verify structured messages with roles and parts
			const messages = history.messages;
			expect(messages.length).toBeGreaterThanOrEqual(2);

			const piUserMsg = messages.find(
				(m) => getRole(m) === "user" && getTextContent(m).includes("pi"),
			);
			expect(piUserMsg).toBeTruthy();

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const piUserIdx = messages.indexOf(piUserMsg!);
			const assistantMsgs = messages
				.slice(piUserIdx + 1)
				.filter((m) => getRole(m) === "assistant");
			expect(assistantMsgs.length).toBeGreaterThan(0);
			const assistantMsg = assistantMsgs[0];

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			const assistantText = getTextContent(assistantMsg!);
			expect(assistantText.length).toBeGreaterThan(50);
			expect(assistantText).toContain(deltaSnippet);

			const safePrefix = streamedText.slice(
				0,
				Math.min(streamedText.length, 40),
			);
			if (safePrefix.length > 5) {
				expect(assistantText).toContain(safePrefix);
			}
		} else {
			// Neither path produced history — fail explicitly
			expect.unreachable(
				"session_switched contained neither events nor history",
			);
		}

		await client.close();
	}, 30_000);

	// ── Empty session: switching back delivers session_switched ─────────

	it("switch to empty session delivers session_switched with correct id", async () => {
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
		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
			predicate: (m) => m["id"] === sessionB,
		});

		// session_switched should arrive with the correct session ID.
		// For an empty session, history will have empty messages (REST path)
		// or events may be present (cache path — can happen in shared environments).
		expect(switchedBack["id"]).toBe(sessionB);
		const history = switchedBack["history"] as
			| { messages: unknown[]; hasMore: boolean }
			| undefined;
		if (history) {
			expect(Array.isArray(history.messages)).toBe(true);
			expect(history.messages.length).toBe(0);
			expect(history.hasMore).toBe(false);
		}
		// If events are present instead, that's the cache path — still valid

		await client.close();
	});

	// ── Multi-client: per-tab session switching ─────────────────────────

	it("session_switched with history is sent only to the requesting client", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Record initial session
		const initial1 = client1.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const sessionA = initial1[0]!["id"] as string;

		// client1 creates session B (only client1 gets session_switched;
		// both get session_list broadcast)
		client1.clearReceived();
		client2.clearReceived();
		client1.send({
			type: "new_session",
			title: "Multi-Client History Test",
		});
		const switchedB = await client1.waitFor("session_switched", {
			timeout: 5_000,
		});
		// client2 receives session_list (not session_switched)
		await client2.waitFor("session_list", { timeout: 5_000 });
		expect(switchedB["id"]).toBeTruthy();
		client1.clearReceived();
		client2.clearReceived();

		// client1 switches back to session A — per-tab, only client1 gets the switch
		client1.send({ type: "switch_session", sessionId: sessionA });

		const switched1 = await client1.waitFor("session_switched", {
			timeout: 5_000,
			predicate: (m) => m["id"] === sessionA,
		});

		// Verify client1 received session_switched with the right session
		expect(switched1["id"]).toBe(sessionA);

		// client2 should NOT receive session_switched for this per-tab switch.
		// Give it a moment then verify no session_switched arrived.
		await new Promise((r) => setTimeout(r, 1_000));
		const client2Switches = client2.getReceivedOfType("session_switched");
		expect(client2Switches.length).toBe(0);

		await client1.close();
		await client2.close();
	});

	// ── Rapid switches: last session_switched matches final session ──────

	it("rapid switches: last session_switched matches final session", async () => {
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

		// Wait for the final switch to complete (sessionC)
		await client.waitFor("session_switched", {
			timeout: 5_000,
			predicate: (m) => m["id"] === sessionC,
		});

		const sessionSwitches = client.getReceivedOfType("session_switched");
		expect(sessionSwitches.length).toBeGreaterThanOrEqual(1);

		// The last session_switched should match the final switch target
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const lastSwitch = sessionSwitches[sessionSwitches.length - 1]!;
		expect(lastSwitch["id"]).toBe(sessionC);

		// All session_switched messages should have valid session IDs
		const validIds = new Set([sessionA, sessionB, sessionC]);
		for (const sw of sessionSwitches) {
			expect(validIds.has(sw["id"] as string)).toBe(true);
		}

		await client.close();
	});
});
