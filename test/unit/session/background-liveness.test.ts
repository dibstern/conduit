import { describe, expect, it, vi } from "vitest";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

describe("makeSessionBackgroundLiveness", () => {
	it("notifies only when a snapshot flips a session between live and idle", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);

		liveness.record({ sessionId: "one", kind: "snapshot", taskIds: ["a"] });
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			taskIds: ["a", "b"],
		});
		liveness.record({ sessionId: "one", kind: "snapshot", taskIds: ["b"] });
		expect(liveness.hasLiveWork("one")).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);

		liveness.record({ sessionId: "one", kind: "snapshot", taskIds: [] });
		liveness.record({ sessionId: "one", kind: "snapshot", taskIds: [] });
		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});

	it("clears live work when the SDK session ends", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		liveness.record({ sessionId: "one", kind: "snapshot", taskIds: ["a"] });
		liveness.record({ sessionId: "one", kind: "session-ended" });
		liveness.record({ sessionId: "one", kind: "session-ended" });

		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});
});
