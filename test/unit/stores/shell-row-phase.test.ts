// @vitest-environment jsdom
// The client's processing phase follows the session's shell row (ni8.35):
// the row's status is the only server signal for "a turn is running", so
// a busy row starts the turn and the row going idle ends it, in every tab.
import { beforeEach, expect, it } from "vitest";
import {
	getOrCreateSessionSlot,
	phaseToProcessing,
	sessionActivity,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	handleSessionFamily,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";
import { applySessionChange } from "./session-fixtures.js";

const row = (status: SessionInfo["status"]): SessionInfo => ({
	id: "s",
	title: "s",
	status,
});
const upsert = (status: SessionInfo["status"]) =>
	applySessionChange({ _tag: "upsert", item: row(status) });
const snapshot = (status: SessionInfo["status"]) =>
	applySessionChange({ _tag: "snapshot", rows: [row(status)] });
const activity = () => {
	const slot = sessionActivity.get("s");
	if (!slot) throw new Error("no slot");
	return slot;
};

beforeEach(() => {
	clearSessionState();
	sessionActivity.clear();
	sessionState.currentId = "s";
});

it("a busy row starts the turn and the row going idle ends it once", () => {
	snapshot("idle");
	getOrCreateSessionSlot("s");
	upsert("busy");
	expect(activity().phase).toBe("processing");
	activity().currentMessageId = "m1";
	const epoch = activity().turnEpoch;

	upsert("idle");

	expect(activity().phase).toBe("idle");
	expect(activity().turnEpoch).toBe(epoch + 1);
	expect(activity().currentMessageId).toBeNull();
});

it("a retrying row keeps the turn running", () => {
	snapshot("busy");
	getOrCreateSessionSlot("s");
	upsert("retry");
	expect(activity().phase).toBe("processing");
});

it("an idle row write does not end a turn the sender started optimistically", () => {
	snapshot("idle");
	const { activity: slot } = getOrCreateSessionSlot("s");
	phaseToProcessing(slot);

	// The user message bumps the row before the provider reports busy.
	upsert("idle");

	expect(slot.phase).toBe("processing");
});

it("a stale busy write after the turn ended does not restart it", () => {
	snapshot("busy");
	const { activity: slot } = getOrCreateSessionSlot("s");
	expect(slot.phase).toBe("processing");
	slot.phase = "idle"; // `done` ended the turn first
	const epoch = slot.turnEpoch;

	upsert("busy");

	expect(slot.phase).toBe("idle");
	expect(slot.turnEpoch).toBe(epoch);
});

it("a slot opened on a busy session starts processing", () => {
	snapshot("busy");
	expect(getOrCreateSessionSlot("s").activity.phase).toBe("processing");
});

it("a snapshot aligns the phase in both directions", () => {
	snapshot("idle");
	const { activity: slot } = getOrCreateSessionSlot("s");
	snapshot("busy");
	expect(slot.phase).toBe("processing");
	snapshot("idle");
	expect(slot.phase).toBe("idle");
});

it("a child session, which has no shell row, starts from its family row", () => {
	const { activity: slot } = getOrCreateSessionSlot("child");
	handleSessionFamily({
		type: "session_family",
		rootId: "root",
		sessions: [
			{ id: "root", title: "Root", status: "busy" },
			{ id: "child", title: "Child", status: "busy", parentID: "root" },
		],
	});
	expect(slot.phase).toBe("processing");
});
