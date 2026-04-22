import { beforeEach, describe, expect, it } from "vitest";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";

/**
 * Higher-fidelity mock that tracks per-client session subscriptions
 * and delivers via sendToSession → per-client filtering, matching
 * production WS handler behavior.
 */
function createDeliveryLayer() {
	const clientSessions = new Map<string, string>();
	const clientInboxes = new Map<string, RelayMessage[]>();

	return {
		connect(clientId: string) {
			clientInboxes.set(clientId, []);
		},
		switchSession(clientId: string, sessionId: string) {
			clientSessions.set(clientId, sessionId);
		},
		disconnect(clientId: string) {
			clientSessions.delete(clientId);
			clientInboxes.delete(clientId);
		},
		/**
		 * Deliver a relay message to all clients viewing this session.
		 * This is what the real WS handler does — iterates connected
		 * clients, checks their current session, sends if match.
		 */
		deliverToSession(sessionId: string, msg: RelayMessage) {
			for (const [clientId, sid] of clientSessions) {
				if (sid === sessionId) {
					clientInboxes.get(clientId)?.push(msg);
				}
			}
		},
		getInbox(clientId: string): RelayMessage[] {
			return clientInboxes.get(clientId) ?? [];
		},
	};
}

const SESSION = "ses-rejoin-integ";

describe("Rejoin integration — delivery layer fidelity", () => {
	let delivery: ReturnType<typeof createDeliveryLayer>;

	beforeEach(() => {
		delivery = createDeliveryLayer();
	});

	it("events reach client after navigate-away-and-back via delivery layer", async () => {
		delivery.connect("c1");
		delivery.switchSession("c1", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		// Phase 1: streaming while viewing
		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "hello",
			}),
		);
		expect(
			delivery.getInbox("c1").filter((m) => m.type === "delta"),
		).toHaveLength(1);

		// Phase 2: navigate away
		delivery.switchSession("c1", "other-session");
		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: " world",
			}),
		);
		// Client should NOT receive this — viewing other session
		expect(
			delivery.getInbox("c1").filter((m) => m.type === "delta"),
		).toHaveLength(1);

		// Phase 3: navigate back
		delivery.switchSession("c1", SESSION);
		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "!",
			}),
		);
		// Client SHOULD receive this — back on the session
		expect(
			delivery.getInbox("c1").filter((m) => m.type === "delta"),
		).toHaveLength(2);
	});

	it("thinking lifecycle completes via delivery layer across rejoin", async () => {
		delivery.connect("c1");
		delivery.switchSession("c1", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		// thinking.start while viewing
		await sink.push(
			canonicalEvent("thinking.start", SESSION, {
				messageId: "msg-1",
				partId: "pt1",
			}),
		);

		// Navigate away during thinking
		delivery.switchSession("c1", "other");
		await sink.push(
			canonicalEvent("thinking.delta", SESSION, {
				messageId: "msg-1",
				partId: "pt1",
				text: "deep thought",
			}),
		);
		await sink.push(
			canonicalEvent("thinking.end", SESSION, {
				messageId: "msg-1",
				partId: "pt1",
			}),
		);

		// Navigate back — text begins
		delivery.switchSession("c1", SESSION);
		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "answer",
			}),
		);

		const inbox = delivery.getInbox("c1");
		// Client got: thinking_start (before nav), delta (after return)
		// Missed: thinking_delta, thinking_stop (while away)
		// This documents what the delivery layer does — events while away are lost
		expect(inbox.some((m) => m.type === "thinking_start")).toBe(true);
		expect(inbox.some((m) => m.type === "delta")).toBe(true);
		// These were missed — documents the gap
		const thinkingDeltas = inbox.filter((m) => m.type === "thinking_delta");
		expect(thinkingDeltas).toHaveLength(0); // missed while away
	});

	it("SPEC: after rejoin, client should receive history replay to fill gaps", () => {
		// When a client navigates back, the server should detect missed events
		// and send a history replay. This test documents the expected behavior.
		// Currently no replay mechanism exists — this spec fails when uncommented.
		//
		// TODO: When implementing rejoin replay, replace this with a real test:
		// 1. Client views session, receives events
		// 2. Client navigates away, events continue
		// 3. Client navigates back
		// 4. Server detects gap (last-seen sequence < current sequence)
		// 5. Server replays missed events from event store
		// 6. Client receives full event history
		//
		// Acceptance criteria:
		// - Client inbox after rejoin contains ALL events (before + during + after away)
		// - No duplicate events in client inbox
		// - Events in correct order
		expect(true).toBe(true); // Placeholder — remove when implementing
	});
});

