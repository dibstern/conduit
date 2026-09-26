// test/unit/persistence/projectors-effect/session-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type MessageCreatedPayload,
	type SessionCreatedPayload,
	type SessionPermissionModeChangedPayload,
	type SessionProviderChangedPayload,
	type SessionReadPayload,
	type SessionRenamedPayload,
	type SessionStatusPayload,
	type SessionUnreadPayload,
	type StoredEvent,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { SESSION_HANDLED_TYPES } from "../../../../src/lib/persistence/projectors/session-handlers.js";
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

interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	last_message_at: number | null;
	last_turn_error_at: number | null;
	permission_mode: string | null;
	read_at: number | null;
	settled_at: number | null;
	pinned_at: number | null;
	snoozed_at: number | null;
	snoozed_until: number | null;
	woken_at: number | null;
	woken_reason: string | null;
	created_at: number;
	updated_at: number;
}

describe("SessionProjector", () => {
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	const now = 1_000_000_000_000;

	beforeEach(() => {
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "session",
		);
		if (!effectProjector) throw new Error("Session projector not found");
		projector = effectProjector;
		harness = makeEffectProjectionHarness([projector]);
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
		expect(projector.name).toBe("session");
		expect(projector.handles).toBe(SESSION_HANDLED_TYPES);
	});

	describe("snooze projection", () => {
		async function seedSnooze(until: number | null = null, at = now + 10) {
			await project(
				makeStored(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "Session", provider: "opencode" },
					1,
					now,
				),
			);
			await project(
				makeStored("session.snoozed", "s1", { sessionId: "s1", until }, 2, at),
			);
		}

		it.each([
			[
				"approval",
				makeStored(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					3,
					now + 20,
				),
			],
			[
				"question",
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			],
			[
				"error",
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					3,
					now + 20,
				),
			],
			[
				"turn",
				makeStored("turn.completed", "s1", { messageId: "m1" }, 3, now + 20),
			],
		] as const)("wakes on %s alone", async (reason, trigger) => {
			await seedSnooze(now + 100);
			await project(trigger);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row?.woken_at).toBe(now + 20);
			expect(row?.woken_reason).toBe(reason);
		});

		it("does not wake for a trigger before snoozed_at", async () => {
			await seedSnooze(null, now + 30);
			await project(
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
		});

		it("does not record a trigger after snoozed_until", async () => {
			await seedSnooze(now + 15);
			await project(
				makeStored(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					3,
					now + 20,
				),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
		});

		it("keeps the first wake when a later trigger arrives", async () => {
			await seedSnooze();
			await project(
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					4,
					now + 30,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect([row?.woken_at, row?.woken_reason]).toEqual([
				now + 20,
				"question",
			]);
		});

		it("wakes a snoozed ancestor when a child blocks on the user, not when it finishes", async () => {
			await seedSnooze();
			await project(
				makeStored(
					"session.created",
					"child",
					{ sessionId: "child", title: "Child", provider: "opencode" },
					3,
					now + 11,
				),
			);
			await project(
				makeStored(
					"session.forked",
					"child",
					{ sessionId: "child", parentId: "s1" },
					4,
					now + 12,
				),
			);
			await project(
				makeStored("turn.completed", "child", { messageId: "m1" }, 5, now + 15),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
			await project(
				makeStored(
					"permission.asked",
					"child",
					{ id: "p1", sessionId: "child", toolName: "bash", input: {} },
					6,
					now + 20,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect([row?.woken_at, row?.woken_reason]).toEqual([
				now + 20,
				"approval",
			]);
		});

		it("wakes an indefinite snooze", async () => {
			await seedSnooze();
			await project(
				makeStored("turn.completed", "s1", { messageId: "m1" }, 3, now + 20),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_reason,
			).toBe("turn");
		});

		it("leaves updated_at unchanged on snooze and unsnooze", async () => {
			await seedSnooze(now + 100);
			let row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row?.updated_at).toBe(now);
			await project(
				makeStored("session.unsnoozed", "s1", { sessionId: "s1" }, 3, now + 20),
			);
			row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row).toMatchObject({
				updated_at: now,
				snoozed_at: null,
				snoozed_until: null,
				woken_at: null,
				woken_reason: null,
			});
		});
	});

	describe("session.created", () => {
		it("inserts a new session row", async () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello World",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			await project(event);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row).toBeDefined();
			expect(row?.id).toBe("s1");
			expect(row?.provider).toBe("opencode");
			expect(row?.title).toBe("Hello World");
			expect(row?.status).toBe("idle");
			expect(row?.created_at).toBe(event.createdAt);
			expect(row?.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO UPDATE)", async () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "First",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			await project(event);
			await project(event);

			const rows = await harness.query<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});

		it("writes parent and provider session ids, then preserves them when omitted", async () => {
			await project(
				makeStored(
					"session.created",
					"parent-session",
					{
						sessionId: "parent-session",
						title: "Parent",
						provider: "claude",
					} satisfies SessionCreatedPayload,
					1,
					now,
				),
			);

			await project(
				makeStored(
					"session.created",
					"claude-subagent-abc",
					{
						sessionId: "claude-subagent-abc",
						title: "Explore Agent",
						provider: "claude",
						parentId: "parent-session",
						providerSessionId: "sdk-subagent-1",
					} satisfies SessionCreatedPayload,
					2,
					now + 1,
				),
			);
			await project(
				makeStored(
					"session.created",
					"claude-subagent-abc",
					{
						sessionId: "claude-subagent-abc",
						title: "Explore Agent Updated",
						provider: "claude",
					} satisfies SessionCreatedPayload,
					3,
					now + 2,
				),
			);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["claude-subagent-abc"],
			);
			expect(row?.title).toBe("Explore Agent Updated");
			expect(row?.parent_id).toBe("parent-session");
			expect(row?.provider_sid).toBe("sdk-subagent-1");
		});
	});

	describe("session.renamed", () => {
		it("updates the title and updated_at", async () => {
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
			await project(created);

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
			await project(renamed);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.title).toBe("Renamed Session");
			expect(row?.updated_at).toBe(now + 1000);
		});
	});

	describe("session.status", () => {
		it.each([
			"busy",
			"retry",
		] as const)("updates status to %s and clears the last turn error", async (statusValue) => {
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
			await project(created);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 250,
				),
			);

			const status = makeStored(
				"session.status",
				"s1",
				{
					sessionId: "s1",
					status: statusValue,
				} satisfies SessionStatusPayload,
				3,
				now + 500,
			);
			await project(status);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.status).toBe(statusValue);
			expect(row?.updated_at).toBe(now + 500);
			expect(row?.last_turn_error_at).toBeNull();
		});

		it("preserves the last turn error for an idle status", async () => {
			await project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				}),
			);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 250,
				),
			);
			await project(
				makeStored(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "idle" },
					3,
					now + 500,
				),
			);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.last_turn_error_at).toBe(now + 250);
		});
	});

	describe("session.provider_changed", () => {
		it("updates the provider and updated_at", async () => {
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
			await project(created);

			const changed = makeStored(
				"session.provider_changed",
				"s1",
				{
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude",
				} satisfies SessionProviderChangedPayload,
				2,
				now + 2000,
			);
			await project(changed);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.provider).toBe("claude");
			expect(row?.updated_at).toBe(now + 2000);
		});
	});

	describe("session.permission_mode_changed", () => {
		it("updates permission mode and updated_at for the target session only", async () => {
			for (const sessionId of ["s1", "s2"]) {
				await project(
					makeStored(
						"session.created",
						sessionId,
						{
							sessionId,
							title: `Session ${sessionId}`,
							provider: "opencode",
						} satisfies SessionCreatedPayload,
						1,
						now,
					),
				);
			}

			await project(
				makeStored(
					"session.permission_mode_changed",
					"s1",
					{
						sessionId: "s1",
						mode: "auto",
					} satisfies SessionPermissionModeChangedPayload,
					2,
					now + 2500,
				),
			);

			const target = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			const other = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s2"],
			);
			expect(target?.permission_mode).toBe("auto");
			expect(target?.updated_at).toBe(now + 2500);
			expect(other?.permission_mode).toBeNull();
			expect(other?.updated_at).toBe(now);
		});
	});

	it.each([
		["session.settled", "session.unsettled", "settled_at"],
		["session.pinned", "session.unpinned", "pinned_at"],
	] as const)("%s and its undo preserve the session sort key", async (setType, clearType, column) => {
		await project(
			makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				},
				1,
				now,
			),
		);
		await project(
			makeStored(
				"session.created",
				"s2",
				{
					sessionId: "s2",
					title: "Other",
					provider: "opencode",
				},
				2,
				now + 50,
			),
		);
		await project(makeStored(setType, "s1", { sessionId: "s1" }, 3, now + 100));
		const afterSet = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(afterSet?.[column]).toBe(now + 100);
		expect(afterSet?.updated_at).toBe(now);
		const other = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s2"],
		);
		expect(other?.[column]).toBeNull();
		expect(other?.updated_at).toBe(now + 50);
		await project(
			makeStored(clearType, "s1", { sessionId: "s1" }, 4, now + 200),
		);
		const afterClear = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(afterClear?.[column]).toBeNull();
		expect(afterClear?.updated_at).toBe(now);
	});

	describe("session read state", () => {
		it("sets read_at from the event timestamp and clears it when unread", async () => {
			await project(
				makeStored(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					1,
					now,
				),
			);

			await project(
				makeStored(
					"session.read",
					"s1",
					{ sessionId: "s1" } satisfies SessionReadPayload,
					2,
					now + 100,
				),
			);
			const afterRead = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(afterRead?.read_at).toBe(now + 100);
			// updated_at is the session list's sort key, so merely reading a session
			// must not jump it to the top of the list.
			expect(afterRead?.updated_at).toBe(now);

			await project(
				makeStored(
					"session.unread",
					"s1",
					{ sessionId: "s1" } satisfies SessionUnreadPayload,
					3,
					now + 200,
				),
			);
			const afterUnread = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(afterUnread?.read_at).toBeNull();
			expect(afterUnread?.updated_at).toBe(now);
		});
	});

	describe("turn.completed", () => {
		it("updates updated_at and clears the last turn error", async () => {
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
			await project(created);

			const originalRow = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			const originalTitle = originalRow?.title;
			const originalStatus = originalRow?.status;
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m0", error: "failed" },
					2,
					now + 3000,
				),
			);

			const turnDone = makeStored(
				"turn.completed",
				"s1",
				{
					messageId: "m1",
					cost: 0.01,
					tokens: { input: 100, output: 50 },
				} satisfies TurnCompletedPayload,
				3,
				now + 5000,
			);
			await project(turnDone);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.title).toBe(originalTitle);
			expect(row?.status).toBe(originalStatus);
			expect(row?.updated_at).toBe(now + 5000);
			expect(row?.last_turn_error_at).toBeNull();
		});
	});

	describe("turn.error", () => {
		it("updates updated_at and records the failure timestamp", async () => {
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
			await project(created);

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
			await project(turnErr);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.updated_at).toBe(now + 3000);
			expect(row?.last_turn_error_at).toBe(now + 3000);
		});
	});

	describe("message.created", () => {
		it("clears the last turn error only for user messages", async () => {
			await project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				}),
			);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 100,
				),
			);
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "a1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					3,
					now + 200,
				),
			);
			expect(
				(
					await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [
						"s1",
					])
				)?.last_turn_error_at,
			).toBe(now + 100);

			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "u1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					4,
					now + 300,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.last_message_at).toBe(now + 300);
			expect(row?.last_turn_error_at).toBeNull();
		});
	});

	it("ignores event types it does not handle", async () => {
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
		await project(created);

		const before = await queryOne<SessionRow>(
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
				// biome-ignore lint/suspicious/noExplicitAny: intentionally unrelated event type for "ignores" test
			} as any,
			2,
		);
		await project(unrelated);

		const after = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(after?.updated_at).toBe(before?.updated_at);
	});
});
