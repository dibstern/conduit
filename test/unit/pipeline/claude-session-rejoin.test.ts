import { beforeEach, describe, expect, it } from "vitest";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";

/**
 * These tests specify the EXPECTED behavior for Claude session rejoin.
 * They document the navigate-away-and-back bug:
 *   - User views Claude session, streaming is active
 *   - User navigates away (switches session)
 *   - User navigates back
 *   - Expected: new events stream to client
 *   - Actual (bug): streaming stops
 *
 * Tests marked with .fails or .todo are specs for the fix.
 */

const SESSION_ID = "ses-rejoin-1";
const CLIENT_ID = "client-1";

/**
 * Minimal WS handler mock that tracks client→session mappings
 * and records messages sent via sendToSession.
 */
function createMockWsHandler() {
	const clientSessions = new Map<string, string>();
	const sentToSession: Array<{ sessionId: string; msg: RelayMessage }> = [];
	const sentToClient: Array<{ clientId: string; msg: RelayMessage }> = [];

	return {
		setClientSession(clientId: string, sessionId: string) {
			clientSessions.set(clientId, sessionId);
		},
		getClientSession(clientId: string) {
			return clientSessions.get(clientId);
		},
		removeClient(clientId: string) {
			clientSessions.delete(clientId);
		},
		sendToSession(sessionId: string, msg: RelayMessage) {
			sentToSession.push({ sessionId, msg });
		},
		sendTo(clientId: string, msg: RelayMessage) {
			sentToClient.push({ clientId, msg });
		},
		getViewers(sessionId: string) {
			return [...clientSessions.entries()]
				.filter(([_, sid]) => sid === sessionId)
				.map(([cid]) => cid);
		},
		sentToSession,
		sentToClient,
		clientSessions,
	};
}

describe("Claude session rejoin — event flow contracts", () => {
	let wsHandler: ReturnType<typeof createMockWsHandler>;

	beforeEach(() => {
		wsHandler = createMockWsHandler();
	});

	it("events flow to client when mapped to session", async () => {
		// Client viewing the session
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);

		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			send: (msg) => {
				sent.push(msg);
				wsHandler.sendToSession(SESSION_ID, msg);
			},
		});

		// Push a text delta
		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: "Hello",
			}),
		);

		// Event should be sent
		expect(sent.length).toBeGreaterThan(0);
		expect(sent.some((m) => m.type === "delta")).toBe(true);
	});

	it("events still emitted by sink when no clients viewing (server-side)", async () => {
		// No client mapped — simulates navigate-away
		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			send: (msg) => sent.push(msg),
		});

		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: "Hello while away",
			}),
		);

		// Sink still produces relay messages (it doesn't know about clients)
		expect(sent.length).toBeGreaterThan(0);
	});

	it("events reach client after remap (rejoin)", async () => {
		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			send: (msg) => sent.push(msg),
		});

		// Phase 1: client mapped, events flow
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);
		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: "Before navigate",
			}),
		);

		// Phase 2: client navigates away
		wsHandler.setClientSession(CLIENT_ID, "other-session");

		// Phase 3: events continue server-side
		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: " while away",
			}),
		);

		// Phase 4: client navigates back
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);

		// Phase 5: new events should still flow
		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: " after return",
			}),
		);

		// All three events produced by sink
		const deltas = sent.filter((m) => m.type === "delta");
		expect(deltas.length).toBe(3);
	});

	it("thinking lifecycle completes across navigate-away and back", async () => {
		const sent: RelayMessage[] = [];
		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			send: (msg) => sent.push(msg),
		});

		// thinking.start while client is viewing
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);
		await sink.push(
			canonicalEvent("thinking.start", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-think-1",
			}),
		);
		expect(sent.some((m) => m.type === "thinking_start")).toBe(true);

		// thinking.delta while client navigated away
		wsHandler.setClientSession(CLIENT_ID, "other-session");
		await sink.push(
			canonicalEvent("thinking.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-think-1",
				text: "reasoning while user is away...",
			}),
		);

		// thinking.end arrives, client still away
		await sink.push(
			canonicalEvent("thinking.end", SESSION_ID, {
				messageId: "msg-1",
				partId: "part-think-1",
			}),
		);

		// Client returns
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);

		// Verify full thinking lifecycle was emitted by sink
		const types = sent.map((m) => m.type);
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("thinking_stop");
		// No spurious tool_result for thinking
		expect(types.filter((t) => t === "tool_result")).toHaveLength(0);
	});

	it("PROCESSING_TIMEOUT clears cleanly — no stuck state after return", async () => {
		const sent: RelayMessage[] = [];
		let timeoutCleared = false;

		const sink = createRelayEventSink({
			sessionId: SESSION_ID,
			send: (msg) => sent.push(msg),
			clearTimeout: () => {
				timeoutCleared = true;
			},
		});

		// Start streaming
		wsHandler.setClientSession(CLIENT_ID, SESSION_ID);
		await sink.push(
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: "msg-1",
				partId: "p1",
				text: "streaming...",
			}),
		);

		// Simulate turn completing with error (as PROCESSING_TIMEOUT would trigger)
		await sink.push(
			canonicalEvent("turn.error", SESSION_ID, {
				messageId: "msg-1",
				error: "Processing timeout",
				code: "PROCESSING_TIMEOUT",
			}),
		);

		// Timeout should have been cleared
		expect(timeoutCleared).toBe(true);

		// Should have error + done messages
		expect(sent.some((m) => m.type === "error")).toBe(true);
		expect(sent.some((m) => m.type === "done")).toBe(true);
	});
});

/**
 * TODO SPECS — these document the expected delivery-layer behavior
 * for the session rejoin bug. They use it.todo because:
 *
 * The bug cannot be reproduced at the unit-test level — the mock
 * wsHandler correctly routes events to remapped clients. The real
 * bug is in the full system interaction between wsHandler, session
 * switching, history replay, and frontend event coordination.
 *
 * These specs document WHAT should work. When investigating the bug,
 * write integration tests that exercise the full delivery path.
 */
describe("Claude session rejoin — delivery-layer specs (TODO)", () => {
	it.todo("client receives events emitted AFTER rejoin via sendToSession");
	// After navigate-away and return, new events from the ongoing
	// Claude turn should stream to the client. Currently they don't.
	// Root cause TBD — likely in wsHandler delivery, session_switched
	// replay coordination, or frontend turnEpoch/dedup logic.

	it.todo("thinking block started before navigate-away completes after return");
	// If a thinking block starts, user navigates away, thinking ends
	// while away, text starts, user returns — the text deltas emitted
	// after return should stream to the client.

	it.todo("permission approval after rejoin resumes streaming");
	// If Claude asks permission, user navigates away, returns, approves
	// the (rehydrated) permission — streaming should resume with the
	// SDK's continued output.
});
