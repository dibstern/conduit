// test/unit/persistence/read-switchover.test.ts
// ─── Phase 4 Read Switchover Integration Tests ─────────────────────────────
// Validates that ReadQueryService + ReadFlags + ReadAdapter work together
// end-to-end: when flags are "legacy", the adapter returns undefined (caller
// uses legacy source); when flags are "sqlite", data comes from SQLite.
//
// Also validates the relay-stack wiring pattern: readAdapter is only created
// when persistence is available and includes both readQuery and readFlags.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { ReadAdapter } from "../../../src/lib/persistence/read-adapter.js";
import {
	createReadFlags,
	type ReadFlagConfig,
} from "../../../src/lib/persistence/read-flags.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

// ─── Seed helpers ───────────────────────────────────────────────────────────

function seedSession(
	db: SqliteClient,
	id: string,
	opts?: {
		title?: string;
		status?: string;
		parentId?: string;
		forkPointEvent?: string;
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
			now,
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

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("Phase 4 Read Switchover (integration)", () => {
	let db: SqliteClient;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		readQuery = new ReadQueryService(db);

		// Seed a realistic set of data
		seedSession(db, "s1", {
			title: "Main session",
			status: "busy",
			updatedAt: 3000,
		});
		seedSession(db, "s2", {
			title: "Background",
			status: "idle",
			updatedAt: 2000,
		});
		seedSession(db, "fork-1", {
			title: "Fork",
			status: "idle",
			parentId: "s1",
			forkPointEvent: "evt-99",
			updatedAt: 1000,
		});
		seedToolContent(db, "tool-abc", "s1", '{"result": "file contents"}');
		seedToolContent(db, "tool-def", "s1", "large output...");
		seedMessage(db, "m1", "s1", "user", { text: "hello", createdAt: 1000 });
		seedMessage(db, "m2", "s1", "assistant", {
			text: "hi there",
			createdAt: 2000,
		});
		seedMessage(db, "m3", "s2", "user", { text: "test", createdAt: 3000 });
		seedPendingApproval(db, "perm-1", "s1", "permission", {
			status: "pending",
			toolName: "bash",
		});
		seedPendingApproval(db, "q-1", "s2", "question", { status: "pending" });
		seedPendingApproval(db, "perm-2", "s1", "permission", {
			status: "resolved",
		});
	});

	afterEach(() => {
		db.close();
	});

	// ── Relay-stack wiring pattern ──────────────────────────────────────

	describe("relay-stack wiring pattern", () => {
		it("creates ReadAdapter when persistence is available", () => {
			// Simulates: const readQuery = new ReadQueryService(persistence.db);
			//            const readFlags = createReadFlags(config.readFlags);
			//            const readAdapter = new ReadAdapter(readQuery, readFlags);
			const readFlags = createReadFlags();
			const adapter = new ReadAdapter(readQuery, readFlags);
			expect(adapter.isConfigured).toBe(true);
		});

		it("ReadAdapter is undefined when no persistence (no SQLite)", () => {
			// Simulates: const readQuery = config.persistence ? ... : undefined;
			const noPersistenceQuery = undefined;
			const noPersistenceFlags = undefined;
			const adapter =
				noPersistenceQuery && noPersistenceFlags
					? new ReadAdapter(noPersistenceQuery, noPersistenceFlags)
					: undefined;
			expect(adapter).toBeUndefined();
		});
	});

	// ── All flags legacy (default) — adapter returns undefined for everything ──

	describe("all flags legacy (default)", () => {
		it("returns undefined for all read paths", () => {
			const flags = createReadFlags(); // all legacy
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.getToolContent("tool-abc")).toBeUndefined();
			expect(adapter.getForkMetadata("fork-1")).toBeUndefined();
			expect(adapter.listSessions()).toBeUndefined();
			expect(adapter.getSessionStatus("s1")).toBeUndefined();
			expect(adapter.getAllSessionStatuses()).toBeUndefined();
			expect(adapter.getSessionMessages("s1")).toBeUndefined();
			expect(adapter.getPendingApprovals()).toBeUndefined();
			expect(adapter.getPendingApprovals("s1")).toBeUndefined();
		});
	});

	// ── All flags sqlite — data comes from SQLite ──────────────────────

	describe("all flags sqlite", () => {
		let adapter: ReadAdapter;

		beforeEach(() => {
			const flags = createReadFlags({
				toolContent: "sqlite",
				forkMetadata: "sqlite",
				sessionList: "sqlite",
				sessionStatus: "sqlite",
				sessionHistory: "sqlite",
				pendingApprovals: "sqlite",
			});
			adapter = new ReadAdapter(readQuery, flags);
		});

		it("getToolContent returns content from SQLite", () => {
			expect(adapter.getToolContent("tool-abc")).toBe(
				'{"result": "file contents"}',
			);
			expect(adapter.getToolContent("nonexistent")).toBeUndefined();
		});

		it("getForkMetadata returns fork info from SQLite", () => {
			expect(adapter.getForkMetadata("fork-1")).toEqual({
				parentId: "s1",
				forkPointEvent: "evt-99",
			});
			expect(adapter.getForkMetadata("s1")).toBeUndefined(); // not a fork
		});

		it("listSessions returns all sessions from SQLite", () => {
			const sessions = adapter.listSessions();
			expect(sessions).toHaveLength(3);
			// Ordered by updated_at DESC
			expect(sessions?.[0]?.id).toBe("s1");
			expect(sessions?.[1]?.id).toBe("s2");
			expect(sessions?.[2]?.id).toBe("fork-1");
		});

		it("listSessions with roots filter excludes forks", () => {
			const roots = adapter.listSessions({ roots: true });
			expect(roots).toHaveLength(2);
			expect(roots?.map((s) => s.id)).toContain("s1");
			expect(roots?.map((s) => s.id)).toContain("s2");
			expect(roots?.map((s) => s.id)).not.toContain("fork-1");
		});

		it("getSessionStatus returns status from SQLite", () => {
			expect(adapter.getSessionStatus("s1")).toBe("busy");
			expect(adapter.getSessionStatus("s2")).toBe("idle");
		});

		it("getAllSessionStatuses returns status map from SQLite", () => {
			const statuses = adapter.getAllSessionStatuses();
			expect(statuses).toEqual({
				s1: "busy",
				s2: "idle",
				"fork-1": "idle",
			});
		});

		it("getSessionMessages returns messages from SQLite", () => {
			const msgs = adapter.getSessionMessages("s1");
			expect(msgs).toHaveLength(2);
			expect(msgs?.[0]?.role).toBe("user");
			expect(msgs?.[0]?.text).toBe("hello");
			expect(msgs?.[1]?.role).toBe("assistant");
		});

		it("getPendingApprovals returns all pending from SQLite", () => {
			const approvals = adapter.getPendingApprovals();
			expect(approvals).toHaveLength(2);
			expect(approvals?.map((a) => a.id).sort()).toEqual(["perm-1", "q-1"]);
		});

		it("getPendingApprovals with sessionId filters correctly", () => {
			const s1Approvals = adapter.getPendingApprovals("s1");
			expect(s1Approvals).toHaveLength(1);
			expect(s1Approvals?.[0]?.id).toBe("perm-1");

			const s2Approvals = adapter.getPendingApprovals("s2");
			expect(s2Approvals).toHaveLength(1);
			expect(s2Approvals?.[0]?.id).toBe("q-1");
		});
	});

	// ── Mixed flags (partial switchover) ─────────────────────────────────

	describe("mixed flags (partial switchover)", () => {
		it("only returns data for sqlite-flagged sub-phases", () => {
			const flags = createReadFlags({
				toolContent: "sqlite",
				sessionStatus: "sqlite",
				// rest are legacy
			});
			const adapter = new ReadAdapter(readQuery, flags);

			// sqlite flags → returns data
			expect(adapter.getToolContent("tool-abc")).toBe(
				'{"result": "file contents"}',
			);
			expect(adapter.getSessionStatus("s1")).toBe("busy");

			// legacy flags → returns undefined
			expect(adapter.getForkMetadata("fork-1")).toBeUndefined();
			expect(adapter.listSessions()).toBeUndefined();
			expect(adapter.getSessionMessages("s1")).toBeUndefined();
			expect(adapter.getPendingApprovals()).toBeUndefined();
		});
	});

	// ── Shadow mode ─────────────────────────────────────────────────────

	describe("shadow mode returns undefined (legacy is authoritative)", () => {
		it("returns undefined for all shadow-flagged sub-phases", () => {
			const flags = createReadFlags({
				toolContent: "shadow",
				forkMetadata: "shadow",
				sessionList: "shadow",
				sessionStatus: "shadow",
				sessionHistory: "shadow",
				pendingApprovals: "shadow",
			});
			const adapter = new ReadAdapter(readQuery, flags);

			// Shadow means legacy is authoritative — adapter returns undefined
			// (the ShadowReadComparator handles the background comparison)
			expect(adapter.getToolContent("tool-abc")).toBeUndefined();
			expect(adapter.getForkMetadata("fork-1")).toBeUndefined();
			expect(adapter.listSessions()).toBeUndefined();
			expect(adapter.getSessionStatus("s1")).toBeUndefined();
			expect(adapter.getAllSessionStatuses()).toBeUndefined();
			expect(adapter.getSessionMessages("s1")).toBeUndefined();
			expect(adapter.getPendingApprovals()).toBeUndefined();
		});
	});

	// ── Progressive flag promotion ──────────────────────────────────────

	describe("progressive flag promotion (legacy -> shadow -> sqlite)", () => {
		it("adapter dynamically responds to flag changes", () => {
			const flags = createReadFlags(); // all legacy
			const adapter = new ReadAdapter(readQuery, flags);

			// Phase 1: legacy — no SQLite reads
			expect(adapter.getToolContent("tool-abc")).toBeUndefined();
			expect(adapter.getSessionStatus("s1")).toBeUndefined();

			// Phase 2: promote toolContent to shadow — still no authoritative reads
			flags.toolContent = "shadow";
			expect(adapter.getToolContent("tool-abc")).toBeUndefined();

			// Phase 3: promote toolContent to sqlite — SQLite is now authoritative
			flags.toolContent = "sqlite";
			expect(adapter.getToolContent("tool-abc")).toBe(
				'{"result": "file contents"}',
			);

			// Phase 4: promote sessionStatus too
			flags.sessionStatus = "sqlite";
			expect(adapter.getSessionStatus("s1")).toBe("busy");

			// sessionList is still legacy
			expect(adapter.listSessions()).toBeUndefined();

			// Phase 5: promote remaining
			flags.forkMetadata = "sqlite";
			flags.sessionList = "sqlite";
			flags.sessionHistory = "sqlite";
			flags.pendingApprovals = "sqlite";

			expect(adapter.getForkMetadata("fork-1")).toEqual({
				parentId: "s1",
				forkPointEvent: "evt-99",
			});
			expect(adapter.listSessions()).toHaveLength(3);
			expect(adapter.getSessionMessages("s1")).toHaveLength(2);
			expect(adapter.getPendingApprovals()).toHaveLength(2);
		});
	});

	// ── createReadFlags config integration ──────────────────────────────

	describe("createReadFlags config integration", () => {
		it("relay config readFlags propagate to adapter", () => {
			// Simulates: config.readFlags = { toolContent: "sqlite", sessionList: "sqlite" }
			const configReadFlags: ReadFlagConfig = {
				toolContent: "sqlite",
				sessionList: "sqlite",
			};
			const flags = createReadFlags(configReadFlags);
			const adapter = new ReadAdapter(readQuery, flags);

			expect(adapter.isSqliteFor("toolContent")).toBe(true);
			expect(adapter.isSqliteFor("sessionList")).toBe(true);
			expect(adapter.isSqliteFor("forkMetadata")).toBe(false);
			expect(adapter.isSqliteFor("sessionStatus")).toBe(false);
		});
	});
});
