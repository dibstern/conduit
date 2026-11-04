// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { applySessionUpsert, seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	getSessionPhase,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	openSessionForSetup,
	WORKING_ACTIVITY,
} from "../../../src/lib/frontend/stories/session-setup.js";

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

it("a background session's working row moves only that session's phase", () => {
	seedSessions([
		{ id: "A", title: "A", status: "idle" },
		{ id: "B", title: "B", status: "idle" },
	]);
	openSessionForSetup("A", "project-a");
	const a = getOrCreateSessionSlot("A");
	getOrCreateSessionSlot("B");
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "busy",
	});
	expect(getSessionPhase("B")).toBe("idle");
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "busy",
		activity: WORKING_ACTIVITY,
	});
	expect(getSessionPhase("B")).toBe("processing");
	expect(getSessionPhase("A")).toBe("idle");
	expect(a.activity.endedGeneration).toBe(-1);
	expect(a.activity.turnGeneration).toBe(0);
});

it("routes idle rows to the named background session", () => {
	seedSessions([
		{ id: "A", title: "A", status: "idle" },
		{ id: "B", title: "B", status: "idle" },
	]);
	openSessionForSetup("A", "project-a");
	const a = getOrCreateSessionSlot("A");
	const b = getOrCreateSessionSlot("B");
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "busy",
		activity: WORKING_ACTIVITY,
	});
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "idle",
	});
	expect(getSessionPhase("B")).toBe("idle");
	expect(b.activity.endedGeneration).toBe(b.activity.turnGeneration);
	expect(a.activity.endedGeneration).toBe(-1);
});
