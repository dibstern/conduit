import { afterEach, expect, it, vi } from "vitest";
import { seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	phaseToProcessing,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
});

it("routes status to the named background session", () => {
	seedSessions([
		{ id: "A", title: "A", status: "idle" },
		{ id: "B", title: "B", status: "idle" },
	]);
	sessionState.currentId = "A";
	const a = getOrCreateSessionSlot("A");
	const b = getOrCreateSessionSlot("B");
	handleMessage({ type: "status", sessionId: "B", status: "processing" });
	expect(b.activity.phase).toBe("processing");
	expect(a.activity.phase).toBe("idle");
});

it("routes done to the named background session", () => {
	seedSessions([
		{ id: "A", title: "A", status: "idle" },
		{ id: "B", title: "B", status: "idle" },
	]);
	sessionState.currentId = "A";
	const a = getOrCreateSessionSlot("A");
	const b = getOrCreateSessionSlot("B");
	phaseToProcessing(b.activity);
	handleMessage({ type: "done", sessionId: "B", code: 0 });
	expect(b.activity.phase).toBe("idle");
	expect(b.activity.turnEpoch).toBe(1);
	expect(a.activity.turnEpoch).toBe(0);
});
