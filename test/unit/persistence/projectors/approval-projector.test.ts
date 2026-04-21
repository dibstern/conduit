// test/unit/persistence/projectors/approval-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type PermissionAskedPayload,
	type PermissionResolvedPayload,
	type QuestionAskedPayload,
	type QuestionResolvedPayload,
	type StoredEvent,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { ApprovalProjector } from "../../../../src/lib/persistence/projectors/approval-projector.js";
import { decodeJson } from "../../../../src/lib/persistence/projectors/projector.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface ApprovalRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	type: string;
	status: string;
	tool_name: string | null;
	input: string | null;
	decision: string | null;
	created_at: number;
	resolved_at: number | null;
}

describe("ApprovalProjector", () => {
	let db: SqliteClient;
	let projector: ApprovalProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ApprovalProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("approval");
		expect(projector.handles).toEqual([
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
		]);
	});

	describe("permission.asked", () => {
		it("inserts a pending permission approval", () => {
			const event = makeStored(
				"permission.asked",
				"s1",
				{
					id: "perm-1",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "rm -rf /" },
				} satisfies PermissionAskedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(row).toBeDefined();
			expect(row?.id).toBe("perm-1");
			expect(row?.session_id).toBe("s1");
			expect(row?.type).toBe("permission");
			expect(row?.status).toBe("pending");
			expect(row?.tool_name).toBe("bash");
			// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(row).toBeDefined()
			expect(decodeJson(row!.input)).toEqual({ command: "rm -rf /" });
			expect(row?.decision).toBeNull();
			expect(row?.created_at).toBe(now);
			expect(row?.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored(
				"permission.asked",
				"s1",
				{
					id: "perm-1",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "ls" },
				} satisfies PermissionAskedPayload,
				1,
				now,
			);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("permission.resolved", () => {
		it("updates the approval to resolved with decision", () => {
			// First: ask
			projector.project(
				makeStored(
					"permission.asked",
					"s1",
					{
						id: "perm-1",
						sessionId: "s1",
						toolName: "bash",
						input: { command: "ls" },
					} satisfies PermissionAskedPayload,
					1,
					now,
				),
				db,
			);

			// Then: resolve
			const resolveTime = now + 3000;
			projector.project(
				makeStored(
					"permission.resolved",
					"s1",
					{
						id: "perm-1",
						decision: "once",
					} satisfies PermissionResolvedPayload,
					2,
					resolveTime,
				),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("once");
			expect(row?.resolved_at).toBe(resolveTime);
		});

		it("updates to denied decision", () => {
			projector.project(
				makeStored(
					"permission.asked",
					"s1",
					{
						id: "perm-2",
						sessionId: "s1",
						toolName: "write",
						input: { filePath: "/etc/passwd" },
					} satisfies PermissionAskedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"permission.resolved",
					"s1",
					{
						id: "perm-2",
						decision: "reject",
					} satisfies PermissionResolvedPayload,
					2,
					now + 1000,
				),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-2"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("reject");
		});
	});

	describe("question.asked", () => {
		it("inserts a pending question approval", () => {
			const event = makeStored(
				"question.asked",
				"s1",
				{
					id: "q-1",
					sessionId: "s1",
					questions: [{ id: "q1-a", text: "Are you sure?", type: "confirm" }],
				} satisfies QuestionAskedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(row).toBeDefined();
			expect(row?.id).toBe("q-1");
			expect(row?.session_id).toBe("s1");
			expect(row?.type).toBe("question");
			expect(row?.status).toBe("pending");
			expect(row?.tool_name).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(row).toBeDefined()
			expect(decodeJson(row!.input)).toEqual([
				{ id: "q1-a", text: "Are you sure?", type: "confirm" },
			]);
			expect(row?.decision).toBeNull();
			expect(row?.created_at).toBe(now);
			expect(row?.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored(
				"question.asked",
				"s1",
				{
					id: "q-1",
					sessionId: "s1",
					questions: [{ id: "q1-a", text: "Sure?", type: "confirm" }],
				} satisfies QuestionAskedPayload,
				1,
				now,
			);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("question.resolved", () => {
		it("updates the question to resolved with answers as decision", () => {
			projector.project(
				makeStored(
					"question.asked",
					"s1",
					{
						id: "q-1",
						sessionId: "s1",
						questions: [{ id: "q1-a", text: "Sure?", type: "confirm" }],
					} satisfies QuestionAskedPayload,
					1,
					now,
				),
				db,
			);

			const resolveTime = now + 2000;
			projector.project(
				makeStored(
					"question.resolved",
					"s1",
					{
						id: "q-1",
						answers: { "q1-a": true },
					} satisfies QuestionResolvedPayload,
					2,
					resolveTime,
				),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(row?.status).toBe("resolved");
			// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(row).toBeDefined()
			expect(decodeJson(row!.decision)).toEqual({ "q1-a": true });
			expect(row?.resolved_at).toBe(resolveTime);
		});
	});

	describe("full lifecycle", () => {
		it("tracks permission from asked to resolved", () => {
			projector.project(
				makeStored(
					"permission.asked",
					"s1",
					{
						id: "perm-lifecycle",
						sessionId: "s1",
						toolName: "bash",
						input: { command: "echo hi" },
					} satisfies PermissionAskedPayload,
					1,
					now,
				),
				db,
			);

			let row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row?.status).toBe("pending");

			projector.project(
				makeStored(
					"permission.resolved",
					"s1",
					{
						id: "perm-lifecycle",
						decision: "once",
					} satisfies PermissionResolvedPayload,
					2,
					now + 5000,
				),
				db,
			);

			row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("once");
		});

		it("tracks multiple approvals in one session", () => {
			projector.project(
				makeStored(
					"permission.asked",
					"s1",
					{
						id: "perm-a",
						sessionId: "s1",
						toolName: "bash",
						input: { command: "ls" },
					} satisfies PermissionAskedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"question.asked",
					"s1",
					{
						id: "q-a",
						sessionId: "s1",
						questions: [{ id: "qa-1", text: "Continue?", type: "confirm" }],
					} satisfies QuestionAskedPayload,
					2,
					now + 100,
				),
				db,
			);

			const pending = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at",
				["s1"],
			);
			expect(pending).toHaveLength(2);
			expect(pending[0]?.type).toBe("permission");
			expect(pending[1]?.type).toBe("question");
		});
	});

	it("ignores event types it does not handle", () => {
		const unrelated = makeStored(
			"text.delta",
			"s1",
			{
				messageId: "m1",
				partId: "p1",
				text: "hello",
				// biome-ignore lint/suspicious/noExplicitAny: intentionally unrelated event type for "ignores" test
			} as any,
			1,
			now,
		);

		projector.project(unrelated, db);

		const rows = db.query<ApprovalRow>(
			"SELECT * FROM pending_approvals WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
