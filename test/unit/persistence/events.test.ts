// test/unit/persistence/events.test.ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
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
		{},
		{ parentId: "owner" },
		{ parentId: "source", sideThread: true, forkPointEvent: "boundary" },
		{ forkedFrom: "source" },
	])("round-trips flat session.created placement %j", (placement) => {
		const event = canonicalEvent("session.created", "session", {
			sessionId: "session",
			title: "Session",
			provider: "claude",
			...placement,
		});
		const encoded = Schema.encodeSync(CanonicalEventSchema)(event);
		expect(Schema.decodeUnknownSync(CanonicalEventSchema)(encoded)).toEqual(
			event,
		);
	});

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
});
