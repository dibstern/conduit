import { describe, expect, it } from "vitest";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	getFilteredSessions,
	groupSessionsByDate,
	projectSessionList,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type {
	SessionGrouping,
	SessionStatusFilter,
} from "../../../src/lib/frontend/stores/session-scope.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const now = new Date(2030, 9, 7, 12).getTime();
const at = (day: number, hour: number) =>
	new Date(2030, 9, day, hour).getTime();
const row = (
	id: string,
	overrides: Partial<SessionInfo> = {},
): SessionInfo => ({
	id,
	title: id,
	updatedAt: at(7, 10),
	...overrides,
});
const projectLabel = (session: SessionInfo) => {
	const key = session.projectSlug ?? "local";
	return { key, label: key === "local" ? "Local project" : `Project ${key}` };
};
const project = (
	sessions: SessionInfo[],
	grouping: SessionGrouping = "status",
	status: SessionStatusFilter | null = null,
) => projectSessionList(sessions, { grouping, status }, now, projectLabel);
const ids = (sessions: SessionInfo[]) => sessions.map((session) => session.id);

describe("projectSessionList", () => {
	it("reuses attention tiers for the default grouping", () => {
		const result = project([
			row("idle"),
			row("unread", { attention: "done-unread" }),
			row("error", { attention: "error" }),
			row("running", { attention: "working" }),
			row("approval", { attention: "needs-approval" }),
		]);
		expect(
			result.sections.map(({ key, sessions }) => [key, ids(sessions)]),
		).toEqual([
			["needs-you", ["approval", "error"]],
			["running", ["running"]],
			["unread", ["unread"]],
			["idle", ["idle"]],
		]);
	});

	it("groups projects by their newest row and sorts rows by recency", () => {
		const result = project(
			[
				row("a-old", { projectSlug: "a", updatedAt: at(5, 10) }),
				row("b-new", { projectSlug: "b", updatedAt: at(7, 11) }),
				row("a-new", { projectSlug: "a", updatedAt: at(7, 10) }),
				row("b-old", { projectSlug: "b", updatedAt: at(6, 10) }),
			],
			"project",
		);
		expect(
			result.sections.map(({ key, label, sessions }) => [
				key,
				label,
				ids(sessions),
			]),
		).toEqual([
			["b", "Project b", ["b-new", "b-old"]],
			["a", "Project a", ["a-new", "a-old"]],
		]);
	});

	it("uses the supplied clock for Today, Yesterday and Older", () => {
		const result = project(
			[
				row("older", { updatedAt: at(5, 11) }),
				row("today", { updatedAt: at(7, 1) }),
				row("yesterday", { updatedAt: at(6, 23) }),
			],
			"time",
		);
		expect(
			result.sections.map(({ label, sessions }) => [label, ids(sessions)]),
		).toEqual([
			["Today", ["today"]],
			["Yesterday", ["yesterday"]],
			["Older", ["older"]],
		]);
	});

	it.each([
		["needs-you", ["approval", "reply", "error"]],
		["running", ["working"]],
		["unread", ["unread"]],
	] as const)("filters %s before any grouping", (status, expected) => {
		const sessions = [
			row("approval", { attention: "needs-approval" }),
			row("reply", { attention: "needs-reply" }),
			row("error", { attention: "error" }),
			row("working", { attention: "working" }),
			row("unread", { attention: "done-unread" }),
			row("idle"),
		];
		for (const grouping of ["status", "project", "time"] as const) {
			const result = project(sessions, grouping, status);
			expect(
				result.sections.flatMap(({ sessions }) => ids(sessions)).sort(),
			).toEqual([...expected].sort());
		}
	});

	it("filters pinned and shelves, keeping placement and shelf ordering", () => {
		const sessions = [
			row("pin-later", { attention: "working", pinnedAt: 20 }),
			row("sleep-later", {
				attention: "working",
				snoozedAt: 1,
				snoozedUntil: now + 2_000,
			}),
			row("settle-old", { attention: "working", settledAt: 10 }),
			row("pin-first", { attention: "working", pinnedAt: 1 }),
			row("sleep-soon", {
				attention: "working",
				snoozedAt: 1,
				snoozedUntil: now + 1_000,
			}),
			row("settle-new", { attention: "working", settledAt: 30 }),
			row("live", { attention: "working" }),
			row("other-pin", { attention: "idle", pinnedAt: 0 }),
		];
		for (const grouping of ["status", "project", "time"] as const) {
			const result = project(sessions, grouping, "running");
			expect(ids(result.pinned)).toEqual(["pin-first", "pin-later"]);
			expect(ids(result.sections[0]?.sessions ?? [])).toEqual(["live"]);
			expect(ids(result.snoozed)).toEqual(["sleep-soon", "sleep-later"]);
			expect(ids(result.settled)).toEqual(["settle-new", "settle-old"]);
		}
	});

	it("composes with the existing project scope and title search", () => {
		attachedProjectState.slug = "local";
		routerState.search = "?p=a";
		sessionState.rootSessions = [];
		sessionState.daemonSessions = [
			row("wanted", {
				title: "Fix sidebar",
				projectSlug: "a",
				attention: "working",
			}),
			row("wrong-project", {
				title: "Fix elsewhere",
				projectSlug: "b",
				attention: "working",
			}),
			row("wrong-title", {
				title: "Review",
				projectSlug: "a",
				attention: "working",
			}),
		];
		sessionState.searchQuery = "Fix";
		expect(
			ids(
				project(getFilteredSessions(), "project", "running").sections.flatMap(
					(section) => section.sessions,
				),
			),
		).toEqual(["wanted"]);
		sessionState.searchQuery = "";
		sessionState.daemonSessions = [];
		routerState.search = "";
	});
});

