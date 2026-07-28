import { describe, expect, it } from "vitest";
import {
	CANONICAL_EVENT_TYPES,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { translateDomainEventToRelay } from "../../../src/lib/relay/domain-event-to-relay.js";

describe("domain-event relay translation exhaustiveness", () => {
	// These are the event types handled in the switch statement.
	// Keep this list in sync with translateDomainEventToRelay().
	const HANDLED_TYPES = new Set([
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.input_updated",
		"tool.completed",
		"file.attached",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"turn.model_resolved",
		"session.status",
		"session.compaction",
		"message.created",
		"session.created",
		"session.renamed",
		"session.provider_changed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	]);

	it("handles every canonical event type", () => {
		const missing = CANONICAL_EVENT_TYPES.filter((t) => !HANDLED_TYPES.has(t));
		expect(missing).toEqual([]);
	});

	it("keeps turn.model_resolved on the persistence and ws-rpc path", () => {
		const result = translateDomainEventToRelay(
			canonicalEvent("turn.model_resolved", "session-1", {
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5",
				actualModel: "claude-sonnet-5",
			}),
		);

		expect(result).toEqual({
			kind: "silent",
			reason: "persistence/ws-rpc-only event",
		});
	});

	it("HANDLED_TYPES does not contain stale entries", () => {
		const stale = [...HANDLED_TYPES].filter(
			(t) =>
				!CANONICAL_EVENT_TYPES.includes(
					t as (typeof CANONICAL_EVENT_TYPES)[number],
				),
		);
		expect(stale).toEqual([]);
	});
});
