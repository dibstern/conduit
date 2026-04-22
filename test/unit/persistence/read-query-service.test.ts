// test/unit/persistence/read-query-service.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

function seedSession(
	db: SqliteClient,
	id: string,
	opts?: {
		title?: string;
		status?: string;
		parentId?: string;
		forkPointEvent?: string;
		createdAt?: number;
		updatedAt?: number;
	},
): void {
	const now = Date.now();
	db.execute(
		`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
		 VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)`,
		[
			id,
			opts?.title ?? "Untitled",
			opts?.status ?? "idle",
			opts?.parentId ?? null,
			opts?.forkPointEvent ?? null,
			opts?.createdAt ?? now,
			opts?.updatedAt ?? now,
		],
	);
}

function seedToolContent(
	db: SqliteClient,
	toolId: string,
	sessionId: string,
	content: string,
): void {
	db.execute(
		"INSERT INTO tool_content (tool_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
		[toolId, sessionId, content, Date.now()],
	);
}

function seedPendingApproval(
	db: SqliteClient,
	id: string,
	sessionId: string,
	type: "permission" | "question",
	opts?: {
		status?: string;
		toolName?: string;
		input?: string;
		decision?: string;
	},
): void {
	db.execute(
		`INSERT INTO pending_approvals (id, session_id, type, status, tool_name, input, decision, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			type,
			opts?.status ?? "pending",
			opts?.toolName ?? null,
			opts?.input ?? null,
			opts?.decision ?? null,
			Date.now(),
		],
	);
}

function seedMessage(
	db: SqliteClient,
	id: string,
	sessionId: string,
	role: "user" | "assistant",
	opts?: { text?: string; createdAt?: number; turnId?: string },
): void {
	const now = Date.now();
	db.execute(
		`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			opts?.turnId ?? null,
			role,
			opts?.text ?? "",
			opts?.createdAt ?? now,
			opts?.createdAt ?? now,
		],
	);
}

