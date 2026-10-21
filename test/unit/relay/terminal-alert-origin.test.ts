import { describe, expect, it } from "vitest";
import { EventId } from "../../../src/lib/contracts/stored-event.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import { turnEndedAlert } from "../../../src/lib/relay/turn-ended-alert.js";

describe("terminal alert origins", () => {
	it("gives raw legacy failures an observation identity instead of suppressing them", () => {
		const translator = createTranslator();
		const result = translator.translate({
			type: "session.error",
			properties: {
				sessionID: "s1",
				error: { name: "UnknownError", data: { message: "failed" } },
			},
		});
		expect(result).toMatchObject({
			ok: true,
			messages: [{ type: "done", code: 1, alertId: expect.any(String) }],
		});
	});
	it("identifies failure and interruption observations without current session state", () => {
		const failure = turnEndedAlert(
			canonicalEvent("turn.error", "s1", { messageId: "m1", error: "failed" }),
		);
		expect(failure).toMatchObject({
			type: "done",
			code: 1,
			error: "failed",
			alertId: '["s1","m1","error","failed"]',
		});
		expect(
			turnEndedAlert(
				canonicalEvent("turn.interrupted", "s1", { messageId: "m1" }),
			),
		).toMatchObject({
			type: "done",
			alertId: '["s1","m1","done"]',
		});
		// A retry is transient shell-row status, never an alert.
		expect(
			turnEndedAlert(
				canonicalEvent("session.status", "s1", {
					sessionId: "s1",
					status: "retry",
				}),
			),
		).toBeUndefined();
	});
	it("keeps T1 replay identity after T2 and gives T2 its own identity", () => {
		const first = canonicalEvent(
			"turn.completed",
			"s1",
			{ messageId: "m1" },
			{ provider: "claude", metadata: { runId: "run-1" } },
		);
		const second = canonicalEvent(
			"turn.completed",
			"s1",
			{ messageId: "m2" },
			{ provider: "claude", metadata: { runId: "run-2" } },
		);
		const translatedFirst = turnEndedAlert(first);
		const translatedSecond = turnEndedAlert(second);
		const replayedFirst = turnEndedAlert(first);
		expect(translatedFirst).toMatchObject({
			type: "done",
			code: 0,
			alertId: '["s1","m1","done"]',
		});
		expect(translatedSecond).toMatchObject({
			type: "done",
			code: 0,
			alertId: '["s1","m2","done"]',
		});
		expect(replayedFirst).toEqual(translatedFirst);
		const reobservedFirst = canonicalEvent(
			"turn.completed",
			"s1",
			{ messageId: "m1" },
			{ provider: "claude", metadata: { runId: "run-1" } },
		);
		expect(turnEndedAlert(reobservedFirst)).toEqual(translatedFirst);
	});
	it("waits for OpenCode's owned idle rather than a tool-step completion", () => {
		expect(
			turnEndedAlert(
				canonicalEvent(
					"turn.completed",
					"s1",
					{ messageId: "tool-step" },
					{ provider: "opencode", metadata: { runId: "run-1" } },
				),
			),
		).toBeUndefined();
		expect(
			turnEndedAlert(
				canonicalEvent(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "idle" },
					{
						provider: "opencode",
						eventId: EventId.make("idle-1"),
						metadata: { runId: "run-1" },
					},
				),
			),
		).toMatchObject({
			type: "done",
			code: 0,
			alertId: '["s1","idle-1","done"]',
		});
	});
});
