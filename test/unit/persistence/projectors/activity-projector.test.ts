// test/unit/persistence/projectors/activity-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type PermissionAskedPayload,
	type PermissionResolvedPayload,
	type QuestionAskedPayload,
	type QuestionResolvedPayload,
	type StoredEvent,
	type ToolCompletedPayload,
	type ToolRunningPayload,
	type ToolStartedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { ActivityProjector } from "../../../../src/lib/persistence/projectors/activity-projector.js";
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

interface ActivityRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	tone: string;
	kind: string;
	summary: string;
	payload: string;
	sequence: number | null;
	created_at: number;
}

describe("ActivityProjector", () => {
	let db: SqliteClient;
	let projector: ActivityProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ActivityProjector();

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
		expect(projector.name).toBe("activity");
		expect(projector.handles).toEqual([
			"tool.started",
			"tool.running",
			"tool.completed",
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
			"turn.error",
		]);
	});

	describe("tool.started", () => {
		it("inserts an activity with tone=tool, kind=tool.started", () => {
			const event = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					toolName: "bash",
					callId: "call-1",
					input: { command: "ls" },
				} satisfies ToolStartedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("tool");
			expect(rows[0]?.kind).toBe("tool.started");
			expect(rows[0]?.summary).toBe("bash");
			expect(rows[0]?.sequence).toBe(1);
			expect(rows[0]?.created_at).toBe(now);
		});
	});

	describe("tool.running", () => {
		it("inserts an activity with tone=tool, kind=tool.running", () => {
			const event = makeStored(
				"tool.running",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
				} satisfies ToolRunningPayload,
				2,
				now + 100,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.running'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("tool");
			expect(rows[0]?.summary).toBe("p1");
		});
	});

	describe("tool.completed", () => {
		it("inserts an activity with tone=tool, kind=tool.completed and duration in summary", () => {
			const event = makeStored(
				"tool.completed",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					result: "file.txt",
					duration: 1234,
				} satisfies ToolCompletedPayload,
				3,
				now + 1234,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.completed'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("tool");
			expect(rows[0]?.summary).toContain("p1");
			expect(rows[0]?.summary).toContain("1234ms");
		});
	});

	describe("permission.asked", () => {
		it("inserts an activity with tone=approval, kind=permission.asked", () => {
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

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'permission.asked'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("approval");
			expect(rows[0]?.summary).toBe("bash");
		});
	});

	describe("permission.resolved", () => {
		it("inserts an activity with tone=approval, kind=permission.resolved", () => {
			const event = makeStored(
				"permission.resolved",
				"s1",
				{
					id: "perm-1",
					decision: "once",
				} satisfies PermissionResolvedPayload,
				2,
				now + 1000,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'permission.resolved'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("approval");
			expect(rows[0]?.summary).toBe("once");
		});
	});

	describe("question.asked", () => {
		it("inserts an activity with tone=info, kind=question.asked", () => {
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

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'question.asked'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("info");
			expect(rows[0]?.summary).toBe("Question asked");
		});
	});

	describe("question.resolved", () => {
		it("inserts an activity with tone=info, kind=question.resolved", () => {
			const event = makeStored(
				"question.resolved",
				"s1",
				{
					id: "q-1",
					answers: { "q1-a": true },
				} satisfies QuestionResolvedPayload,
				2,
				now + 500,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'question.resolved'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("info");
			expect(rows[0]?.summary).toBe("Question answered");
		});
	});

	describe("turn.error", () => {
		it("inserts an activity with tone=error, kind=turn.error and error message as summary", () => {
			const event = makeStored(
				"turn.error",
				"s1",
				{
					messageId: "m1",
					error: "rate_limit_exceeded",
					code: "429",
				} satisfies TurnErrorPayload,
				3,
				now + 2000,
			);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'turn.error'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tone).toBe("error");
			expect(rows[0]?.summary).toBe("rate_limit_exceeded");
		});
	});

	describe("payload storage", () => {
		it("stores event data as JSON payload", () => {
			const event = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					toolName: "bash",
					callId: "call-1",
					input: { command: "ls -la" },
				} satisfies ToolStartedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.started'",
				[],
			);
			// biome-ignore lint/style/noNonNullAssertion: test assertion after queryOne
			const payload = decodeJson<Record<string, unknown>>(row!.payload);
			expect(payload).toBeDefined();
			expect(payload?.["toolName"]).toBe("bash");
			expect(payload?.["callId"]).toBe("call-1");
		});
	});

	describe("session_id tracking", () => {
		it("stores the session_id from the event envelope", () => {
			const event = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					toolName: "read",
					callId: "call-2",
					input: { filePath: "/tmp/x" },
				} satisfies ToolStartedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.started'",
				[],
			);
			expect(row?.session_id).toBe("s1");
		});
	});

	describe("multiple activities in sequence", () => {
		it("creates a chronological activity feed", () => {
			projector.project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						toolName: "bash",
						callId: "c1",
						input: { command: "ls" },
					} satisfies ToolStartedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
					} satisfies ToolRunningPayload,
					2,
					now + 50,
				),
				db,
			);

			projector.project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						result: "output",
						duration: 500,
					} satisfies ToolCompletedPayload,
					3,
					now + 550,
				),
				db,
			);

			projector.project(
				makeStored(
					"permission.asked",
					"s1",
					{
						id: "perm-1",
						sessionId: "s1",
						toolName: "write",
						input: { filePath: "/tmp/out" },
					} satisfies PermissionAskedPayload,
					4,
					now + 600,
				),
				db,
			);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			expect(rows).toHaveLength(4);
			expect(rows[0]?.kind).toBe("tool.started");
			expect(rows[1]?.kind).toBe("tool.running");
			expect(rows[2]?.kind).toBe("tool.completed");
			expect(rows[3]?.kind).toBe("permission.asked");
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

		const rows = db.query<ActivityRow>(
			"SELECT * FROM activities WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
