// A subagent tool completes via its own notification and can outlive the
// parent turn. `done` used to force-complete every running tool, flipping the
// still-running Task to "Done"; finalizeAll now skips subagent tools.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	seedRegistryFromMessages,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

const sessionId = "sub-parent";
beforeEach(() => {
	seedSessions([{ id: sessionId, title: "Parent", status: "idle" }]);
	sessionState.currentId = sessionId;
});
afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
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
	};
	const projected = applyTranscriptEnvelope(entry, {
		_tag: "upsert",
		sequence: 1,
		item: {
			_tag: "transcriptMessage",
			message: {
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
							input:
								name === "Task"
									? { subagent_type: "explore" }
									: { path: "foo.ts" },
						},
					},
				],
			},
		},
	});
	slot.messages.messages = deriveTranscriptMessages(projected, []);
	seedRegistryFromMessages(
		slot.activity,
		slot.messages,
		slot.messages.messages,
	);
	return slot;
}

it("keeps a running subagent Task after its parent turn ends", () => {
	const slot = projectTool("Task");
	handleMessage({ type: "done", sessionId, code: 0 });
	expect(
		slot.messages.messages.find((item) => item.type === "tool"),
	).toMatchObject({
		name: "Task",
		status: "running",
	});
});

it("completes an ordinary running tool when the turn ends", () => {
	const slot = projectTool("Read");
	handleMessage({ type: "done", sessionId, code: 0 });
	expect(
		slot.messages.messages.find((item) => item.type === "tool"),
	).toMatchObject({
		name: "Read",
		status: "completed",
	});
});