function seedTurn(
	db: SqliteClient,
	id: string,
	sessionId: string,
	opts?: {
		state?: string;
		requestedAt?: number;
		completedAt?: number;
		cost?: number;
	},
): void {
	db.execute(
		`INSERT INTO turns (id, session_id, state, requested_at, completed_at, cost)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			opts?.state ?? "completed",
			opts?.requestedAt ?? Date.now(),
			opts?.completedAt ?? null,
			opts?.cost ?? null,
		],
	);
}

describe("ReadQueryService", () => {
	let db: SqliteClient;
	let svc: ReadQueryService;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		svc = new ReadQueryService(db);
	});

	afterEach(() => {
		db.close();
	});

	// ── 4a: Tool content ──────────────────────────────────────────────────

	describe("getToolContent", () => {
		it("returns content for a known tool ID", () => {
			seedSession(db, "s1");
			seedToolContent(db, "tool-abc", "s1", '{"result": "hello"}');
			expect(svc.getToolContent("tool-abc")).toBe('{"result": "hello"}');
		});

		it("returns undefined for unknown tool ID", () => {
			expect(svc.getToolContent("nonexistent")).toBeUndefined();
		});
	});

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	describe("getForkMetadata", () => {
		it("returns parent_id and fork_point_event for a forked session", () => {
			seedSession(db, "parent-1");
			seedSession(db, "fork-1", {
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
			const meta = svc.getForkMetadata("fork-1");
			expect(meta).toEqual({
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
		});

		it("returns undefined for a non-forked session", () => {
			seedSession(db, "s1");
			expect(svc.getForkMetadata("s1")).toBeUndefined();
		});

		it("returns undefined for unknown session", () => {
			expect(svc.getForkMetadata("nonexistent")).toBeUndefined();
		});
	});

	// ── 4c: Session list ──────────────────────────────────────────────────

	describe("listSessions", () => {
		it("returns all sessions ordered by updated_at DESC", () => {
			seedSession(db, "s1", { title: "First", updatedAt: 1000 });
			seedSession(db, "s2", { title: "Second", updatedAt: 3000 });
			seedSession(db, "s3", { title: "Third", updatedAt: 2000 });

			const sessions = svc.listSessions();
			expect(sessions.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
			expect(sessions[0]?.title).toBe("Second");
		});

		it("filters to root sessions when roots=true", () => {
			seedSession(db, "parent-1", { title: "Parent" });
			seedSession(db, "child-1", {
				title: "Child",
				parentId: "parent-1",
			});

			const roots = svc.listSessions({ roots: true });
			expect(roots).toHaveLength(1);
			expect(roots[0]?.id).toBe("parent-1");
		});

		it("returns empty array when no sessions exist", () => {
			expect(svc.listSessions()).toEqual([]);
		});
	});

	// ── 4d: Session status ────────────────────────────────────────────────

	describe("getSessionStatus", () => {
		it("returns status for a known session", () => {
			seedSession(db, "s1", { status: "busy" });
			expect(svc.getSessionStatus("s1")).toBe("busy");
		});

		it("returns undefined for unknown session", () => {
			expect(svc.getSessionStatus("nonexistent")).toBeUndefined();
		});
	});

	describe("getAllSessionStatuses", () => {
		it("returns status map for all sessions", () => {
			seedSession(db, "s1", { status: "idle" });
			seedSession(db, "s2", { status: "busy" });
			const statuses = svc.getAllSessionStatuses();
			expect(statuses).toEqual({ s1: "idle", s2: "busy" });
		});
	});

	// ── 4e: Session history ───────────────────────────────────────────────

	describe("getSessionMessages", () => {
		it("returns messages ordered by created_at ASC", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", { text: "hello", createdAt: 1000 });
			seedMessage(db, "m2", "s1", "assistant", {
				text: "hi there",
				createdAt: 2000,
			});

			const msgs = svc.getSessionMessages("s1");
			expect(msgs).toHaveLength(2);
			expect(msgs[0]?.id).toBe("m1");
			expect(msgs[0]?.role).toBe("user");
			expect(msgs[1]?.id).toBe("m2");
			expect(msgs[1]?.role).toBe("assistant");
		});

		it("supports limit and before cursor for pagination", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", { createdAt: 1000 });
			seedMessage(db, "m2", "s1", "assistant", { createdAt: 2000 });
			seedMessage(db, "m3", "s1", "user", { createdAt: 3000 });

			// Get latest 2 (over-fetches by 1, so 3 rows returned)
			const page1 = svc.getSessionMessages("s1", { limit: 2 });
			expect(page1).toHaveLength(3); // limit+1 over-fetch (Perf-Fix-6)
			// Messages are ordered oldest-first
			expect(page1[0]?.id).toBe("m1");
			expect(page1[1]?.id).toBe("m2");
			expect(page1[2]?.id).toBe("m3");

			// NOTE (Perf-Fix-6): This test was updated from the original
			// `beforeMessageId` parameter to use the composite cursor
			// (beforeCreatedAt, beforeId). See perf-fixes Task 6.
			// Get messages before m2 using composite cursor
			const page2 = svc.getSessionMessages("s1", {
				limit: 10,
				beforeCreatedAt: 2000,
				beforeId: "m2",
			});
			expect(page2).toHaveLength(1);
			expect(page2[0]?.id).toBe("m1");
		});

		it("returns empty array for unknown session", () => {
			expect(svc.getSessionMessages("nonexistent")).toEqual([]);
		});
	});

	// (Perf-Fix-6) Composite cursor pagination test
	describe("getSessionMessages cursor pagination", () => {
		it("composite cursor paginates correctly with same-timestamp messages", () => {
			seedSession(db, "s1");
			// Seed 5 messages with the same created_at but different IDs
			const ts = Date.now();
			for (const id of ["m-a", "m-b", "m-c", "m-d", "m-e"]) {
				db.execute(
					`INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
					 VALUES (?, 's1', 'user', '', 0, ?, ?)`,
					[id, ts, ts],
				);
			}

			// Page 1: limit=2 over-fetches by 1 (I7), so returns 3 rows.
			// Caller detects hasMore when rows.length > limit, then slices to limit.
			const page1Raw = svc.getSessionMessages("s1", { limit: 2 });
			expect(page1Raw).toHaveLength(3); // limit+1 over-fetch
			const page1 = page1Raw.slice(0, 2); // caller slices to actual limit

			// Page 2: using cursor from last displayed item of page 1
			// biome-ignore lint/style/noNonNullAssertion: test assertion after length check
			const lastItem = page1[page1.length - 1]!;
			const page2Raw = svc.getSessionMessages("s1", {
				limit: 2,
				beforeCreatedAt: lastItem.created_at,
				beforeId: lastItem.id,
			});
			// 3 messages remain before cursor (m-a, m-b, m-c), over-fetch limit+1=3
			expect(page2Raw.length).toBeGreaterThanOrEqual(2);
			const page2 = page2Raw.slice(0, 2);

			// No overlap between pages
			const page1Ids = new Set(page1.map((m) => m.id));
			const page2Ids = new Set(page2.map((m) => m.id));
			for (const id of page2Ids) {
				expect(page1Ids.has(id)).toBe(false);
			}
		});
	});

	describe("getSessionTurns", () => {
		it("returns turns ordered by requested_at ASC", () => {
			seedSession(db, "s1");
			seedTurn(db, "t1", "s1", { requestedAt: 1000, state: "completed" });
			seedTurn(db, "t2", "s1", { requestedAt: 2000, state: "pending" });

			const turns = svc.getSessionTurns("s1");
			expect(turns).toHaveLength(2);
			expect(turns[0]?.id).toBe("t1");
			expect(turns[1]?.id).toBe("t2");
		});
	});

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	describe("getPendingApprovals", () => {
		it("returns only pending approvals across all sessions", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission", {
				status: "pending",
				toolName: "bash",
			});
			seedPendingApproval(db, "p2", "s1", "permission", {
				status: "resolved",
				toolName: "read",
			});
			seedPendingApproval(db, "q1", "s2", "question", { status: "pending" });

			const pending = svc.getPendingApprovals();
			expect(pending).toHaveLength(2);
			expect(pending.map((p) => p.id).sort()).toEqual(["p1", "q1"]);
		});

		it("returns empty array when nothing is pending", () => {
			expect(svc.getPendingApprovals()).toEqual([]);
		});
	});

	describe("getPendingApprovalsForSession", () => {
		it("returns pending approvals filtered by session", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission", { status: "pending" });
			seedPendingApproval(db, "p2", "s2", "permission", { status: "pending" });

			const s1Pending = svc.getPendingApprovalsForSession("s1");
			expect(s1Pending).toHaveLength(1);
			expect(s1Pending[0]?.id).toBe("p1");
		});
	});
});
