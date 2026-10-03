import { describe, expect, it, vi } from "vitest";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

describe("makeSessionBackgroundLiveness", () => {
	it("notifies when task ids are added or removed even if work stays working", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		const a = { id: "a", type: "local_agent", description: "Audit" };
		const b = { id: "b", type: "local_agent", description: "Review" };

		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [a] });
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			tasks: [a, b],
		});
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [b] });
		expect(liveness.hasLiveWork("one")).toBe(true);
		expect(liveness.backgroundOf("one")?.tasks.map((task) => task.id)).toEqual([
			"b",
		]);
		expect(onChange).toHaveBeenCalledTimes(3);

		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [] });
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [] });
		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(liveness.backgroundOf("one")).toBeUndefined();
		expect(onChange).toHaveBeenCalledTimes(4);
	});

	it("preserves firstSeenAt and stamps new ids with the current time, oldest first", () => {
		let now = 0;
		const liveness = makeSessionBackgroundLiveness(undefined, () => now);
		const a = { id: "a", type: "local_agent", description: "Audit" };
		const b = { id: "b", type: "local_bash", description: "Watch" };
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [a] });
		now = 100;
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [b, a] });
		expect(liveness.backgroundOf("one")).toEqual({
			work: "working",
			tasks: [
				{ ...a, firstSeenAt: 0 },
				{ ...b, firstSeenAt: 100 },
			],
		});
		now = 200;
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [a, b] });
		expect(liveness.backgroundOf("one")?.tasks).toEqual([
			{ ...a, firstSeenAt: 0 },
			{ ...b, firstSeenAt: 100 },
		]);
	});

	it("does not notify on identical or reordered snapshots", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		const a = { id: "a", type: "local_agent", description: "Audit" };
		const b = { id: "b", type: "local_agent", description: "Review" };
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [a, b] });
		const tasks = liveness.backgroundOf("one")?.tasks;
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			tasks: [{ ...a }, b],
		});
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [b, a] });
		expect(onChange.mock.calls).toEqual([["one"]]);
		expect(liveness.backgroundOf("one")?.tasks).toBe(tasks);
	});

	it("notifies on description and type changes without resetting firstSeenAt", () => {
		const onChange = vi.fn();
		let now = 100;
		const liveness = makeSessionBackgroundLiveness(onChange, () => now);
		const task = { id: "a", type: "local_bash", description: "Watch" };
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [task] });
		now = 200;
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			tasks: [{ ...task, description: "Watch tests" }],
		});
		expect(liveness.backgroundOf("one")).toEqual({
			work: "monitoring",
			tasks: [{ ...task, description: "Watch tests", firstSeenAt: 100 }],
		});
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			tasks: [{ ...task, type: "local_agent", description: "Watch tests" }],
		});
		expect(liveness.backgroundOf("one")).toEqual({
			work: "working",
			tasks: [
				{
					id: "a",
					type: "local_agent",
					description: "Watch tests",
					firstSeenAt: 100,
				},
			],
		});
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("keeps timestamps per session and restamps an id after it is dropped", () => {
		let now = 100;
		const liveness = makeSessionBackgroundLiveness(undefined, () => now);
		const task = { id: "a", type: "local_agent", description: "Audit" };
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [task] });
		now = 200;
		liveness.record({ sessionId: "two", kind: "snapshot", tasks: [task] });
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [] });
		now = 300;
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [task] });
		expect(liveness.backgroundOf("one")?.tasks[0]?.firstSeenAt).toBe(300);
		expect(liveness.backgroundOf("two")?.tasks[0]?.firstSeenAt).toBe(200);
	});

	it("does not notify for an empty or ended unknown session", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		liveness.record({ sessionId: "one", kind: "snapshot", tasks: [] });
		liveness.record({ sessionId: "one", kind: "session-ended" });
		expect(liveness.backgroundOf("one")).toBeUndefined();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("reports monitoring only while every live task is a watch loop", () => {
		const onChange = vi.fn();
		const liveness = makeSessionBackgroundLiveness(onChange);
		const kindAfter = (types: string[]) => {
			liveness.record({
				sessionId: "one",
				kind: "snapshot",
				tasks: types.map((type, index) => ({
					id: String(index),
					type,
					description: "Task",
				})),
			});
			return liveness.backgroundOf("one")?.work;
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
		liveness.record({
			sessionId: "one",
			kind: "snapshot",
			tasks: [{ id: "a", type: "local_agent", description: "Audit" }],
		});
		liveness.record({ sessionId: "one", kind: "session-ended" });
		liveness.record({ sessionId: "one", kind: "session-ended" });

		expect(liveness.hasLiveWork("one")).toBe(false);
		expect(liveness.backgroundOf("one")).toBeUndefined();
		expect(onChange.mock.calls).toEqual([["one"], ["one"]]);
	});
});
