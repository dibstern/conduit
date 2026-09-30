import { describe, expect, it } from "vitest";
import type { Message } from "../../../../src/lib/instance/sdk-types.js";
import {
	isSettled,
	snapshotPayload,
	synthesizeSnapshotEvent,
} from "../../../../src/lib/provider/opencode/opencode-history-backfill.js";

const message: Message = {
	id: "a1",
	sessionID: "s1",
	role: "assistant",
	parentID: "u1",
	time: { created: 1, completed: 2 },
	cost: 0.5,
	parts: [
		{ id: "step", type: "step-start", time: { start: 1 } },
		{
			id: "tool",
			type: "tool",
			tool: "bash",
			state: { status: "completed", input: { command: "pwd" } },
		},
		{ id: "text", type: "text", text: "done" },
	],
};

describe("OpenCode REST snapshots", () => {
	it("retains every part and normalizes tool input", () => {
		const payload = snapshotPayload(message);
		expect(payload.message.parts.map((part) => part.type)).toEqual([
			"step-start",
			"tool",
			"text",
		]);
		expect(payload.message.parts[1]?.["state"]).toEqual({
			status: "completed",
			input: { tool: "Bash", command: "pwd" },
		});
	});

	it("uses content-addressed event IDs and changes when an interior part changes", () => {
		const first = synthesizeSnapshotEvent("s1", message);
		expect(
			synthesizeSnapshotEvent("s1", {
				...message,
				parts: [...(message.parts ?? [])],
			}).eventId,
		).toBe(first.eventId);
		const corrected = synthesizeSnapshotEvent(
			"s1",
			{
				...message,
				parts: [
					...(message.parts ?? []),
					{ id: "finish", type: "step-finish" },
				],
			},
			first.eventId,
		);
		expect(corrected.eventId).not.toBe(first.eventId);
		expect(
			synthesizeSnapshotEvent("s1", message, corrected.eventId).eventId,
		).not.toBe(first.eventId);
		expect(first.rawSource.kind).toBe("opencode.rest");
	});

	it("only snapshots settled messages", () => {
		expect(isSettled(message)).toBe(true);
		expect(isSettled({ ...message, time: { created: 1 } })).toBe(false);
	});
});
