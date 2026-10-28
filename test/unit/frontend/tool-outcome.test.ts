import { describe, expect, it } from "vitest";
import { segmentAppearance } from "../../../src/lib/frontend/components/chat/activity-style.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import { turnStats } from "../../../src/lib/frontend/utils/turns.js";

describe("tool outcome presentation", () => {
	it.each([
		{
			outcome: "failed",
			status: "completed",
			isError: false,
			failed: 1,
			tone: "fail",
		},
		{
			outcome: "succeeded",
			status: "error",
			isError: true,
			failed: 0,
			tone: "shell",
		},
	] as const)("uses $outcome for activity colour and failure count", ({
		outcome,
		status,
		isError,
		failed,
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
		expect
			.soft(segmentAppearance(part, new Set()))
			.toEqual({ tone, running: false });
		expect.soft(turnStats({ activity: [part], reply: [] }).failed).toBe(failed);
	});
});
