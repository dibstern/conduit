// test/unit/persistence/events.test.ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type {
	CanonicalEvent,
	EventMetadata,
	MessageCreatedPayload,
	SessionCreatedPayload,
	StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	CanonicalEventSchema,
	canonicalEvent,
	createCommandId,
	createEventId,
} from "../../../src/lib/persistence/events.js";
import { makeStored } from "../../helpers/persistence-factories.js";

describe("Stored event factory", () => {
	it("rejects a missing required tool input through append's schema", () => {
		expect(() =>
			// @ts-expect-error Deliberately omit input to exercise factory validation.
			makeStored("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "Bash",
				callId: "call1",
			}),
		).toThrow();
	});
});

describe("Canonical Event Types", () => {
	it.each([
		"/repo/worktree",
		null,
	])("does not lose a workspace hint path=%s in canonical round-trip", (path) => {
		const event = canonicalEvent("session.workspace_hint_changed", "s1", {
			path,
		});
		const encoded = Schema.encodeSync(CanonicalEventSchema)(event);
		expect(Schema.decodeUnknownSync(CanonicalEventSchema)(encoded)).toEqual(
			event,
		);
	});

	it.each([
		"session.settled",
		"session.unsettled",
		"session.pinned",
		"session.unpinned",
		"session.unsnoozed",
	] as const)("round-trips %s", (type) => {
		const event = canonicalEvent(type, "s1", { sessionId: "s1" });
		const encoded = Schema.encodeSync(CanonicalEventSchema)(event);
		expect(Schema.decodeUnknownSync(CanonicalEventSchema)(encoded)).toEqual(
			event,
		);
	});

	it.each([null, 12345])("round-trips a snooze with until=%s", (until) => {
		const event = canonicalEvent("session.snoozed", "s1", {
			sessionId: "s1",
			until,
		});
		const encoded = Schema.encodeSync(CanonicalEventSchema)(event);
		expect(Schema.decodeUnknownSync(CanonicalEventSchema)(encoded)).toEqual(
			event,
		);
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
			projectId: "test-project",
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
