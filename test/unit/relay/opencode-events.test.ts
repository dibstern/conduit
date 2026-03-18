// ─── Type Guard Tests (Ticket 7) ──────────────────────────────────────────────
// Verifies that type guard functions correctly narrow OpenCode SSE events.

import { describe, expect, it } from "vitest";
import {
	hasInfoWithSessionID,
	hasPartWithSessionID,
	hasSessionID,
	isFileEvent,
	isInstallationUpdateEvent,
	isMessageCreatedEvent,
	isMessageRemovedEvent,
	isMessageUpdatedEvent,
	isPartDeltaEvent,
	isPartRemovedEvent,
	isPartUpdatedEvent,
	isPermissionAskedEvent,
	isPermissionRepliedEvent,
	isPtyCreatedEvent,
	isPtyDeletedEvent,
	isPtyEvent,
	isPtyExitedEvent,
	isQuestionAskedEvent,
	isSessionErrorEvent,
	isSessionStatusEvent,
	isTodoUpdatedEvent,
} from "../../../src/lib/relay/opencode-events.js";

// ─── isPartDeltaEvent ────────────────────────────────────────────────────────

describe("isPartDeltaEvent", () => {
	it("returns true for valid part delta", () => {
		expect(
			isPartDeltaEvent({
				type: "message.part.delta",
				properties: {
					sessionID: "s1",
					messageID: "m1",
					partID: "p1",
					delta: "hi",
					field: "text",
				},
			}),
		).toBe(true);
	});

	it("returns true when optional sessionID/messageID are missing", () => {
		expect(
			isPartDeltaEvent({
				type: "message.part.delta",
				properties: { partID: "p1", delta: "hi", field: "text" },
			}),
		).toBe(true);
	});

	it("returns false for missing required fields", () => {
		expect(
			isPartDeltaEvent({
				type: "message.part.delta",
				properties: { sessionID: "s1" },
			}),
		).toBe(false);
	});

	it("returns false for missing delta", () => {
		expect(
			isPartDeltaEvent({
				type: "message.part.delta",
				properties: { partID: "p1", field: "text" },
			}),
		).toBe(false);
	});

	it("returns false for wrong type", () => {
		expect(
			isPartDeltaEvent({
				type: "session.status",
				properties: {
					partID: "p1",
					delta: "hi",
					field: "text",
				},
			}),
		).toBe(false);
	});

	it("returns false for non-object input", () => {
		expect(isPartDeltaEvent(null)).toBe(false);
		expect(isPartDeltaEvent(undefined)).toBe(false);
		expect(isPartDeltaEvent("string")).toBe(false);
		expect(isPartDeltaEvent(42)).toBe(false);
	});

	it("returns false for missing properties", () => {
		expect(isPartDeltaEvent({ type: "message.part.delta" })).toBe(false);
	});
});

// ─── isPartUpdatedEvent ──────────────────────────────────────────────────────

describe("isPartUpdatedEvent", () => {
	it("returns true for valid part updated with tool part", () => {
		expect(
			isPartUpdatedEvent({
				type: "message.part.updated",
				properties: {
					partID: "p1",
					messageID: "m1",
					part: {
						id: "p1",
						type: "tool",
						tool: "bash",
						state: { status: "running" },
					},
				},
			}),
		).toBe(true);
	});

	it("returns true for reasoning part", () => {
		expect(
			isPartUpdatedEvent({
				type: "message.part.updated",
				properties: {
					part: { type: "reasoning", time: { start: 100 } },
				},
			}),
		).toBe(true);
	});

	it("returns false when part is missing", () => {
		expect(
			isPartUpdatedEvent({
				type: "message.part.updated",
				properties: { partID: "p1" },
			}),
		).toBe(false);
	});

	it("returns false when part has no type", () => {
		expect(
			isPartUpdatedEvent({
				type: "message.part.updated",
				properties: { part: { id: "p1" } },
			}),
		).toBe(false);
	});

	it("returns false for wrong event type", () => {
		expect(
			isPartUpdatedEvent({
				type: "message.part.delta",
				properties: { part: { type: "text" } },
			}),
		).toBe(false);
	});
});

// ─── isPartRemovedEvent ──────────────────────────────────────────────────────

