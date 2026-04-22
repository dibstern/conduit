import { describe, expect, it } from "vitest";
import { PersistenceError } from "../../../../src/lib/persistence/errors.js";
import {
	assertHandledOrIgnored,
	decodeJson,
	encodeJson,
	isEventType,
	type Projector,
} from "../../../../src/lib/persistence/projectors/projector.js";
import { makeStored } from "../../../helpers/persistence-factories.js";

describe("Projector utilities", () => {
	describe("encodeJson", () => {
		it("encodes objects to JSON strings", () => {
			expect(encodeJson({ a: 1 })).toBe('{"a":1}');
		});

		it('returns "null" for undefined', () => {
			expect(encodeJson(undefined)).toBe("null");
		});

		it("encodes null as the string null", () => {
			expect(encodeJson(null)).toBe("null");
		});
	});

	describe("decodeJson", () => {
		it("parses valid JSON", () => {
			expect(decodeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
		});

		it("returns undefined for null input", () => {
			expect(decodeJson(null)).toBeUndefined();
		});

		it("returns undefined for empty string", () => {
			expect(decodeJson("")).toBeUndefined();
		});

		it("returns undefined for invalid JSON", () => {
			expect(decodeJson("{bad json")).toBeUndefined();
		});
	});

	describe("isEventType", () => {
		it("returns true when event type matches", () => {
			const event = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "hello",
			});
			expect(isEventType(event, "text.delta")).toBe(true);
		});

		it("returns false when event type does not match", () => {
			const event = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "hello",
			});
			expect(isEventType(event, "session.created")).toBe(false);
		});
	});

	describe("assertHandledOrIgnored", () => {
		it("does not throw for events the projector does not handle", () => {
			const projector: Projector = {
				name: "test-projector",
				handles: ["session.created"],
				project() {},
			};
			const event = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "hello",
			});
			expect(() => assertHandledOrIgnored(projector, event)).not.toThrow();
		});

		it("throws PersistenceError for events the projector declares it handles", () => {
			const projector: Projector = {
				name: "test-projector",
				handles: ["text.delta"],
				project() {},
			};
			const event = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "hello",
			});
			expect(() => assertHandledOrIgnored(projector, event)).toThrow(
				PersistenceError,
			);
		});
	});
});
