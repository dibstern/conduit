// Layout failures to guard before implementing the shared strip coordinates:
// missing or zero timestamps, compaction-only turns, concurrent long/short work,
// and dense turns must never create negative widths, overlap, or leave the track.
import { describe, expect, it } from "vitest";
import {
	type ActivityPart,
	type Segment,
	stripLayout,
	type Turn,
} from "../../../src/lib/frontend/utils/turns.js";

const step = (id: string, duration?: number): ActivityPart => ({
	type: "tool",
	uuid: id,
	id,
	name: "Read",
	input: { tool: "Read", filePath: id },
	status: "completed",
	...(duration === undefined
		? {}
		: { createdAt: 1000, endedAt: 1000 + duration }),
});
const seam: ActivityPart = {
	type: "system",
	uuid: "compact",
	text: "Context compacted",
	variant: "info",
	compaction: "completed",
};

function layout(activity: ActivityPart[]) {
	const segment: Segment = { activity, reply: [] };
	const turn: Turn = {
		id: "turn",
		segments: [segment],
		notices: [],
		live: false,
	};
	return stripLayout(segment, turn, true, 10_000);
}

describe("stripLayout", () => {
	it("has no coordinates for an empty strip", () =>
		expect(layout([])).toEqual([]));
	it("fills the strip with a single step", () =>
		expect(layout([step("one")])).toEqual([{ left: 0, width: 100 }]));
	it("uses equal widths when timestamps are absent", () => {
		const [a, b] = layout([step("one"), step("two")]);
		expect(a?.left).toBe(0);
		expect(a?.width).toBeCloseTo(b?.width ?? 0);
	});
	it("keeps weighted work and compaction coordinates in the same space", () => {
		const [a, compact, b] = layout([
			step("one", 1000),
			seam,
			step("two", 3000),
		]);
		expect(b?.width).toBeGreaterThan(a?.width ?? 0);
		expect(compact?.width).toBeLessThan(a?.width ?? 0);
		expect(compact?.left).toBeGreaterThan((a?.left ?? 0) + (a?.width ?? 0));
	});
	it.each([
		[seam, { ...seam, uuid: "compact-2" }],
		[step("zero", 0), step("long", 3_600_000), seam],
		Array.from({ length: 1000 }, (_, i) => step(String(i), i)),
	])("keeps every coordinate visible, ordered and bounded", (...activity) => {
		const positions = layout(activity);
		for (let i = 0; i < positions.length; i++) {
			const position = positions[i];
			expect(position).toBeDefined();
			if (!position) continue;
			expect(position.left).toBeGreaterThanOrEqual(0);
			expect(position.width).toBeGreaterThan(0);
			expect(position.left + position.width).toBeLessThanOrEqual(100.0000001);
			const previous = positions[i - 1];
			if (previous)
				expect(position.left).toBeGreaterThanOrEqual(
					previous.left + previous.width,
				);
		}
		const last = positions.at(-1);
		expect((last?.left ?? 0) + (last?.width ?? 0)).toBeCloseTo(100);
	});
});