describe("isPartRemovedEvent", () => {
	it("returns true for valid part removed", () => {
		expect(
			isPartRemovedEvent({
				type: "message.part.removed",
				properties: { partID: "p1", messageID: "m1" },
			}),
		).toBe(true);
	});

	it("returns false when partID is missing", () => {
		expect(
			isPartRemovedEvent({
				type: "message.part.removed",
				properties: { messageID: "m1" },
			}),
		).toBe(false);
	});

	it("returns false when messageID is missing", () => {
		expect(
			isPartRemovedEvent({
				type: "message.part.removed",
				properties: { partID: "p1" },
			}),
		).toBe(false);
	});

	it("returns false for wrong type", () => {
		expect(
			isPartRemovedEvent({
				type: "message.part.updated",
				properties: { partID: "p1", messageID: "m1" },
			}),
		).toBe(false);
	});
});

// ─── isSessionStatusEvent ────────────────────────────────────────────────────

describe("isSessionStatusEvent", () => {
	it("returns true for valid session status", () => {
		expect(
			isSessionStatusEvent({
				type: "session.status",
				properties: { status: { type: "busy" } },
			}),
		).toBe(true);
	});

	it("returns true even without status property", () => {
		expect(
			isSessionStatusEvent({
				type: "session.status",
				properties: {},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isSessionStatusEvent({
				type: "session.error",
				properties: { status: { type: "busy" } },
			}),
		).toBe(false);
	});
});

// ─── isSessionErrorEvent ─────────────────────────────────────────────────────

describe("isSessionErrorEvent", () => {
	it("returns true for valid session error", () => {
		expect(
			isSessionErrorEvent({
				type: "session.error",
				properties: {
					error: { name: "QuotaExhausted", data: { message: "Over limit" } },
				},
			}),
		).toBe(true);
	});

	it("returns true with empty properties", () => {
		expect(
			isSessionErrorEvent({
				type: "session.error",
				properties: {},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isSessionErrorEvent({
				type: "session.status",
				properties: { error: { name: "Err" } },
			}),
		).toBe(false);
	});
});

// ─── isPermissionAskedEvent ──────────────────────────────────────────────────

describe("isPermissionAskedEvent", () => {
	it("returns true for valid permission asked", () => {
		expect(
			isPermissionAskedEvent({
				type: "permission.asked",
				properties: {
					id: "req1",
					permission: "bash",
					patterns: ["*"],
					tool: { callID: "c1" },
				},
			}),
		).toBe(true);
	});

	it("returns false when id is missing", () => {
		expect(
			isPermissionAskedEvent({
				type: "permission.asked",
				properties: { permission: "bash" },
			}),
		).toBe(false);
	});

	it("returns false when permission is missing", () => {
		expect(
			isPermissionAskedEvent({
				type: "permission.asked",
				properties: { id: "req1" },
			}),
		).toBe(false);
	});

	it("returns false for wrong type", () => {
		expect(
			isPermissionAskedEvent({
				type: "permission.replied",
				properties: { id: "req1", permission: "bash" },
			}),
		).toBe(false);
	});
});

// ─── isPermissionRepliedEvent ────────────────────────────────────────────────

describe("isPermissionRepliedEvent", () => {
	it("returns true for valid permission replied", () => {
		expect(
			isPermissionRepliedEvent({
				type: "permission.replied",
				properties: { id: "req1" },
			}),
		).toBe(true);
	});

	it("returns false when id is missing", () => {
		expect(
			isPermissionRepliedEvent({
				type: "permission.replied",
				properties: {},
			}),
		).toBe(false);
	});

	it("returns false for wrong type", () => {
		expect(
			isPermissionRepliedEvent({
				type: "permission.asked",
				properties: { id: "req1" },
			}),
		).toBe(false);
	});
});

// ─── isQuestionAskedEvent ────────────────────────────────────────────────────

describe("isQuestionAskedEvent", () => {
	it("returns true for valid question asked", () => {
		expect(
			isQuestionAskedEvent({
				type: "question.asked",
				properties: {
					id: "q1",
					questions: [
						{ question: "Continue?", header: "Confirm", options: [] },
					],
				},
			}),
		).toBe(true);
	});

	it("returns true with empty questions array", () => {
		expect(
			isQuestionAskedEvent({
				type: "question.asked",
				properties: { id: "q1", questions: [] },
			}),
		).toBe(true);
	});

	it("returns false when id is missing", () => {
		expect(
			isQuestionAskedEvent({
				type: "question.asked",
				properties: { questions: [] },
			}),
		).toBe(false);
	});

	it("returns false when questions is missing", () => {
		expect(
			isQuestionAskedEvent({
				type: "question.asked",
				properties: { id: "q1" },
			}),
		).toBe(false);
	});

	it("returns false when questions is not an array", () => {
		expect(
			isQuestionAskedEvent({
				type: "question.asked",
				properties: { id: "q1", questions: "not-array" },
			}),
		).toBe(false);
	});
});

// ─── isMessageCreatedEvent ───────────────────────────────────────────────────

describe("isMessageCreatedEvent", () => {
	it("returns true for valid message created", () => {
		expect(
			isMessageCreatedEvent({
				type: "message.created",
				properties: { sessionID: "s1", messageID: "m1" },
			}),
		).toBe(true);
	});

	it("returns true with empty properties", () => {
		expect(
			isMessageCreatedEvent({
				type: "message.created",
				properties: {},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isMessageCreatedEvent({
				type: "message.updated",
				properties: {},
			}),
		).toBe(false);
	});
});

// ─── isMessageUpdatedEvent ───────────────────────────────────────────────────

describe("isMessageUpdatedEvent", () => {
	it("returns true for valid message updated with info", () => {
		expect(
			isMessageUpdatedEvent({
				type: "message.updated",
				properties: {
					sessionID: "s1",
					info: { role: "assistant", cost: 0.01 },
				},
			}),
		).toBe(true);
	});

	it("returns true for message updated with message field", () => {
		expect(
			isMessageUpdatedEvent({
				type: "message.updated",
				properties: {
					message: { role: "assistant" },
				},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isMessageUpdatedEvent({
				type: "message.created",
				properties: { info: { role: "assistant" } },
			}),
		).toBe(false);
	});
});

// ─── isMessageRemovedEvent ───────────────────────────────────────────────────

describe("isMessageRemovedEvent", () => {
	it("returns true for valid message removed", () => {
		expect(
			isMessageRemovedEvent({
				type: "message.removed",
				properties: { messageID: "m1" },
			}),
		).toBe(true);
	});

	it("returns false when messageID is missing", () => {
		expect(
			isMessageRemovedEvent({
				type: "message.removed",
				properties: {},
			}),
		).toBe(false);
	});

	it("returns false for wrong type", () => {
		expect(
			isMessageRemovedEvent({
				type: "message.updated",
				properties: { messageID: "m1" },
			}),
		).toBe(false);
	});
});

// ─── PTY Events ──────────────────────────────────────────────────────────────

describe("isPtyEvent", () => {
	it("returns true for pty.created", () => {
		expect(
			isPtyEvent({
				type: "pty.created",
				properties: { info: { id: "pty1" } },
			}),
		).toBe(true);
	});

	it("returns true for pty.exited", () => {
		expect(
			isPtyEvent({
				type: "pty.exited",
				properties: { id: "pty1", exitCode: 0 },
			}),
		).toBe(true);
	});

	it("returns true for pty.deleted", () => {
		expect(
			isPtyEvent({
				type: "pty.deleted",
				properties: { id: "pty1" },
			}),
		).toBe(true);
	});

	it("returns false for non-pty event", () => {
		expect(
			isPtyEvent({
				type: "pty.output",
				properties: { data: "hello" },
			}),
		).toBe(false);
	});

	it("returns false for non-event", () => {
		expect(isPtyEvent(null)).toBe(false);
	});
});

describe("isPtyCreatedEvent", () => {
	it("returns true for pty.created", () => {
		expect(
			isPtyCreatedEvent({
				type: "pty.created",
				properties: { info: { id: "pty1", title: "bash" } },
			}),
		).toBe(true);
	});

	it("returns false for pty.exited", () => {
		expect(
			isPtyCreatedEvent({
				type: "pty.exited",
				properties: { id: "pty1" },
			}),
		).toBe(false);
	});
});

describe("isPtyExitedEvent", () => {
	it("returns true for pty.exited", () => {
		expect(
			isPtyExitedEvent({
				type: "pty.exited",
				properties: { id: "pty1", exitCode: 1 },
			}),
		).toBe(true);
	});
});

describe("isPtyDeletedEvent", () => {
	it("returns true for pty.deleted", () => {
		expect(
			isPtyDeletedEvent({
				type: "pty.deleted",
				properties: { id: "pty1" },
			}),
		).toBe(true);
	});
});

// ─── File Events ─────────────────────────────────────────────────────────────

describe("isFileEvent", () => {
	it("returns true for file.edited", () => {
		expect(
			isFileEvent({
				type: "file.edited",
				properties: { file: "/path/to/file.ts" },
			}),
		).toBe(true);
	});

	it("returns true for file.watcher.updated", () => {
		expect(
			isFileEvent({
				type: "file.watcher.updated",
				properties: { file: "/path/to/file.ts" },
			}),
		).toBe(true);
	});

	it("returns false when file is missing", () => {
		expect(
			isFileEvent({
				type: "file.edited",
				properties: {},
			}),
		).toBe(false);
	});

	it("returns false for unknown file event type", () => {
		expect(
			isFileEvent({
				type: "file.deleted",
				properties: { file: "/path/to/file.ts" },
			}),
		).toBe(false);
	});
});

// ─── Installation Update ─────────────────────────────────────────────────────

describe("isInstallationUpdateEvent", () => {
	it("returns true for valid update event", () => {
		expect(
			isInstallationUpdateEvent({
				type: "installation.update-available",
				properties: { version: "2.0.0" },
			}),
		).toBe(true);
	});

	it("returns true without version", () => {
		expect(
			isInstallationUpdateEvent({
				type: "installation.update-available",
				properties: {},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isInstallationUpdateEvent({
				type: "installation.updated",
				properties: { version: "2.0.0" },
			}),
		).toBe(false);
	});
});

// ─── Todo Updated ────────────────────────────────────────────────────────────

describe("isTodoUpdatedEvent", () => {
	it("returns true for valid todo updated", () => {
		expect(
			isTodoUpdatedEvent({
				type: "todo.updated",
				properties: {
					todos: [{ content: "Fix bug", status: "pending" }],
				},
			}),
		).toBe(true);
	});

	it("returns true without todos", () => {
		expect(
			isTodoUpdatedEvent({
				type: "todo.updated",
				properties: {},
			}),
		).toBe(true);
	});

	it("returns false for wrong type", () => {
		expect(
			isTodoUpdatedEvent({
				type: "todo.created",
				properties: { todos: [] },
			}),
		).toBe(false);
	});
});

// ─── Session ID extraction helpers ───────────────────────────────────────────

describe("hasSessionID", () => {
	it("returns true when sessionID is present", () => {
		expect(hasSessionID({ sessionID: "s1" })).toBe(true);
	});

	it("returns false when sessionID is empty string", () => {
		expect(hasSessionID({ sessionID: "" })).toBe(false);
	});

	it("returns false when sessionID is missing", () => {
		expect(hasSessionID({})).toBe(false);
	});

	it("returns false when sessionID is not a string", () => {
		expect(hasSessionID({ sessionID: 42 })).toBe(false);
	});
});

describe("hasPartWithSessionID", () => {
	it("returns true when part.sessionID exists", () => {
		expect(hasPartWithSessionID({ part: { sessionID: "s1" } })).toBe(true);
	});

	it("returns false when part is not an object", () => {
		expect(hasPartWithSessionID({ part: "not-obj" })).toBe(false);
	});

	it("returns false when part is missing", () => {
		expect(hasPartWithSessionID({})).toBe(false);
	});

	it("returns false when part.sessionID is empty", () => {
		expect(hasPartWithSessionID({ part: { sessionID: "" } })).toBe(false);
	});
});

describe("hasInfoWithSessionID", () => {
	it("returns true when info.sessionID exists", () => {
		expect(hasInfoWithSessionID({ info: { sessionID: "s1" } })).toBe(true);
	});

	it("returns true when info.id exists (session.updated style)", () => {
		expect(hasInfoWithSessionID({ info: { id: "s1" } })).toBe(true);
	});

	it("returns false when info is not an object", () => {
		expect(hasInfoWithSessionID({ info: null })).toBe(false);
	});

	it("returns false when info is missing", () => {
		expect(hasInfoWithSessionID({})).toBe(false);
	});

	it("returns false when info has neither sessionID nor id", () => {
		expect(hasInfoWithSessionID({ info: { other: "val" } })).toBe(false);
	});

	it("returns false when info.sessionID is empty", () => {
		expect(hasInfoWithSessionID({ info: { sessionID: "" } })).toBe(false);
	});
});
