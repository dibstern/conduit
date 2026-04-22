// test/unit/persistence/events.test.ts
import { describe, expect, it } from "vitest";
import type {
	CanonicalEvent,
	EventMetadata,
	MessageCreatedPayload,
	SessionCreatedPayload,
	StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	CANONICAL_EVENT_TYPES,
	createCommandId,
	createEventId,
} from "../../../src/lib/persistence/events.js";

describe("Canonical Event Types", () => {
	it("exports all 20 canonical event types", () => {
		expect(CANONICAL_EVENT_TYPES).toHaveLength(20);
		expect(CANONICAL_EVENT_TYPES).toContain("message.created");
		expect(CANONICAL_EVENT_TYPES).toContain("text.delta");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.start");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.delta");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.end");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.started");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.running");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.completed");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.input_updated");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.completed");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.error");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.interrupted");
		expect(CANONICAL_EVENT_TYPES).toContain("session.created");
		expect(CANONICAL_EVENT_TYPES).toContain("session.renamed");
		expect(CANONICAL_EVENT_TYPES).toContain("session.status");
		expect(CANONICAL_EVENT_TYPES).toContain("session.provider_changed");
		expect(CANONICAL_EVENT_TYPES).toContain("permission.asked");
		expect(CANONICAL_EVENT_TYPES).toContain("permission.resolved");
		expect(CANONICAL_EVENT_TYPES).toContain("question.asked");
		expect(CANONICAL_EVENT_TYPES).toContain("question.resolved");
	});

	it("createEventId generates a prefixed UUID", () => {
		const id = createEventId();
		expect(id).toMatch(/^evt_[0-9a-f-]{36}$/);
	});

	it("createCommandId generates a prefixed UUID", () => {
		const id = createCommandId();
		expect(id).toMatch(/^cmd_[0-9a-f-]{36}$/);
	});

	it("CanonicalEvent type constrains event_type to known values", () => {
		const event: CanonicalEvent = {
			eventId: createEventId(),
			sessionId: "s1",
			type: "message.created",
			data: {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload,
			metadata: {},
			provider: "opencode",
			createdAt: Date.now(),
		};
		expect(event.type).toBe("message.created");
	});

	it("StoredEvent extends CanonicalEvent with sequence and streamVersion", () => {
		const stored: StoredEvent = {
			sequence: 1,
			eventId: createEventId(),
			sessionId: "s1",
			streamVersion: 0,
			type: "session.created",
			data: {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload,
			metadata: {},
			provider: "opencode",
			createdAt: Date.now(),
		};
		expect(stored.sequence).toBe(1);
		expect(stored.streamVersion).toBe(0);
	});

	it("EventMetadata supports optional causality fields", () => {
		const meta: EventMetadata = {
			commandId: createCommandId(),
			causationEventId: createEventId(),
			correlationId: createCommandId(),
			adapterKey: "opencode-main",
			providerTurnId: "turn-123",
		};
		expect(meta.commandId).toBeDefined();
		expect(meta.adapterKey).toBe("opencode-main");
	});

	it("EventMetadata can be empty", () => {
		const meta: EventMetadata = {};
		expect(meta).toEqual({});
	});
});
