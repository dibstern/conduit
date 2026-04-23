import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CommandId, EventId } from "../../../src/lib/persistence/events.js";
import { PermissionId, RequestId } from "../../../src/lib/shared-types.js";

describe("Branded types", () => {
	it("RequestId decodes valid strings", () => {
		const decoded = Schema.decodeUnknownSync(RequestId)("req_abc123");
		expect(typeof decoded).toBe("string");
	});

	it("RequestId rejects non-strings", () => {
		expect(() => Schema.decodeUnknownSync(RequestId)(42)).toThrow();
	});

	it("PermissionId decodes valid strings", () => {
		const decoded = Schema.decodeUnknownSync(PermissionId)("perm_xyz");
		expect(typeof decoded).toBe("string");
	});

	it("EventId decodes valid strings", () => {
		const decoded = Schema.decodeUnknownSync(EventId)("evt_abc");
		expect(typeof decoded).toBe("string");
	});

	it("CommandId decodes valid strings", () => {
		const decoded = Schema.decodeUnknownSync(CommandId)("cmd_abc");
		expect(typeof decoded).toBe("string");
	});

	it("branded types are assignable where expected", () => {
		// Compile-time check: branded values work in typed positions
		const rid: RequestId = Schema.decodeUnknownSync(RequestId)("req_1");
		const pid: PermissionId = Schema.decodeUnknownSync(PermissionId)("perm_1");
		expect(rid).toBe("req_1");
		expect(pid).toBe("perm_1");
	});
});
