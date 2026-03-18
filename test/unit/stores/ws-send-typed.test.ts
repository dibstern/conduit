import { describe, it } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { RequestId } from "../../../src/lib/shared-types.js";

/**
 * Compile-time type safety tests for wsSendTyped.
 */
describe("wsSendTyped compile-time safety", () => {
	type WsSendTyped = <T extends keyof PayloadMap>(
		type: T,
		payload: PayloadMap[T],
	) => void;
	const wsSendTyped: WsSendTyped = (() => {}) as WsSendTyped;

	it("accepts correct payloads (compile-time verified)", () => {
		wsSendTyped("cancel", {});
		wsSendTyped("new_session", {});
		wsSendTyped("new_session", { requestId: "id" as RequestId });
		wsSendTyped("new_session", { title: "test" });
		wsSendTyped("message", { text: "hello" });
		wsSendTyped("switch_session", { sessionId: "s1" });
	});

	it("rejects wrong payload shapes (compile-time verified)", () => {
		// @ts-expect-error — wrong payload shape for new_session
		wsSendTyped("new_session", { text: "wrong" });
		// @ts-expect-error — missing required field for message
		wsSendTyped("message", {});
		// @ts-expect-error — plain string is not RequestId (branded type)
		wsSendTyped("new_session", { requestId: "plain-string" });
		// @ts-expect-error — unknown message type
		wsSendTyped("nonexistent_type", {});
	});
});
