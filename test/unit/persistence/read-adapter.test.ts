// test/unit/persistence/read-adapter.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { ReadAdapter } from "../../../src/lib/persistence/read-adapter.js";
import { createReadFlags } from "../../../src/lib/persistence/read-flags.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

// ─── Seed helpers (shared pattern from read-query-service.test.ts) ──────────

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

function seedMessage(
	db: SqliteClient,
	id: string,
	sessionId: string,
	role: "user" | "assistant",
	opts?: { text?: string; createdAt?: number },
): void {
	const now = Date.now();
	db.execute(
		`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			role,
			opts?.text ?? "",
			opts?.createdAt ?? now,
			opts?.createdAt ?? now,
		],
	);
}

function seedPendingApproval(
	db: SqliteClient,
	id: string,
	sessionId: string,
	type: "permission" | "question",
	opts?: { status?: string; toolName?: string },
): void {
	db.execute(
		`INSERT INTO pending_approvals (id, session_id, type, status, tool_name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			type,
			opts?.status ?? "pending",
			opts?.toolName ?? null,
			Date.now(),
		],
	);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ReadAdapter", () => {
	let db: SqliteClient;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		readQuery = new ReadQueryService(db);
	});

	afterEach(() => {
		db.close();
	});

	// ── Construction ──────────────────────────────────────────────────────

	describe("isConfigured", () => {
		it("returns true when both readQuery and readFlags are available", () => {
			const flags = createReadFlags();
			const adapter = new ReadAdapter(readQuery, flags);
			expect(adapter.isConfigured).toBe(true);
		});

		it("returns false when readQuery is undefined", () => {
			const flags = createReadFlags();
			const adapter = new ReadAdapter(undefined, flags);
			expect(adapter.isConfigured).toBe(false);
		});

		it("returns false when readFlags is undefined", () => {
			const adapter = new ReadAdapter(readQuery, undefined);
			expect(adapter.isConfigured).toBe(false);
		});

		it("returns false when both are undefined", () => {
			const adapter = new ReadAdapter(undefined, undefined);
			expect(adapter.isConfigured).toBe(false);
		});
	});

	// ── Mode helpers ──────────────────────────────────────────────────────

	describe("isSqliteFor / getMode", () => {
		it("returns correct mode for each flag", () => {
			const flags = createReadFlags({
				toolContent: "sqlite",
				sessionList: "shadow",
			});
			const adapter = new ReadAdapter(readQuery, flags);
			expect(adapter.isSqliteFor("toolContent")).toBe(true);
			expect(adapter.isSqliteFor("sessionList")).toBe(false);
			expect(adapter.isSqliteFor("sessionStatus")).toBe(false);
			expect(adapter.getMode("toolContent")).toBe("sqlite");
			expect(adapter.getMode("sessionList")).toBe("shadow");
			expect(adapter.getMode("sessionStatus")).toBe("legacy");
		});

		it("returns undefined mode when flags are not available", () => {
			const adapter = new ReadAdapter(readQuery, undefined);
			expect(adapter.getMode("toolContent")).toBeUndefined();
			expect(adapter.isSqliteFor("toolContent")).toBe(false);
		});
	});

	// ── 4a: Tool content ──────────────────────────────────────────────────

	describe("getToolContent", () => {
		it("returns content from SQLite when flag is sqlite", () => {
			seedSession(db, "s1");
			seedToolContent(db, "tool-1", "s1", "result data");
			const flags = createReadFlags({ toolContent: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getToolContent("tool-1")).toBe("result data");
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1");
			seedToolContent(db, "tool-1", "s1", "result data");
			const flags = createReadFlags({ toolContent: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getToolContent("tool-1")).toBeUndefined();
		});

		it("returns undefined when flag is shadow", () => {
			seedSession(db, "s1");
			seedToolContent(db, "tool-1", "s1", "result data");
			const flags = createReadFlags({ toolContent: "shadow" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getToolContent("tool-1")).toBeUndefined();
		});

		it("returns undefined when readQuery is not available", () => {
			const flags = createReadFlags({ toolContent: "sqlite" });
			const adapter = new ReadAdapter(undefined, flags);
			expect(adapter.getToolContent("tool-1")).toBeUndefined();
		});

		it("returns undefined when readFlags is not available", () => {
			const adapter = new ReadAdapter(readQuery, undefined);
			expect(adapter.getToolContent("tool-1")).toBeUndefined();
		});
	});

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	describe("getForkMetadata", () => {
		it("returns metadata from SQLite when flag is sqlite", () => {
			seedSession(db, "parent-1");
			seedSession(db, "fork-1", {
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
			const flags = createReadFlags({ forkMetadata: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getForkMetadata("fork-1")).toEqual({
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "parent-1");
			seedSession(db, "fork-1", {
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
			const flags = createReadFlags({ forkMetadata: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getForkMetadata("fork-1")).toBeUndefined();
		});

		it("returns undefined for non-forked session even when sqlite", () => {
			seedSession(db, "s1");
			const flags = createReadFlags({ forkMetadata: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getForkMetadata("s1")).toBeUndefined();
		});
	});

	// ── 4c: Session list ──────────────────────────────────────────────────

	describe("listSessions", () => {
		it("returns sessions from SQLite when flag is sqlite", () => {
			seedSession(db, "s1", { title: "First", updatedAt: 1000 });
			seedSession(db, "s2", { title: "Second", updatedAt: 2000 });
			const flags = createReadFlags({ sessionList: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			const sessions = adapter.listSessions();
			expect(sessions).toHaveLength(2);
			expect(sessions?.[0]?.title).toBe("Second");
		});

		it("supports roots filter", () => {
			seedSession(db, "parent-1", { title: "Parent" });
			seedSession(db, "child-1", {
				title: "Child",
				parentId: "parent-1",
			});
			const flags = createReadFlags({ sessionList: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			const roots = adapter.listSessions({ roots: true });
			expect(roots).toHaveLength(1);
			expect(roots?.[0]?.id).toBe("parent-1");
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1");
			const flags = createReadFlags({ sessionList: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.listSessions()).toBeUndefined();
		});
	});

	// ── 4d: Session status ────────────────────────────────────────────────

	describe("getSessionStatus", () => {
		it("returns status from SQLite when flag is sqlite", () => {
			seedSession(db, "s1", { status: "busy" });
			const flags = createReadFlags({ sessionStatus: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getSessionStatus("s1")).toBe("busy");
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1", { status: "busy" });
			const flags = createReadFlags({ sessionStatus: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getSessionStatus("s1")).toBeUndefined();
		});
	});

	describe("getAllSessionStatuses", () => {
		it("returns all statuses from SQLite when flag is sqlite", () => {
			seedSession(db, "s1", { status: "idle" });
			seedSession(db, "s2", { status: "busy" });
			const flags = createReadFlags({ sessionStatus: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getAllSessionStatuses()).toEqual({
				s1: "idle",
				s2: "busy",
			});
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1", { status: "idle" });
			const flags = createReadFlags({ sessionStatus: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getAllSessionStatuses()).toBeUndefined();
		});
	});

	// ── 4e: Session history ───────────────────────────────────────────────

	describe("getSessionMessages", () => {
		it("returns messages from SQLite when flag is sqlite", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", {
				text: "hello",
				createdAt: 1000,
			});
			seedMessage(db, "m2", "s1", "assistant", {
				text: "hi",
				createdAt: 2000,
			});
			const flags = createReadFlags({ sessionHistory: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			const msgs = adapter.getSessionMessages("s1");
			expect(msgs).toHaveLength(2);
			expect(msgs?.[0]?.id).toBe("m1");
			expect(msgs?.[1]?.id).toBe("m2");
		});

		it("supports pagination options", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", { createdAt: 1000 });
			seedMessage(db, "m2", "s1", "assistant", { createdAt: 2000 });
			seedMessage(db, "m3", "s1", "user", { createdAt: 3000 });
			const flags = createReadFlags({ sessionHistory: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			// limit=2 with over-fetch (Perf-Fix-6)
			const msgs = adapter.getSessionMessages("s1", { limit: 2 });
			expect(msgs).toHaveLength(3); // over-fetch by 1
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user");
			const flags = createReadFlags({ sessionHistory: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getSessionMessages("s1")).toBeUndefined();
		});
	});

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	describe("getPendingApprovals", () => {
		it("returns all pending approvals from SQLite when flag is sqlite", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission", {
				status: "pending",
			});
			seedPendingApproval(db, "p2", "s2", "question", {
				status: "pending",
			});
			seedPendingApproval(db, "p3", "s1", "permission", {
				status: "resolved",
			});
			const flags = createReadFlags({ pendingApprovals: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			const approvals = adapter.getPendingApprovals();
			expect(approvals).toHaveLength(2);
			expect(approvals?.map((a) => a.id).sort()).toEqual(["p1", "p2"]);
		});

		it("filters by session when sessionId is provided", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission");
			seedPendingApproval(db, "p2", "s2", "permission");
			const flags = createReadFlags({ pendingApprovals: "sqlite" });
			const adapter = new ReadAdapter(readQuery, flags);

			const approvals = adapter.getPendingApprovals("s1");
			expect(approvals).toHaveLength(1);
			expect(approvals?.[0]?.id).toBe("p1");
		});

		it("returns undefined when flag is legacy", () => {
			seedSession(db, "s1");
			seedPendingApproval(db, "p1", "s1", "permission");
			const flags = createReadFlags({ pendingApprovals: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getPendingApprovals()).toBeUndefined();
		});

		it("returns undefined when flag is shadow", () => {
			seedSession(db, "s1");
			seedPendingApproval(db, "p1", "s1", "permission");
			const flags = createReadFlags({ pendingApprovals: "shadow" });
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getPendingApprovals()).toBeUndefined();
		});
	});

	// ── Flag transitions ──────────────────────────────────────────────────

	describe("runtime flag transitions", () => {
		it("responds to flag changes at runtime (legacy -> sqlite -> legacy)", () => {
			seedSession(db, "s1", { status: "busy" });
			const flags = createReadFlags({ sessionStatus: "legacy" });
			const adapter = new ReadAdapter(readQuery, flags);

			// Initially legacy — adapter returns undefined
			expect(adapter.getSessionStatus("s1")).toBeUndefined();

			// Switch to sqlite at runtime
			flags.sessionStatus = "sqlite";
			expect(adapter.getSessionStatus("s1")).toBe("busy");

			// Switch back to legacy
			flags.sessionStatus = "legacy";
			expect(adapter.getSessionStatus("s1")).toBeUndefined();
		});
	});
});
