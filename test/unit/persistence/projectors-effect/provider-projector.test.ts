// test/unit/persistence/projectors-effect/provider-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type SessionCreatedPayload,
	type SessionProviderChangedPayload,
	type StoredEvent,
} from "../../../../src/lib/persistence/events.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../../helpers/effect-projection-harness.js";

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
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	const now = Date.now();

	beforeEach(async () => {
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "provider",
		);
		if (!effectProjector) throw new Error("Provider projector not found");
		projector = effectProjector;
		harness = makeEffectProjectionHarness([projector]);

		// Pre-insert a session so FK constraints don't block inserts
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(event: StoredEvent): Promise<void> {
		await harness.reproject([event]);
	}

	async function queryOne<T extends object>(
		statement: string,
		params: readonly (string | number | null)[] = [],
	): Promise<T | undefined> {
		return (await harness.query<T>(statement, params))[0];
	}

	it("has the correct name and handles list", async () => {
		expect(projector.name).toBe("provider");
		expect(projector.handles).toEqual([
			"session.created",
			"session.provider_changed",
		]);
	});

	describe("session.created", () => {
		it("inserts an active provider binding", async () => {
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

			await project(event);

			const rows = await harness.query<ProviderRow>(
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

		it("generates a UUID for the binding id", async () => {
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

			await project(event);

			const row = await queryOne<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(row?.id).toBeDefined();
			expect(row?.id.length).toBeGreaterThan(0);
		});

		it("is idempotent — replaying does not create duplicates when no active binding exists", async () => {
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

			await project(event);
			await project(event);

			// Second replay should see existing active binding and skip
			const rows = await harness.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? AND status = 'active'",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.provider_changed", () => {
		it("deactivates old binding and inserts new active binding", async () => {
			// First: create the session with initial provider
			await project(
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
			);

			// Then: change provider
			const changeTime = now + 5000;
			await project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude",
					} satisfies SessionProviderChangedPayload,
					2,
					changeTime,
				),
			);

			const rows = await harness.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(2);

			// Old binding is deactivated
			expect(rows[0]?.provider).toBe("opencode");
			expect(rows[0]?.status).toBe("stopped");
			expect(rows[0]?.deactivated_at).toBe(changeTime);

			// New binding is active
			expect(rows[1]?.provider).toBe("claude");
			expect(rows[1]?.status).toBe("active");
			expect(rows[1]?.activated_at).toBe(changeTime);
			expect(rows[1]?.deactivated_at).toBeNull();
		});

		it("handles multiple provider changes", async () => {
			await project(
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
			);

			await project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude",
					} satisfies SessionProviderChangedPayload,
					2,
					now + 1000,
				),
			);

			await project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "claude",
						newProvider: "gemini",
					} satisfies SessionProviderChangedPayload,
					3,
					now + 2000,
				),
			);

			const rows = await harness.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(3);
			expect(rows[0]?.provider).toBe("opencode");
			expect(rows[0]?.status).toBe("stopped");
			expect(rows[1]?.provider).toBe("claude");
			expect(rows[1]?.status).toBe("stopped");
			expect(rows[2]?.provider).toBe("gemini");
			expect(rows[2]?.status).toBe("active");
		});

		it("is safe when no active binding exists (e.g. out-of-order replay)", async () => {
			// provider_changed without a preceding session.created
			// Should still insert the new active binding even if there's nothing to deactivate
			await project(
				makeStored(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude",
					} satisfies SessionProviderChangedPayload,
					1,
					now,
				),
			);

			const rows = await harness.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.provider).toBe("claude");
			expect(rows[0]?.status).toBe("active");
		});
	});

	it("ignores event types it does not handle", async () => {
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

		await project(unrelated);

		const rows = await harness.query<ProviderRow>(
			"SELECT * FROM session_providers WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
