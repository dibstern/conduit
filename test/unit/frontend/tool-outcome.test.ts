import { describe, expect, it } from "vitest";
import { segmentAppearance } from "../../../src/lib/frontend/components/chat/activity-style.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";

describe("tool outcome presentation", () => {
	it.each([
		{
			outcome: "failed",
			status: "completed",
			isError: false,
			tone: "fail",
		},
		{
			outcome: "succeeded",
			status: "error",
			isError: true,
			tone: "shell",
		},
	] as const)("uses $outcome for activity colour", ({
		outcome,
		status,
		isError,
		tone,
	}) => {
		const part: ToolMessage = {
			type: "tool",
			uuid: "message/tool",
			id: "tool",
			name: "Bash",
			input: { tool: "Bash", command: "false" },
			outcome,
			status,
			isError,
		};
		expect(segmentAppearance(part, new Set())).toEqual({
			tone,
			running: false,
		});
	});
});
