// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	clearSessionState,
	isSessionBusy,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { applySessionChange, seedFamilySessions } from "./session-fixtures.js";

beforeEach(() => clearSessionState());
afterEach(() => clearSessionState());

it("reads family-only child rows and propagates busy to its parent", () => {
	seedFamilySessions([
		{ id: "root", title: "Root", status: "idle" },
		{ id: "child", title: "Child", status: "busy", parentID: "root" },
	]);
	openSessionForSetup("root", "project-a");

	expect(isSessionBusy("child")).toBe(true);
	expect(isSessionBusy("root")).toBe(true);
	openSessionForSetup("child", "project-a");
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
	openSessionForSetup("side", "project-a");
	expect(isSessionBusy("agent")).toBe(true);
	expect(isSessionBusy("side")).toBe(true);
	expect(isSessionBusy("root")).toBe(false);
	expect(sessionState.currentParentId).toBe("root");
	applySessionChange({
		_tag: "upsert",
		item: {
			projectSlug: "project-a",
			id: "root",
			title: "Root",
			status: "busy",
		},
	});
	expect(isSessionBusy("root")).toBe(true);
});

it("reads busy and retry from shell rows and accepts idle immediately", () => {
	expect(isSessionBusy("s")).toBe(false);
	for (const status of ["busy", "retry", "idle"] as const) {
		applySessionChange({
			_tag: "upsert",
			item: { projectSlug: "project-a", id: "s", title: "s", status },
		});
		expect(isSessionBusy("s")).toBe(status !== "idle");
	}
});

// A background agent remains busy in its own view, while its idle parent
// monitors it. Foreground siblings and the parent's own turn must still win.
it("does not propagate a live background agent's busy status into its monitoring parent", () => {
	const backgroundTasks = [
		{
			id: "task",
			type: "local_agent",
			description: "Audit auth",
			firstSeenAt: 100,
			childSessionId: "agent",
		},
	];
	for (const [status, siblingStatus, busy] of [
		["idle", "idle", false],
		["idle", "busy", true],
		["busy", "idle", true],
		["retry", "idle", true],
	] as const) {
		applySessionChange({
			_tag: "snapshot",
			rows: [
				{
					projectSlug: "project-a",
					id: "root",
					title: "Root",
					status,
					backgroundWork: "monitoring",
					backgroundTasks,
				},
				{
					projectSlug: "project-a",
					id: "agent",
					title: "Agent",
					status: "busy",
					parentID: "root",
				},
				{
					projectSlug: "project-a",
					id: "sibling",
					title: "Sibling",
					status: siblingStatus,
					parentID: "root",
				},
			],
		});
		expect(isSessionBusy("agent")).toBe(true);
		expect(isSessionBusy("root")).toBe(busy);
	}
	// Foreground work can pass through an owned agent on its way to the root.
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{
				projectSlug: "project-a",
				id: "root",
				title: "Root",
				status: "idle",
				backgroundWork: "monitoring",
				backgroundTasks,
			},
			{
				projectSlug: "project-a",
				id: "agent",
				title: "Agent",
				status: "busy",
				parentID: "root",
			},
			{
				projectSlug: "project-a",
				id: "foreground",
				title: "Foreground",
				status: "busy",
				parentID: "agent",
			},
		],
	});
	expect(isSessionBusy("root")).toBe(true);
	applySessionChange({
		_tag: "upsert",
		item: {
			projectSlug: "project-a",
			id: "root",
			title: "Root",
			status: "idle",
		},
	});
	expect(isSessionBusy("root")).toBe(true);
});

it("keeps every ancestor busy until its last busy descendant stops or is removed", () => {
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{ projectSlug: "project-a", id: "root", title: "root", status: "idle" },
			{
				projectSlug: "project-a",
				id: "child",
				title: "child",
				status: "idle",
				parentID: "root",
			},
			{
				projectSlug: "project-a",
				id: "leaf",
				title: "leaf",
				status: "busy",
				parentID: "child",
			},
			{
				projectSlug: "project-a",
				id: "sibling",
				title: "sibling",
				status: "retry",
				parentID: "root",
			},
			{ projectSlug: "project-a", id: "other", title: "other", status: "idle" },
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
			projectSlug: "project-a",
			id: "sibling",
			title: "sibling",
			status: "idle",
			parentID: "root",
		},
	});
	expect(isSessionBusy("root")).toBe(false);
});
