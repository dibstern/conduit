// test/unit/persistence/projectors/provider-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type SessionCreatedPayload,
	type SessionProviderChangedPayload,
	type StoredEvent,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { ProviderProjector } from "../../../../src/lib/persistence/projectors/provider-projector.js";
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

interface ProviderRow {
	id: string;
	session_id: string;
	provider: string;
	provider_sid: string | null;
	status: string;
	activated_at: number;
	deactivated_at: number | null;
}

describe("ProviderProjector", () => {
	let db: SqliteClient;
	let projector: ProviderProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ProviderProjector();

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
		expect(projector.name).toBe("provider");
		expect(projector.handles).toEqual([
			"session.created",
			"session.provider_changed",
		]);
	});

	describe("session.created", () => {
		it("inserts an active provider binding", () => {
			const event = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Hello",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.session_id).toBe("s1");
			expect(rows[0]?.provider).toBe("opencode");
			expect(rows[0]?.status).toBe("active");
			expect(rows[0]?.activated_at).toBe(now);
			expect(rows[0]?.deactivated_at).toBeNull();
		});

		it("generates a UUID for the binding id", () => {
			const event = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Hello",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(row?.id).toBeDefined();
			expect(row?.id.length).toBeGreaterThan(0);
		});

		it("is idempotent — replaying does not create duplicates when no active binding exists", () => {
			const event = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Hello",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);

			projector.project(event, db);
			projector.project(event, db);

			// Second replay should see existing active binding and skip
			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? AND status = 'active'",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.provider_changed", () => {
		it("deactivates old binding and inserts new active binding", () => {
			// First: create the session with initial provider
			projector.project(
				makeStored(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Hello",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					1,
					now,
				),
				db,
			);

			// Then: change provider
			const changeTime = now + 5000;
			projector.project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude-sdk",
					} satisfies SessionProviderChangedPayload,
					2,
					changeTime,
				),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(2);

			// Old binding is deactivated
			expect(rows[0]?.provider).toBe("opencode");
			expect(rows[0]?.status).toBe("stopped");
			expect(rows[0]?.deactivated_at).toBe(changeTime);

			// New binding is active
			expect(rows[1]?.provider).toBe("claude-sdk");
			expect(rows[1]?.status).toBe("active");
			expect(rows[1]?.activated_at).toBe(changeTime);
			expect(rows[1]?.deactivated_at).toBeNull();
		});

		it("handles multiple provider changes", () => {
			projector.project(
				makeStored(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Hello",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude-sdk",
					} satisfies SessionProviderChangedPayload,
					2,
					now + 1000,
				),
				db,
			);

			projector.project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "claude-sdk",
						newProvider: "gemini",
					} satisfies SessionProviderChangedPayload,
					3,
					now + 2000,
				),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(3);
			expect(rows[0]?.provider).toBe("opencode");
			expect(rows[0]?.status).toBe("stopped");
			expect(rows[1]?.provider).toBe("claude-sdk");
			expect(rows[1]?.status).toBe("stopped");
			expect(rows[2]?.provider).toBe("gemini");
			expect(rows[2]?.status).toBe("active");
		});

		it("is safe when no active binding exists (e.g. out-of-order replay)", () => {
			// provider_changed without a preceding session.created
			// Should still insert the new active binding even if there's nothing to deactivate
			projector.project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude-sdk",
					} satisfies SessionProviderChangedPayload,
					1,
					now,
				),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.provider).toBe("claude-sdk");
			expect(rows[0]?.status).toBe("active");
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
			} as any,
			1,
			now,
		);

		projector.project(unrelated, db);

		const rows = db.query<ProviderRow>(
			"SELECT * FROM session_providers WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
