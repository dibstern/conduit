// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { applySessionUpsert, seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	phaseToProcessing,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

it("a background session's busy row moves only that session's phase", () => {
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
	});
	expect(b.activity.phase).toBe("processing");
	expect(a.activity.phase).toBe("idle");
});

it("routes idle rows to the named background session", () => {
	seedSessions([
		{ id: "A", title: "A", status: "idle" },
		{ id: "B", title: "B", status: "idle" },
	]);
	openSessionForSetup("A", "project-a");
	const a = getOrCreateSessionSlot("A");
	const b = getOrCreateSessionSlot("B");
	phaseToProcessing(b.activity);
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "busy",
	});
	applySessionUpsert({
		projectSlug: "project-a",
		id: "B",
		title: "B",
		status: "idle",
	});
	expect(b.activity.phase).toBe("idle");
	expect(b.activity.endedGeneration).toBe(b.activity.turnGeneration);
	expect(a.activity.endedGeneration).toBe(-1);
});
