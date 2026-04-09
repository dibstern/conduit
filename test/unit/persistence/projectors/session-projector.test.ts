// test/unit/persistence/projectors/session-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type SessionCreatedPayload,
	type SessionProviderChangedPayload,
	type SessionRenamedPayload,
	type SessionStatusPayload,
	type StoredEvent,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { SessionProjector } from "../../../../src/lib/persistence/projectors/session-projector.js";
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

interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	created_at: number;
	updated_at: number;
}

describe("SessionProjector", () => {
	let db: SqliteClient;
	let projector: SessionProjector;
	const now = 1_000_000_000_000;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new SessionProjector();
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("session");
		expect(projector.handles).toEqual([
			"session.created",
			"session.renamed",
			"session.status",
			"session.provider_changed",
			"turn.completed",
			"turn.error",
			"message.created",
		]);
	});

	describe("session.created", () => {
		it("inserts a new session row", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello World",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row).toBeDefined();
			expect(row!.id).toBe("s1");
			expect(row!.provider).toBe("opencode");
			expect(row!.title).toBe("Hello World");
			expect(row!.status).toBe("idle");
			expect(row!.created_at).toBe(event.createdAt);
			expect(row!.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO UPDATE)", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "First",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<SessionRow>("SELECT * FROM sessions WHERE id = ?", [
				"s1",
			]);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.renamed", () => {
		it("updates the title and updated_at", () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Original",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const renamed = makeStored(
				"session.renamed",
				"s1",
				{
					sessionId: "s1",
					title: "Renamed Session",
				} satisfies SessionRenamedPayload,
				2,
				now + 1000,
			);
			projector.project(renamed, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row!.title).toBe("Renamed Session");
			expect(row!.updated_at).toBe(now + 1000);
		});
	});

	describe("session.status", () => {
		it("updates the status and updated_at", () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const status = makeStored(
				"session.status",
				"s1",
				{
					sessionId: "s1",
					status: "busy",
				} satisfies SessionStatusPayload,
				2,
				now + 500,
			);
			projector.project(status, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row!.status).toBe("busy");
			expect(row!.updated_at).toBe(now + 500);
		});
	});

	describe("session.provider_changed", () => {
		it("updates the provider and updated_at", () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const changed = makeStored(
				"session.provider_changed",
				"s1",
				{
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude-sdk",
				} satisfies SessionProviderChangedPayload,
				2,
				now + 2000,
			);
			projector.project(changed, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row!.provider).toBe("claude-sdk");
			expect(row!.updated_at).toBe(now + 2000);
		});
	});

	describe("turn.completed", () => {
		it("updates only updated_at", () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const originalRow = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			const originalTitle = originalRow!.title;
			const originalStatus = originalRow!.status;

			const turnDone = makeStored(
				"turn.completed",
				"s1",
				{
					messageId: "m1",
					cost: 0.01,
					tokens: { input: 100, output: 50 },
				} satisfies TurnCompletedPayload,
				2,
				now + 5000,
			);
			projector.project(turnDone, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row!.title).toBe(originalTitle);
			expect(row!.status).toBe(originalStatus);
			expect(row!.updated_at).toBe(now + 5000);
		});
	});

	describe("turn.error", () => {
		it("updates only updated_at", () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const turnErr = makeStored(
				"turn.error",
				"s1",
				{
					messageId: "m1",
					error: "something failed",
				} satisfies TurnErrorPayload,
				2,
				now + 3000,
			);
			projector.project(turnErr, db);

			const row = db.queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row!.updated_at).toBe(now + 3000);
		});
	});

	it("ignores event types it does not handle", () => {
		// Pre-insert a session so we can verify it's untouched
		const created = makeStored(
			"session.created",
			"s1",
			{
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload,
			1,
		);
		projector.project(created, db);

		const before = db.queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);

		const unrelated = makeStored(
			"text.delta",
			"s1",
			{
				messageId: "m1",
				partId: "p1",
				text: "hello",
			} as any,
			2,
		);
		projector.project(unrelated, db);

		const after = db.queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(after!.updated_at).toBe(before!.updated_at);
	});
});
