import { describe, expect, it } from "vitest";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { translateDomainEventToRelay } from "../../../src/lib/relay/domain-event-to-relay.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";

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
		const failure = translateDomainEventToRelay(
			canonicalEvent("turn.error", "s1", { messageId: "m1", error: "failed" }),
		);
		expect(failure).toMatchObject({
			kind: "emit",
			messages: [
				{
					type: "done",
					code: 1,
					error: "failed",
					alertId: '["s1","m1","error","failed"]',
				},
			],
		});
		expect(
			translateDomainEventToRelay(
				canonicalEvent("turn.interrupted", "s1", { messageId: "m1" }),
			),
		).toMatchObject({
			kind: "emit",
			messages: [{ type: "done", alertId: '["s1","m1","done"]' }],
		});
		// A retry is transient shell-row status, never an alert.
		expect(
			translateDomainEventToRelay(
				canonicalEvent("session.status", "s1", {
					sessionId: "s1",
					status: "retry",
				}),
			),
		).toMatchObject({ kind: "silent" });
	});
	it("keeps T1 replay identity after T2 and gives T2 its own identity", () => {
		const first = canonicalEvent("turn.completed", "s1", { messageId: "m1" });
		const second = canonicalEvent("turn.completed", "s1", { messageId: "m2" });
		const translatedFirst = translateDomainEventToRelay(first);
		const translatedSecond = translateDomainEventToRelay(second);
		const replayedFirst = translateDomainEventToRelay(first);
		expect(translatedFirst).toMatchObject({
			kind: "emit",
			messages: expect.arrayContaining([
				{ type: "done", code: 0, alertId: '["s1","m1","done"]' },
			]),
		});
		expect(translatedSecond).toMatchObject({
			kind: "emit",
			messages: expect.arrayContaining([
				{ type: "done", code: 0, alertId: '["s1","m2","done"]' },
			]),
		});
		expect(replayedFirst).toEqual(translatedFirst);
		const reobservedFirst = canonicalEvent("turn.completed", "s1", {
			messageId: "m1",
		});
		expect(translateDomainEventToRelay(reobservedFirst)).toEqual(
			translatedFirst,
		);
	});
});
