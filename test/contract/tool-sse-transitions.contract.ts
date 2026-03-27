// ─── Tool SSE Transition Validation ───────────────────────────────────────
// Observes REAL tool lifecycle transitions via SSE from a live OpenCode
// instance. Sends a prompt that triggers tool use, then validates that
// the SSE event stream delivers the expected state transitions in order.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolStatus } from "../../src/lib/shared-types.js";
import {
	authHeaders,
	checkServerHealth,
	OPENCODE_BASE_URL,
} from "./helpers/server-connection.js";
import {
	collectSSEEvents,
	createTestSession,
	deleteTestSession,
	getSessionMessages,
	sendPrompt,
	type TestSession,
} from "./helpers/session-helpers.js";

let serverAvailable = false;
let testSession: TestSession | null = null;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
	}
});

afterAll(async () => {
	if (testSession) {
		await deleteTestSession(testSession.id);
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolPartEvent {
	callID: string;
	tool: string;
	status: ToolStatus;
	hasInput: boolean;
	hasOutput: boolean;
	hasMetadata: boolean;
	timestamp: number;
}

interface SSEEvent {
	type: string;
	properties: Record<string, unknown>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract tool part events from a raw SSE event stream for a specific session. */
function extractToolPartEvents(
	events: SSEEvent[],
	sessionId: string,
): ToolPartEvent[] {
	const results: ToolPartEvent[] = [];

	for (const evt of events) {
		if (evt.type !== "message.part.updated") continue;
		const props = evt.properties;
		const part = props["part"] as Record<string, unknown> | undefined;
		if (!part || part["type"] !== "tool") continue;

		// Filter to our session
		const evtSession =
			(props["sessionID"] as string) ?? (part["sessionID"] as string) ?? "";
		if (!evtSession.startsWith(sessionId.slice(0, 12))) continue;

		const state = part["state"] as Record<string, unknown> | undefined;
		results.push({
			callID: (part["callID"] as string) ?? "",
			tool: (part["tool"] as string) ?? "",
			status: (state?.["status"] as ToolStatus) ?? ("unknown" as ToolStatus),
			hasInput: state?.["input"] != null,
			hasOutput: !!(state?.["output"] as string),
			hasMetadata: state?.["metadata"] != null,
			timestamp: Date.now(),
		});
	}

	return results;
}

/** Group tool events by callID to trace per-tool lifecycle. */
function groupByCallID(events: ToolPartEvent[]): Map<string, ToolPartEvent[]> {
	const groups = new Map<string, ToolPartEvent[]>();
	for (const evt of events) {
		const existing = groups.get(evt.callID) ?? [];
		existing.push(evt);
		groups.set(evt.callID, existing);
	}
	return groups;
}

/** Valid forward transitions per the documented state machine. */
const VALID_FORWARD: Record<string, Set<string>> = {
	pending: new Set(["running", "completed", "error"]),
	running: new Set(["running", "completed", "error"]), // running→running is valid (metadata updates)
	completed: new Set(["completed"]), // completed→completed (idempotent re-delivery)
	error: new Set(["error"]), // error→error (idempotent re-delivery)
};

/** Validate that a sequence of statuses follows valid transitions. */
function validateTransitionSequence(statuses: ToolStatus[]): {
	valid: boolean;
	violations: string[];
} {
	const violations: string[] = [];
	for (let i = 1; i < statuses.length; i++) {
		const from = statuses[i - 1];
		const to = statuses[i];
		if (from === undefined || to === undefined) continue;
		const allowed = VALID_FORWARD[from];
		if (!allowed?.has(to)) {
			violations.push(`${from} → ${to} (at index ${i})`);
		}
	}
	return { valid: violations.length === 0, violations };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Tool SSE Transition Validation (live)", () => {
	it("SSE event stream is accessible", async () => {
		if (skipIfNoServer()) return;

		const events = await collectSSEEvents("/event", {
			timeoutMs: 3_000,
			maxEvents: 5,
		});
		// Should at least get heartbeats or a connected event
		expect(events).toBeDefined();
	});

	describe("tool lifecycle via prompt", () => {
		let toolEvents: ToolPartEvent[] = [];
		let toolGroups: Map<string, ToolPartEvent[]> = new Map();

		it("sends a prompt and captures tool events via SSE", async () => {
			if (skipIfNoServer()) return;

			// Create a fresh test session
			testSession = await createTestSession("tool-transition-test");
			expect(testSession.id).toBeTruthy();

			// Start SSE collection BEFORE sending the prompt
			const ssePromise = collectSSEEvents("/event", {
				timeoutMs: 60_000,
				maxEvents: 500,
				until: (evt) => {
					// Stop when we see session.status:idle after some tool events
					if (evt.type === "session.status") {
						const props = evt.properties;
						const status = props["status"] as
							| Record<string, unknown>
							| undefined;
						if (status?.["type"] === "idle" && toolEvents.length > 0) {
							return true;
						}
					}
					// Track tool events in real-time for the until check
					if (evt.type === "message.part.updated") {
						const part = evt.properties["part"] as
							| Record<string, unknown>
							| undefined;
						if (part?.["type"] === "tool") {
							// Simplified check - just count
							toolEvents.push({
								callID: "",
								tool: "",
								status: "pending",
								hasInput: false,
								hasOutput: false,
								hasMetadata: false,
								timestamp: Date.now(),
							});
						}
					}
					return false;
				},
			});

			// Send a prompt that will trigger at least one tool (e.g., Read)
			// Using a simple prompt that forces tool use
			await sendPrompt(
				testSession.id,
				"Read the file at /tmp/.conduit-tool-transition-test and tell me what it says. Create it first with the content 'tool-transition-test' if it doesn't exist. Use the bash tool.",
			);

			// Wait for SSE collection to complete
			const events = await ssePromise;

			// Reset and properly extract
			toolEvents = extractToolPartEvents(events, testSession.id);
			toolGroups = groupByCallID(toolEvents);

			// Must have captured some tool events
			expect(toolEvents.length).toBeGreaterThan(0);
			expect(toolGroups.size).toBeGreaterThan(0);
		}, 90_000);

		it("every tool starts with pending or running", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				const firstStatus = events[0]?.status;
				expect(
					firstStatus === "pending" || firstStatus === "running",
					`Tool ${callID} (${events[0]?.tool}) starts with ${firstStatus}, expected pending or running`,
				).toBe(true);
			}
		});

		it("every tool ends in a terminal state (completed or error)", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				const lastStatus = events[events.length - 1]?.status;
				expect(
					lastStatus === "completed" || lastStatus === "error",
					`Tool ${callID} (${events[0]?.tool}) ends with ${lastStatus}, expected completed or error`,
				).toBe(true);
			}
		});

		it("all transitions follow valid forward order", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				const statuses = events.map((e) => e.status);
				const { valid, violations } = validateTransitionSequence(statuses);
				expect(
					valid,
					`Tool ${callID} (${events[0]?.tool}) has invalid transitions: ${violations.join(", ")}. Full sequence: ${statuses.join(" → ")}`,
				).toBe(true);
			}
		});

		it("no backward transitions occur (completed/error → pending/running)", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			const BACKWARD: Record<string, Set<string>> = {
				completed: new Set(["pending", "running"]),
				error: new Set(["pending", "running"]),
			};

			for (const [callID, events] of toolGroups) {
				const statuses = events.map((e) => e.status);
				for (let i = 1; i < statuses.length; i++) {
					const from = statuses[i - 1];
					const to = statuses[i];
					if (from === undefined || to === undefined) continue;
					const disallowed = BACKWARD[from];
					if (disallowed?.has(to)) {
						expect.fail(
							`Tool ${callID} (${events[0]?.tool}) has backward transition: ${from} → ${to} at index ${i}`,
						);
					}
				}
			}
		});

		it("completed tools have output or error content", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				const lastEvent = events.at(-1);
				if (!lastEvent) continue;
				if (lastEvent.status === "completed") {
					expect(
						lastEvent.hasOutput,
						`Completed tool ${callID} (${events[0]?.tool}) should have output`,
					).toBe(true);
				}
			}
		});

		it("running tools have input populated", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				const runningEvents = events.filter((e) => e.status === "running");
				if (runningEvents.length > 0) {
					// At least one running event should have input
					const anyHasInput = runningEvents.some((e) => e.hasInput);
					expect(
						anyHasInput,
						`Tool ${callID} (${events[0]?.tool}) running events should include input`,
					).toBe(true);
				}
			}
		});

		it("callIDs are consistent across status updates for the same tool", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;

			for (const [callID, events] of toolGroups) {
				for (const evt of events) {
					expect(evt.callID).toBe(callID);
				}
			}
		});

		it("REST API final state matches SSE terminal state", async () => {
			if (skipIfNoServer() || !testSession || toolGroups.size === 0) return;

			// Wait a moment for the session to settle
			await new Promise((r) => setTimeout(r, 2_000));

			const messages = await getSessionMessages(testSession.id);

			// Extract tool parts from REST messages
			const restTools = new Map<string, { status: string; tool: string }>();
			for (const msg of messages) {
				const parts = (msg as Record<string, unknown>)["parts"] as
					| Array<Record<string, unknown>>
					| undefined;
				if (!parts) continue;
				for (const part of parts) {
					if (part["type"] !== "tool") continue;
					const callID = part["callID"] as string;
					const state = part["state"] as Record<string, unknown> | undefined;
					if (callID && state?.["status"]) {
						restTools.set(callID, {
							status: state["status"] as string,
							tool: (part["tool"] as string) ?? "",
						});
					}
				}
			}

			// Compare SSE terminal state with REST state
			for (const [callID, events] of toolGroups) {
				const lastEvent = events.at(-1);
				if (!lastEvent) continue;
				const sseTerminal = lastEvent.status;
				const restTool = restTools.get(callID);

				if (restTool) {
					expect(
						restTool.status,
						`Tool ${callID} (${events[0]?.tool}): SSE terminal=${sseTerminal}, REST=${restTool.status}`,
					).toBe(sseTerminal);
				}
			}
		}, 30_000);

		it("session becomes idle after all tools complete", async () => {
			if (skipIfNoServer() || !testSession) return;

			// Poll session status
			const deadline = Date.now() + 15_000;
			let lastStatus = "";
			while (Date.now() < deadline) {
				try {
					const statuses = (await (
						await fetch(`${OPENCODE_BASE_URL}/session/status`, {
							headers: { Accept: "application/json", ...authHeaders() },
						})
					).json()) as Record<string, { type: string }>;
					const sessionStatus = statuses[testSession.id];
					if (sessionStatus) {
						lastStatus = sessionStatus.type;
						if (lastStatus === "idle") break;
					} else {
						// Session not in status map means idle
						lastStatus = "idle";
						break;
					}
				} catch {
					// ignore
				}
				await new Promise((r) => setTimeout(r, 500));
			}
			expect(lastStatus).toBe("idle");
		}, 30_000);
	});

	describe("transition table completeness", () => {
		it("our VALID_TRANSITIONS table covers all ToolStatus values", () => {
			const allStatuses: ToolStatus[] = [
				"pending",
				"running",
				"completed",
				"error",
			];
			for (const status of allStatuses) {
				expect(VALID_FORWARD).toHaveProperty(status);
			}
		});

		it("terminal states have no forward transitions to non-terminal states", () => {
			const terminals: ToolStatus[] = ["completed", "error"];
			const nonTerminals: ToolStatus[] = ["pending", "running"];

			for (const terminal of terminals) {
				for (const nonTerminal of nonTerminals) {
					expect(
						VALID_FORWARD[terminal]?.has(nonTerminal),
						`${terminal} should not transition to ${nonTerminal}`,
					).toBe(false);
				}
			}
		});
	});
});
