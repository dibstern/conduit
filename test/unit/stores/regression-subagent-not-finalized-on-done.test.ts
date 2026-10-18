// @vitest-environment jsdom
// A subagent tool completes via its own notification and can outlive the
// parent turn. `done` used to force-complete every running tool, flipping the
// still-running Task to "Done"; terminal finalization skips subagent tools.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	applyTerminalTurn,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { detailUpserts } from "../../helpers/detail-rows.js";

const sessionId = "sub-parent";
beforeEach(() => {
	seedSessions([{ id: sessionId, title: "Parent", status: "idle" }]);
	openSessionForSetup(sessionId, "project-a");
});
afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

function projectTool(name: "Task" | "Read") {
	const slot = getOrCreateSessionSlot(sessionId);
	const entry: TranscriptEntry = {
		project: "test",
		rows: [],
		hwm: null,
		hasMore: false,
		status: { _tag: "live" },
		pending: [],
		waiting: new Map(),
		partOrder: new Map(),
	};
	const projected = detailUpserts(
		{
			id: "assistant",
			role: "assistant",
			parts: [
				{
					id: "tool",
					type: "tool",
					tool: name,
					callID: "call",
					state: {
						status: "running",
						input: {
							_tag: "whole",
							value:
								name === "Task"
									? { subagent_type: "explore" }
									: { path: "foo.ts" },
						},
					},
				},
			],
		},
		1,
	).reduce(applyTranscriptEnvelope, entry);
	slot.messages.messages = deriveTranscriptMessages(projected, []);
	return slot;
}

it("keeps a running subagent Task after its parent turn ends", () => {
	const slot = projectTool("Task");
	applyTerminalTurn(slot.activity, slot.messages);
	expect(
		slot.messages.messages.find((item) => item.type === "tool"),
	).toMatchObject({
		name: "Task",
		status: "running",
	});
});

it("completes an ordinary running tool when the turn ends", () => {
	const slot = projectTool("Read");
	applyTerminalTurn(slot.activity, slot.messages);
	expect(
		slot.messages.messages.find((item) => item.type === "tool"),
	).toMatchObject({
		name: "Read",
		status: "completed",
	});
});