describe("groupSessionsByDate", () => {
	it("places an update from today in Today", () => {
		const groups = groupSessionsByDate(
			[row("today", { updatedAt: at(7, 8) })],
			new Date(now),
		);
		expect(ids(groups.today)).toEqual(["today"]);
		expect(groups.yesterday).toEqual([]);
		expect(groups.older).toEqual([]);
	});

	it("places an update from yesterday in Yesterday", () => {
		const groups = groupSessionsByDate(
			[row("yesterday", { updatedAt: at(6, 15) })],
			new Date(now),
		);
		expect(ids(groups.yesterday)).toEqual(["yesterday"]);
		expect(groups.today).toEqual([]);
		expect(groups.older).toEqual([]);
	});

	it("places earlier updates in Older", () => {
		const groups = groupSessionsByDate(
			[row("older", { updatedAt: at(5, 10) })],
			new Date(now),
		);
		expect(ids(groups.older)).toEqual(["older"]);
	});

	it("falls back to createdAt when updatedAt is missing", () => {
		const groups = groupSessionsByDate(
			[{ id: "created", title: "created", createdAt: at(7, 8) }],
			new Date(now),
		);
		expect(ids(groups.today)).toEqual(["created"]);
	});

	it("falls back to epoch when both timestamps are missing", () => {
		const groups = groupSessionsByDate(
			[{ id: "undated", title: "undated" }],
			new Date(now),
		);
		expect(ids(groups.older)).toEqual(["undated"]);
	});

	it("distributes mixed timestamps", () => {
		const groups = groupSessionsByDate(
			[
				row("today", { updatedAt: at(7, 8) }),
				row("yesterday", { updatedAt: at(6, 8) }),
				row("older", { updatedAt: at(5, 8) }),
			],
			new Date(now),
		);
		expect(ids(groups.today)).toEqual(["today"]);
		expect(ids(groups.yesterday)).toEqual(["yesterday"]);
		expect(ids(groups.older)).toEqual(["older"]);
	});

	it("handles an empty list", () => {
		expect(groupSessionsByDate([], new Date(now))).toEqual({
			today: [],
			yesterday: [],
			older: [],
		});
	});
});
