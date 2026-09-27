// test/unit/persistence/projectors-effect/approval-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type PermissionAskedPayload,
	type PermissionResolvedPayload,
	type QuestionAskedPayload,
	type QuestionResolvedPayload,
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
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	const now = Date.now();

	beforeEach(async () => {
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "approval",
		);
		if (!effectProjector) throw new Error("Approval projector not found");
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
		expect(projector.name).toBe("approval");
		expect(projector.handles).toEqual([
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
		]);
	});

	describe("permission.asked", () => {
		it("inserts a pending permission approval", async () => {
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

			await project(event);

			const row = await queryOne<ApprovalRow>(
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
			expect(JSON.parse(row!.input ?? "null")).toEqual({ command: "rm -rf /" });
			expect(row?.decision).toBeNull();
			expect(row?.created_at).toBe(now);
			expect(row?.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", async () => {
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

			await project(event);
			await project(event);

			const rows = await harness.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("permission.resolved", () => {
		it("updates the approval to resolved with decision", async () => {
			// First: ask
			await project(
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
			);

			// Then: resolve
			const resolveTime = now + 3000;
			await project(
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
			);

			const row = await queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("once");
			expect(row?.resolved_at).toBe(resolveTime);
		});

		it("updates to denied decision", async () => {
			await project(
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
			);

			await project(
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
			);

			const row = await queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-2"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("reject");
		});
	});

	describe("question.asked", () => {
		it("inserts a pending question approval", async () => {
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

			await project(event);

			const row = await queryOne<ApprovalRow>(
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
			expect(JSON.parse(row!.input ?? "null")).toEqual([
				{ id: "q1-a", text: "Are you sure?", type: "confirm" },
			]);
			expect(row?.decision).toBeNull();
			expect(row?.created_at).toBe(now);
			expect(row?.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", async () => {
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

			await project(event);
			await project(event);

			const rows = await harness.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("question.resolved", () => {
		it("updates the question to resolved with answers as decision", async () => {
			await project(
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
			);

			const resolveTime = now + 2000;
			await project(
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
			);

			const row = await queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(row?.status).toBe("resolved");
			// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(row).toBeDefined()
			expect(JSON.parse(row!.decision ?? "null")).toEqual({ "q1-a": true });
			expect(row?.resolved_at).toBe(resolveTime);
		});
	});

	describe("full lifecycle", () => {
		it("tracks permission from asked to resolved", async () => {
			await project(
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
			);

			let row = await queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row?.status).toBe("pending");

			await project(
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
			);

			row = await queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row?.status).toBe("resolved");
			expect(row?.decision).toBe("once");
		});

		it("tracks multiple approvals in one session", async () => {
			await project(
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
			);

			await project(
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
			);

			const pending = await harness.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at",
				["s1"],
			);
			expect(pending).toHaveLength(2);
			expect(pending[0]?.type).toBe("permission");
			expect(pending[1]?.type).toBe("question");
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

		const rows = await harness.query<ApprovalRow>(
			"SELECT * FROM pending_approvals WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
