// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	clearSessionState,
	isSessionBusy,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { applySessionChange, seedFamilySessions } from "./session-fixtures.js";

beforeEach(() => clearSessionState());
afterEach(() => clearSessionState());

it("reads family-only child rows and propagates busy to its parent", () => {
	seedFamilySessions([
		{ id: "root", title: "Root", status: "idle" },
		{ id: "child", title: "Child", status: "busy", parentID: "root" },
	]);
	sessionState.currentId = "root";

	expect(isSessionBusy("child")).toBe(true);
	expect(isSessionBusy("root")).toBe(true);
	sessionState.currentId = "child";
	expect(sessionState.currentParentId).toBe("root");
});

it("rolls a Side Thread's subagents into it without making its parent busy", () => {
	seedFamilySessions([
		{ id: "root", title: "Root", status: "idle" },
		{
			id: "side",
			title: "Side Thread",
			status: "idle",
			parentID: "root",
			sideThread: true,
		},
		{ id: "agent", title: "Agent", status: "busy", parentID: "side" },
	]);
	sessionState.currentId = "side";
	expect(isSessionBusy("agent")).toBe(true);
	expect(isSessionBusy("side")).toBe(true);
	expect(isSessionBusy("root")).toBe(false);
	expect(sessionState.currentParentId).toBe("root");
	applySessionChange({
		_tag: "upsert",
		item: { id: "root", title: "Root", status: "busy" },
	});
	expect(isSessionBusy("root")).toBe(true);
});

it("reads busy and retry from shell rows and accepts idle immediately", () => {
	expect(isSessionBusy("s")).toBe(false);
	for (const status of ["busy", "retry", "idle"] as const) {
		applySessionChange({
			_tag: "upsert",
			item: { id: "s", title: "s", status },
		});
		expect(isSessionBusy("s")).toBe(status !== "idle");
	}
});

it("keeps every ancestor busy until its last busy descendant stops or is removed", () => {
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{ id: "root", title: "root", status: "idle" },
			{ id: "child", title: "child", status: "idle", parentID: "root" },
			{ id: "leaf", title: "leaf", status: "busy", parentID: "child" },
			{ id: "sibling", title: "sibling", status: "retry", parentID: "root" },
			{ id: "other", title: "other", status: "idle" },
		],
	});
	expect(isSessionBusy("root")).toBe(true);
	expect(isSessionBusy("child")).toBe(true);
	expect(isSessionBusy("other")).toBe(false);
	applySessionChange({ _tag: "remove", id: "leaf" });
	expect(isSessionBusy("child")).toBe(false);
	expect(isSessionBusy("root")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: {
			id: "sibling",
			title: "sibling",
			status: "idle",
			parentID: "root",
		},
	});
	expect(isSessionBusy("root")).toBe(false);
});
