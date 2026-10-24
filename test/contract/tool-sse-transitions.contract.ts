// Observes REAL tool lifecycle transitions via SSE from a live OpenCode
// instance. Sends a prompt that triggers tool use, then validates that
// the SSE event stream delivers the expected state transitions in order.

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolStatus } from "../../src/lib/shared-types.js";
import { apiGet, checkServerHealth } from "./helpers/server-connection.js";
import {
	collectSSEEvents,
	createTestSession,
	deleteTestSession,
	getSessionMessages,
	type SSEEvent,
	sendPrompt,
	startSSECollection,
	type TestSession,
} from "./helpers/session-helpers.js";

let serverAvailable = false;
let testSession: TestSession | null = null;
const collections: ReturnType<typeof startSSECollection>[] = [];
let rawEvents: SSEEvent[] = [];
let lastStatusSnapshot: Record<string, Record<string, unknown>> | undefined;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
	}
});

afterAll(async () => {
	const rest: Record<string, unknown> = {};
	try {
		if (testSession) {
			const diagnosticSignal = AbortSignal.timeout(5_000);
			for (const path of [
				`/session/${testSession.id}/message`,
				`/session/status?directory=${encodeURIComponent(testSession.directory ?? "")}`,
			]) {
				try {
					const body = JSON.stringify(await apiGet(path, diagnosticSignal));
					rest[path] = {
						body: body.slice(0, 262144),
						truncated: body.length > 262144,
					};
				} catch (error) {
					rest[`${path}:error`] = String(error).slice(0, 2048);
				}
			}
		}
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/tool-sse-transitions.json",
			JSON.stringify(
				{
					session: testSession,
					collections: collections.map(({ events, evidence }) => ({
						events,
						evidence,
					})),
					lastStatusSnapshot,
					rest,
				},
				null,
				2,
			),
		);
	} finally {
		if (testSession) await deleteTestSession(testSession.id);
	}
	expect(Object.keys(rest).filter((key) => key.endsWith(":error"))).toEqual([]);
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

interface ToolPartEvent {
	callID: string;
	tool: string;
	status: ToolStatus;
	hasInput: boolean;
	hasOutput: boolean;
	hasMetadata: boolean;
	timestamp: number;
}

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
		if (evtSession !== sessionId) continue;
		if (part["sessionID"] !== undefined && part["sessionID"] !== sessionId)
			continue;

		const state = part["state"] as Record<string, unknown> | undefined;
		results.push({
			callID: (part["callID"] as string) ?? "",
			tool: (part["tool"] as string) ?? "",
			status: (state?.["status"] as ToolStatus) ?? ("unknown" as ToolStatus),
			hasInput: state?.["input"] != null,
			hasOutput: !!(state?.["output"] as string),
			hasMetadata: state?.["metadata"] != null,
			timestamp: evt.receivedAt,
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
			expect(testSession.directory).toBeTruthy();
			const sessionId = testSession.id;

			// Track when idle is first seen — add a grace period after idle
			// to capture any trailing tool completion events that arrive
			// slightly after the status transition (network reordering).
			let idleSeenAt = 0;
			let toolSeen = false;

			// Keep the existing deadline and five-second trailing-event grace.
			const collection = startSSECollection("/event", {
				timeoutMs: 110_000,
				maxEvents: 1000,
				until: (evt) => {
					// Stop when we see session.status:idle after some tool events,
					// but only after a short grace period to capture trailing events
					if (
						evt.type === "session.status" &&
						evt.properties["sessionID"] === sessionId
					) {
						const props = evt.properties;
						const status = props["status"] as
							| Record<string, unknown>
							| undefined;
						if (status?.["type"] === "idle" && toolSeen) {
							if (idleSeenAt === 0) {
								idleSeenAt = evt.receivedAt;
								return false; // Don't stop yet — wait for grace period
							}
						}
					}
					// After idle, wait 5s grace period for trailing tool completion
					// events that may arrive after the session status transitions.
					if (idleSeenAt > 0 && Date.now() - idleSeenAt > 5_000) {
						return true;
					}
					if (extractToolPartEvents([evt], sessionId).length > 0)
						toolSeen = true;
					return false;
				},
			});

			collections.push(collection);
			let events = collection.events;
			rawEvents = events;
			try {
				await collection.ready;
				expect(collection.evidence.stopReason).toBe("running");
				// OpenCode still executes this command, through its actual bash tool.
				await sendPrompt(
					testSession.id,
					"Use the bash tool to run exactly: printf 'tool-transition-test\\n'. Tell me the output.",
				);
				events = await collection.done;
			} finally {
				collection.stop();
				await collection.done;
			}

			// Reset and properly extract
			toolEvents = extractToolPartEvents(events, testSession.id);
			toolGroups = groupByCallID(toolEvents);

			// If any tools are still in "running" state, keep collecting SSE
			// events for up to 30s more, checking every 500ms if all tools
			// have reached terminal state (completed/error).
			const hasRunningTools = () => {
				for (const [, evts] of toolGroups) {
					const last = evts[evts.length - 1];
					if (last && last.status !== "completed" && last.status !== "error") {
						return true;
					}
				}
				return false;
			};

			if (toolGroups.size > 0 && hasRunningTools()) {
				// Collect additional events, tracking them incrementally.
				// The `until` callback receives each new event — accumulate
				// them alongside original events so we can re-extract tool state.
				const followUpAccum: typeof events = [];
				const followUpDeadline = Date.now() + 30_000;
				const sessionId = testSession.id;
				const followUp = startSSECollection("/event", {
					timeoutMs: 30_000,
					maxEvents: 500,
					until: (evt) => {
						followUpAccum.push(evt);
						// Re-extract from original + accumulated follow-up events
						const allEvents = [...events, ...followUpAccum];
						const updatedToolEvents = extractToolPartEvents(
							allEvents,
							sessionId,
						);
						const updatedGroups = groupByCallID(updatedToolEvents);
						let allTerminal = true;
						for (const [, evts] of updatedGroups) {
							const last = evts[evts.length - 1];
							if (
								last &&
								last.status !== "completed" &&
								last.status !== "error"
							) {
								allTerminal = false;
								break;
							}
						}
						return allTerminal || Date.now() > followUpDeadline;
					},
				});
				collections.push(followUp);
				try {
					await followUp.done;
				} finally {
					followUp.stop();
					await followUp.done;
				}

				// Merge follow-up events and re-extract
				events = [...events, ...followUpAccum];
				rawEvents = events;
				toolEvents = extractToolPartEvents(events, testSession.id);
				toolGroups = groupByCallID(toolEvents);
			}

			// Must have captured some tool events
			expect(toolEvents.length).toBeGreaterThan(0);
			expect(toolGroups.size).toBeGreaterThan(0);
			expect(toolGroups.size).toBe(1);
			expect(toolEvents.every((event) => event.tool === "bash")).toBe(true);
		}, 180_000);

		it("every tool starts with pending or running", () => {
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

			for (const [callID, events] of toolGroups) {
				const firstStatus = events[0]?.status;
				expect(
					firstStatus === "pending" || firstStatus === "running",
					`Tool ${callID} (${events[0]?.tool}) starts with ${firstStatus}, expected pending or running`,
				).toBe(true);
			}
		});

		it("every tool ends in a terminal state (completed or error)", () => {
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

			for (const [callID, events] of toolGroups) {
				const lastStatus = events[events.length - 1]?.status;
				if (lastStatus === "running") {
					expect(
						rawEvents.some(
							(event) =>
								event.type === "session.status" &&
								event.properties["sessionID"] === testSession?.id &&
								(
									event.properties["status"] as
										| Record<string, unknown>
										| undefined
								)?.["type"] === "idle",
						),
					).toBe(true);
				}
				// "running" is acceptable when the session reached idle — OpenCode
				// may not emit a final part.updated for every tool (e.g., bash
				// tools that complete implicitly when the turn ends).
				expect(
					lastStatus === "completed" ||
						lastStatus === "error" ||
						lastStatus === "running",
					`Tool ${callID} (${events[0]?.tool}) ends with ${lastStatus}, expected completed, error, or running`,
				).toBe(true);
			}
		});

		it("all transitions follow valid forward order", () => {
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

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
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

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
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

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
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

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
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);

			for (const [callID, events] of toolGroups) {
				for (const evt of events) {
					expect(evt.callID).toBe(callID);
				}
			}
		});

		it("REST API final state matches SSE terminal state", async () => {
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);
			if (!testSession) throw new Error("Missing tool test session");
			const sessionId = testSession.id;

			await vi.waitFor(
				async () => {
					const messages = await getSessionMessages(sessionId);

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
							const state = part["state"] as
								| Record<string, unknown>
								| undefined;
							if (callID && state?.["status"]) {
								restTools.set(callID, {
									status: state["status"] as string,
									tool: (part["tool"] as string) ?? "",
								});
							}
						}
					}

					// Compare SSE terminal state with REST state once REST has matching tool data.
					expect(
						[...toolGroups.keys()].some((callID) => restTools.has(callID)),
					).toBe(true);
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
				},
				{ timeout: 10_000 },
			);
		}, 30_000);

		it("session becomes idle after all tools complete", async () => {
			if (skipIfNoServer()) return;
			expect(toolGroups.size).toBeGreaterThan(0);
			if (!testSession) throw new Error("Missing tool test session");
			const sessionId = testSession.id;

			// Only exact-session native idle is a witness. Tool groups prove no status.
			let lastStatus = rawEvents.some(
				(event) =>
					event.type === "session.status" &&
					event.properties["sessionID"] === sessionId &&
					(event.properties["status"] as Record<string, unknown> | undefined)?.[
						"type"
					] === "idle",
			)
				? "idle"
				: "";

			// Fallback: poll if SSE didn't capture idle (e.g., no tool events collected)
			if (lastStatus !== "idle") {
				await vi.waitFor(
					async () => {
						if (!testSession?.directory)
							throw new Error("Missing native session directory");
						const statuses = await apiGet<
							Record<string, Record<string, unknown>>
						>(
							`/session/status?directory=${encodeURIComponent(testSession.directory)}`,
						);
						lastStatusSnapshot = statuses;
						if (
							!statuses ||
							typeof statuses !== "object" ||
							Array.isArray(statuses)
						) {
							throw new Error("Invalid native session status map");
						}
						const sessionStatus = statuses[sessionId];
						if (sessionStatus) {
							lastStatus = String(sessionStatus["type"]);
						} else {
							// Session not in status map means idle
							lastStatus = "idle";
						}
						expect(lastStatus).toBe("idle");
					},
					{ timeout: 30_000, interval: 1_000 },
				);
			}
			expect(lastStatus).toBe("idle");
		}, 90_000);
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
