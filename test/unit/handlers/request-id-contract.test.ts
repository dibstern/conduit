import { describe, expect, it } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { RelayMessage, RequestId } from "../../../src/lib/shared-types.js";

/**
 * Contract tests for the requestId correlation protocol.
 *
 * These verify that both sides of the protocol (client→server payload and
 * server→client response) agree on the field name and branded type.
 * If someone renames or removes requestId on one side, these tests fail
 * to compile — catching the drift before it reaches runtime.
 */
describe("requestId protocol contract", () => {
	it("PayloadMap['new_session'] accepts requestId as RequestId", () => {
		const payload: PayloadMap["new_session"] = {
			requestId: "test-uuid" as RequestId,
		};
		expect(payload.requestId).toBe("test-uuid");
	});

	it("PayloadMap['new_session'] allows omitting requestId", () => {
		const payload: PayloadMap["new_session"] = { title: "test" };
		expect(payload.requestId).toBeUndefined();
	});

	it("session_switched RelayMessage accepts requestId as RequestId", () => {
		const msg: Extract<RelayMessage, { type: "session_switched" }> = {
			type: "session_switched",
			id: "sess-1",
			sessionId: "sess-1",
			requestId: "test-uuid" as RequestId,
		};
		expect(msg.requestId).toBe("test-uuid");
	});

	it("session_switched RelayMessage allows omitting requestId", () => {
		const msg: Extract<RelayMessage, { type: "session_switched" }> = {
			type: "session_switched",
			id: "sess-1",
			sessionId: "sess-1",
		};
		expect(msg.requestId).toBeUndefined();
	});

	it("RequestId is not assignable from plain string (branded)", () => {
		// @ts-expect-error — plain string is not assignable to RequestId
		const _payload: PayloadMap["new_session"] = { requestId: "plain-string" };
		expect(_payload.requestId).toBe("plain-string");
	});
});