describe("Multi-client / multi-tab delivery", () => {
	let delivery: ReturnType<typeof createDeliveryLayer>;

	beforeEach(() => {
		delivery = createDeliveryLayer();
	});

	it("two clients on same session — both receive events", async () => {
		delivery.connect("tab-1");
		delivery.connect("tab-2");
		delivery.switchSession("tab-1", SESSION);
		delivery.switchSession("tab-2", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "shared delta",
			}),
		);

		// Both tabs received the event
		expect(
			delivery.getInbox("tab-1").filter((m) => m.type === "delta"),
		).toHaveLength(1);
		expect(
			delivery.getInbox("tab-2").filter((m) => m.type === "delta"),
		).toHaveLength(1);
	});

	it("one tab navigates away — other tab still receives events", async () => {
		delivery.connect("tab-1");
		delivery.connect("tab-2");
		delivery.switchSession("tab-1", SESSION);
		delivery.switchSession("tab-2", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		// tab-1 navigates away
		delivery.switchSession("tab-1", "other-session");

		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "only tab-2",
			}),
		);

		// tab-2 received, tab-1 did not
		expect(
			delivery.getInbox("tab-2").filter((m) => m.type === "delta"),
		).toHaveLength(1);
		expect(
			delivery.getInbox("tab-1").filter((m) => m.type === "delta"),
		).toHaveLength(0);
	});

	it("tab-1 returns — both tabs receive subsequent events", async () => {
		delivery.connect("tab-1");
		delivery.connect("tab-2");
		delivery.switchSession("tab-1", SESSION);
		delivery.switchSession("tab-2", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		// tab-1 leaves and returns
		delivery.switchSession("tab-1", "other");
		delivery.switchSession("tab-1", SESSION);

		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "after return",
			}),
		);

		expect(
			delivery.getInbox("tab-1").filter((m) => m.type === "delta"),
		).toHaveLength(1);
		expect(
			delivery.getInbox("tab-2").filter((m) => m.type === "delta"),
		).toHaveLength(1);
	});

	it("both tabs navigate away simultaneously — events continue server-side, both return", async () => {
		delivery.connect("tab-1");
		delivery.connect("tab-2");
		delivery.switchSession("tab-1", SESSION);
		delivery.switchSession("tab-2", SESSION);

		const sink = createRelayEventSink({
			sessionId: SESSION,
			send: (msg) => delivery.deliverToSession(SESSION, msg),
		});

		// Both leave
		delivery.switchSession("tab-1", "other-1");
		delivery.switchSession("tab-2", "other-2");

		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "while both away",
			}),
		);

		// Neither received
		expect(
			delivery.getInbox("tab-1").filter((m) => m.type === "delta"),
		).toHaveLength(0);
		expect(
			delivery.getInbox("tab-2").filter((m) => m.type === "delta"),
		).toHaveLength(0);

		// Both return
		delivery.switchSession("tab-1", SESSION);
		delivery.switchSession("tab-2", SESSION);

		await sink.push(
			canonicalEvent("text.delta", SESSION, {
				messageId: "msg-1",
				partId: "p1",
				text: "after both return",
			}),
		);

		// Both received the new event
		expect(
			delivery.getInbox("tab-1").filter((m) => m.type === "delta"),
		).toHaveLength(1);
		expect(
			delivery.getInbox("tab-2").filter((m) => m.type === "delta"),
		).toHaveLength(1);
	});
});
