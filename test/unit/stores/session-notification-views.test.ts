import { seedSessions } from "./session-fixtures.js";
// ─── Notification views over the server's session rows (ni8.23) ──────────────
// The badge used to be a reducer the browser drove from a stream of events: it
// counted questions up and down, remembered which sessions had been looked at,
// and hoped the two ended up agreeing with the server. They are now three facts
// ON the session row, so these are reads, not state — which is why every test
// here seeds rows and asserts, with nothing to dispatch and nothing to reset.

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearSessionState,
	getAttentionSessions,
	getSessionIndicator,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

const row = (
	id: string,
	notif: Partial<
		Pick<
			SessionInfo,
			"pendingQuestionCount" | "pendingPermissionCount" | "unread"
		>
	> = {},
): SessionInfo => ({
	id,
	title: id,
	status: "idle",
	createdAt: 1,
	updatedAt: 1,
	pendingQuestionCount: 0,
	pendingPermissionCount: 0,
	unread: false,
	...notif,
});

const noDescendants = () => new Set<string>();

beforeEach(() => {
	clearSessionState();
});

describe("getSessionIndicator", () => {
	it("shows attention when the server says something is pending", () => {
		seedSessions([
			row("asking", { pendingQuestionCount: 1 }),
			row("permitting", { pendingPermissionCount: 2 }),
			row("quiet"),
		]);
		expect(getSessionIndicator("asking", null)).toBe("attention");
		expect(getSessionIndicator("permitting", null)).toBe("attention");
		expect(getSessionIndicator("quiet", null)).toBe(null);
	});

	it("shows unseen activity when nothing is pending but something arrived", () => {
		seedSessions([row("finished", { unread: true })]);
		expect(getSessionIndicator("finished", null)).toBe("done-unviewed");
	});

	it("prefers attention over unseen activity", () => {
		seedSessions([row("both", { pendingQuestionCount: 1, unread: true })]);
		expect(getSessionIndicator("both", null)).toBe("attention");
	});

	it("never badges the session on screen", () => {
		// The one piece of this that stays tab-local: a session cannot want your
		// attention while you are looking at it, and which session that is differs
		// per browser tab.
		seedSessions([row("here", { pendingQuestionCount: 3, unread: true })]);
		expect(getSessionIndicator("here", "here")).toBe(null);
	});

	it("says nothing about a session it does not hold", () => {
		expect(getSessionIndicator("unknown", null)).toBe(null);
	});

	it("clears the moment the server's row says the session was viewed", () => {
		seedSessions([row("s1", { unread: true })]);
		expect(getSessionIndicator("s1", null)).toBe("done-unviewed");
		// Exactly what a shell upsert delivers after `read_at` changes. No
		// client-local viewed-set to keep in step, so there is nothing to drift.
		seedSessions([row("s1", { unread: false })]);
		expect(getSessionIndicator("s1", null)).toBe(null);
	});
});

describe("getAttentionSessions", () => {
	it("returns the server's counts for every session that wants attention", () => {
		seedSessions([
			row("a", { pendingQuestionCount: 2, pendingPermissionCount: 1 }),
			row("b", { pendingPermissionCount: 1 }),
			row("c", { unread: true }),
		]);
		expect(getAttentionSessions(null, noDescendants)).toEqual(
			new Map([
				["a", { questions: 2, permissions: 1 }],
				["b", { questions: 0, permissions: 1 }],
			]),
		);
	});

	it("excludes the current session and its descendants", () => {
		seedSessions([
			row("parent", { pendingQuestionCount: 1 }),
			row("child", { pendingQuestionCount: 1 }),
			row("other", { pendingQuestionCount: 1 }),
		]);
		const descendants = (id: string) =>
			id === "parent" ? new Set(["child"]) : new Set<string>();
		expect([...getAttentionSessions("parent", descendants).keys()]).toEqual([
			"other",
		]);
	});
});
