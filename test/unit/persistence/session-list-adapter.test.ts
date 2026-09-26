// test/unit/persistence/session-list-adapter.test.ts
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../../src/lib/persistence/read-query-service.js";
import { sessionRowsToSessionInfoList } from "../../../src/lib/persistence/session-list-adapter.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		last_message_at: null,
		last_turn_error_at: null,
		permission_mode: null,
		read_at: null,
		settled_at: null,
		pinned_at: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

// ─── sessionRowsToSessionInfoList ─────────────────────────────────────────

describe("sessionRowsToSessionInfoList", () => {
	it("carries settled and pinned timestamps and omits NULL values", () => {
		const [set, unset] = sessionRowsToSessionInfoList([
			makeRow("set", { settled_at: 0, pinned_at: 456 }),
			makeRow("unset"),
		]);
		expect(set).toMatchObject({ settledAt: 0, pinnedAt: 456 });
		expect(unset).not.toHaveProperty("settledAt");
		expect(unset).not.toHaveProperty("pinnedAt");
	});

	it("rolls nested descendant counts and activity into roots only", () => {
		const rows = [
			makeRow("root"),
			makeRow("child", { parent_id: "root" }),
			makeRow("grandchild", { parent_id: "child" }),
			makeRow("other"),
		];
		const options = {
			parentMap: new Map([
				["child", "root"],
				["grandchild", "child"],
			]),
			statuses: { grandchild: { type: "retry" } },
			pendingPermissionCounts: new Map([
				["root", 1],
				["grandchild", 2],
			]),
			pendingQuestionCounts: new Map([
				["child", 3],
				["grandchild", 4],
			]),
		};
		const [root, child, grandchild, other] = sessionRowsToSessionInfoList(
			rows,
			options,
		);
		expect(root).toMatchObject({
			processing: true,
			pendingPermissionCount: 3,
			pendingQuestionCount: 7,
			attention: "needs-approval",
		});
		expect(child).toMatchObject({
			pendingQuestionCount: 3,
			attention: "needs-reply",
		});
		expect(child?.processing).toBeUndefined();
		expect(child?.pendingPermissionCount).toBeUndefined();
		expect(grandchild).toMatchObject({
			processing: true,
			pendingPermissionCount: 2,
			pendingQuestionCount: 4,
		});
		expect(other).toMatchObject({ attention: "idle" });
		expect(other?.processing).toBeUndefined();
		// Root-only query results must still include grandchildren's state.
		expect(sessionRowsToSessionInfoList([makeRow("root")], options)[0]).toEqual(
			root,
		);
		// Family snapshots retain each session's independent state.
		const { parentMap: _, ...ownStateOptions } = options;
		const ownRoot = sessionRowsToSessionInfoList(rows, ownStateOptions)[0];
		expect(ownRoot?.pendingPermissionCount).toBe(1);
		expect(ownRoot?.pendingQuestionCount).toBeUndefined();
		expect(ownRoot?.processing).toBeUndefined();
	});

	it("preserves attention priority after subtree rollup", () => {
		const parentMap = new Map([
			["child", "root"],
			["grandchild", "child"],
		]);
		const options = { parentMap, statuses: { grandchild: { type: "busy" } } };
		const error = makeRow("root", { last_turn_error_at: 1 });
		expect(sessionRowsToSessionInfoList([error], options)[0]?.attention).toBe(
			"error",
		);
		expect(
			sessionRowsToSessionInfoList([error], {
				...options,
				pendingQuestionCounts: new Map([["grandchild", 1]]),
			})[0]?.attention,
		).toBe("needs-reply");
		expect(
			sessionRowsToSessionInfoList(
				[makeRow("root", { last_message_at: 1 })],
				options,
			)[0]?.attention,
		).toBe("working");
	});

	it("converts session rows to SessionInfo format", () => {
		const rows: SessionRow[] = [
			makeRow("s1", { title: "First", updated_at: 3000 }),
			makeRow("s2", { title: "Second", updated_at: 1000 }),
		];

		const result = sessionRowsToSessionInfoList(rows);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: "s1",
			title: "First",
			updatedAt: 3000,
			messageCount: 0,
			attention: "idle",
		});
		expect(result[1]).toEqual({
			id: "s2",
			title: "Second",
			updatedAt: 1000,
			messageCount: 0,
			attention: "idle",
		});
	});

	it("includes parentID and forkMessageId for forked sessions", () => {
		const rows: SessionRow[] = [
			makeRow("fork-1", {
				parent_id: "parent-1",
				fork_point_event: "msg-42",
			}),
		];

		const result = sessionRowsToSessionInfoList(rows);
		const [row] = result;
		expect(row?.parentID).toBe("parent-1");
		expect(row?.forkMessageId).toBe("msg-42");
	});

	it("uses service fork metadata when SQLite row lacks fork details", () => {
		const rows: SessionRow[] = [makeRow("fork-1")];

		const result = sessionRowsToSessionInfoList(rows, {
			forkMeta: new Map([
				[
					"fork-1",
					{
						parentID: "parent-1",
						forkMessageId: "msg-42",
						forkPointTimestamp: 1234,
					},
				],
			]),
		});

		expect(result[0]).toEqual({
			id: "fork-1",
			title: "Untitled",
			updatedAt: 2000,
			messageCount: 0,
			parentID: "parent-1",
			forkMessageId: "msg-42",
			forkPointTimestamp: 1234,
			attention: "idle",
		});
	});

	it("omits parentID and forkMessageId when not a fork", () => {
		const rows: SessionRow[] = [makeRow("s1")];
		const result = sessionRowsToSessionInfoList(rows);
		const [row] = result;
		expect(row?.parentID).toBeUndefined();
		expect(row?.forkMessageId).toBeUndefined();
	});

	it("includes processing flag when session is busy", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const statuses = {
			s1: { type: "busy" as const },
			s2: { type: "idle" as const },
		};

		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBe(true);
		expect(result[1]?.processing).toBeUndefined();
	});

	it("includes processing flag when session is in retry state", () => {
		const rows: SessionRow[] = [makeRow("s1")];
		const statuses = { s1: { type: "retry" as const } };

		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBe(true);
	});

	it("does not set processing for idle/error statuses", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const statuses = {
			s1: { type: "error" },
			s2: { type: "idle" },
		};
		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0]?.processing).toBeUndefined();
		expect(result[1]?.processing).toBeUndefined();
	});

	it("includes pending attention counts when present and > 0", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const pendingQuestionCounts = new Map([
			["s1", 3],
			["s2", 0],
		]);
		const pendingPermissionCounts = new Map([
			["s1", 2],
			["s2", 0],
		]);

		const result = sessionRowsToSessionInfoList(rows, {
			pendingQuestionCounts,
			pendingPermissionCounts,
		});
		expect(result[0]?.pendingQuestionCount).toBe(3);
		expect(result[0]?.pendingPermissionCount).toBe(2);
		expect(result[1]?.pendingQuestionCount).toBeUndefined();
		expect(result[1]?.pendingPermissionCount).toBeUndefined();
	});

	it("derives unread only when activity postdates the last read", () => {
		const result = sessionRowsToSessionInfoList([
			makeRow("never-read", { last_message_at: 200, read_at: null }),
			makeRow("activity-after-read", { last_message_at: 300, read_at: 200 }),
			makeRow("read-after-activity", { last_message_at: 300, read_at: 400 }),
			makeRow("no-activity", { last_message_at: null, read_at: null }),
		]);

		expect(result[0]?.unread).toBe(true);
		expect(result[1]?.unread).toBe(true);
		expect(result[2]).not.toHaveProperty("unread");
		expect(result[3]).not.toHaveProperty("unread");
	});

	it("derives needs-approval before every lower tier", () => {
		const result = sessionRowsToSessionInfoList(
			[
				makeRow("s1", {
					status: "busy",
					last_turn_error_at: 150,
					last_message_at: 200,
				}),
			],
			{
				pendingPermissionCounts: new Map([["s1", 1]]),
				pendingQuestionCounts: new Map([["s1", 1]]),
			},
		);

		expect(result[0]?.attention).toBe("needs-approval");
	});

	it("derives needs-reply before error, working, and unread", () => {
		const result = sessionRowsToSessionInfoList(
			[
				makeRow("s1", {
					status: "busy",
					last_turn_error_at: 150,
					last_message_at: 200,
				}),
			],
			{ pendingQuestionCounts: new Map([["s1", 1]]) },
		);

		expect(result[0]?.attention).toBe("needs-reply");
	});

	it("derives error before working and unread", () => {
		const result = sessionRowsToSessionInfoList([
			makeRow("s1", {
				status: "busy",
				last_turn_error_at: 150,
				last_message_at: 200,
			}),
		]);

		expect(result[0]?.attention).toBe("error");
	});

	it("derives working before unread from live status", () => {
		const result = sessionRowsToSessionInfoList(
			[makeRow("s1", { last_message_at: 200 })],
			{ statuses: { s1: { type: "retry" } } },
		);

		expect(result[0]?.attention).toBe("working");
	});

	it("derives done-unread from unread activity", () => {
		const result = sessionRowsToSessionInfoList([
			makeRow("s1", { last_message_at: 200 }),
		]);

		expect(result[0]?.attention).toBe("done-unread");
	});

	it("derives idle when no higher tier matches", () => {
		expect(sessionRowsToSessionInfoList([makeRow("s1")])[0]?.attention).toBe(
			"idle",
		);
	});

	it("falls back to the projected status for a cold row", () => {
		const result = sessionRowsToSessionInfoList([
			makeRow("s1", { status: "busy" }),
		]);

		expect(result[0]?.attention).toBe("working");
	});

	it("prefers a live status over the projected status", () => {
		const result = sessionRowsToSessionInfoList(
			[makeRow("s1", { status: "busy" })],
			{ statuses: { s1: { type: "idle" } } },
		);

		expect(result[0]?.attention).toBe("idle");
	});

	it("returns empty array for empty input", () => {
		expect(sessionRowsToSessionInfoList([])).toEqual([]);
	});
});
