import { describe, expect, it, vi } from "vitest";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

describe("makeSessionBackgroundLiveness", () => {
	it("notifies only when a session gains or loses live work", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);

		liveness.record({ sessionId: "one", taskId: "a", kind: "started" });
		liveness.record({ sessionId: "one", taskId: "a", kind: "progress" });
		liveness.record({ sessionId: "one", taskId: "b", kind: "started" });
		liveness.record({ sessionId: "one", taskId: "a", kind: "completed" });
		expect(liveness.hasLiveWork("one")).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);

		liveness.record({ sessionId: "one", taskId: "b", kind: "completed" });
		liveness.record({ sessionId: "one", taskId: "b", kind: "progress" });
		liveness.clear("one");
		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});

	it("clears live work when the SDK session ends", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		liveness.record({ sessionId: "one", taskId: "a", kind: "started" });
		liveness.record({ sessionId: "one", kind: "session-ended" });
		liveness.record({ sessionId: "one", kind: "session-ended" });

		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});
});
