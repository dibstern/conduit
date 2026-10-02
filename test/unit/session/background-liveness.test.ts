import { describe, expect, it, vi } from "vitest";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

describe("makeSessionBackgroundLiveness", () => {
	it("notifies only when a snapshot flips a session between live and idle", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);

		liveness.record({ sessionId: "one", kind: "snapshot", taskTypes: ["a"] });
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			taskTypes: ["a", "b"],
		});
		liveness.record({ sessionId: "one", kind: "snapshot", taskTypes: ["b"] });
		expect(liveness.hasLiveWork("one")).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);

		liveness.record({ sessionId: "one", kind: "snapshot", taskTypes: [] });
		liveness.record({ sessionId: "one", kind: "snapshot", taskTypes: [] });
		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});

	it("reports monitoring only while every live task is a watch loop", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		const kindAfter = (taskTypes: string[]) => {
			liveness.record({ sessionId: "one", kind: "snapshot", taskTypes });
			return liveness.backgroundWork("one");
		};

		expect(kindAfter(["local_bash", "monitor_mcp"])).toBe("monitoring");
		expect(kindAfter(["local_bash", "local_agent"])).toBe("working");
		expect(kindAfter(["monitor_ws"])).toBe("monitoring");
		expect(kindAfter([])).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(4);
	});

	it("clears live work when the SDK session ends", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		liveness.record({ sessionId: "one", kind: "snapshot", taskTypes: ["a"] });
		liveness.record({ sessionId: "one", kind: "session-ended" });
		liveness.record({ sessionId: "one", kind: "session-ended" });

		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});
});
