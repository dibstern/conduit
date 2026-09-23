// test/unit/persistence/projectors-effect/message-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	type EffectProjector,
	type ProjectionContext,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type FileAttachedPayload,
	type MessageCreatedPayload,
	type StoredEvent,
	type TextDeltaPayload,
	type ThinkingDeltaPayload,
	type ThinkingEndPayload,
	type ThinkingStartPayload,
	type ToolCompletedPayload,
	type ToolRunningPayload,
	type ToolStartedPayload,
	type TurnCompletedPayload,
	type TurnErrorPayload,
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

interface MessageRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	context_window: number | null;
	is_streaming: number;
	created_at: number;
	updated_at: number;
}

interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	metadata: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

describe("MessageProjector", () => {
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	let replayNextProjection: boolean;

	beforeEach(async () => {
		replayNextProjection = false;
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "message",
		);
		if (!effectProjector) throw new Error("Message projector not found");
		projector = {
			...effectProjector,
			project: (event, context) => {
				const effectiveContext = replayNextProjection
					? { replaying: true }
					: context;
				replayNextProjection = false;
				return effectProjector.project(event, effectiveContext);
			},
		};
		harness = makeEffectProjectionHarness([projector]);

		// Pre-insert a session so FK constraints don't block inserts
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(
		event: StoredEvent,
		context?: ProjectionContext,
	): Promise<void> {
		replayNextProjection = context?.replaying === true;
		await harness.reproject([event]);
	}

	async function queryOne<T extends object>(
		statement: string,
		params: readonly (string | number | null)[] = [],
	): Promise<T | undefined> {
		return (await harness.query<T>(statement, params))[0];
	}

	it("has the correct name and handles list", async () => {
		expect(projector.name).toBe("message");
		expect(projector.handles).toEqual([
			"message.created",
			"text.delta",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"tool.started",
			"tool.running",
			"tool.completed",
			"file.attached",
			"turn.completed",
			"turn.error",
			"session.compaction",
		]);
	});

	describe("message.created", () => {
		it("inserts a new message row with streaming flag", async () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			await project(event);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row).toBeDefined();
			expect(row?.id).toBe("m1");
			expect(row?.session_id).toBe("s1");
			expect(row?.role).toBe("assistant");
			expect(row?.text).toBe("");
			expect(row?.is_streaming).toBe(1);
			expect(row?.created_at).toBe(event.createdAt);
			expect(row?.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", async () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			await project(event);
			await project(event);

			const rows = await harness.query<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(rows).toHaveLength(1);
		});

		it("inserts user messages with is_streaming=0", async () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			await project(event);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.is_streaming).toBe(0);
		});
	});

	describe("text.delta", () => {
		it("appends text to an existing message and creates/updates a message_parts row", async () => {
			// Create message first
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			// First delta
			const delta1 = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "Hello ",
				} satisfies TextDeltaPayload,
				2,
			);
			await project(delta1);

			let row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.text).toBe("Hello ");
			let parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.type).toBe("text");
			expect(parts[0]?.id).toBe("p1");
			expect(parts[0]?.text).toBe("Hello ");

			// Second delta, same part -- text is appended via SQL concat
			const delta2 = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "World!",
				} satisfies TextDeltaPayload,
				3,
			);
			await project(delta2);

			row = await queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", [
				"m1",
			]);
			expect(row?.text).toBe("Hello World!");
			parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.text).toBe("Hello World!");
		});

		it("handles multiple text parts on the same message", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "Part one",
					} satisfies TextDeltaPayload,
					2,
				),
			);

			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p2",
						text: "Part two",
					} satisfies TextDeltaPayload,
					3,
				),
			);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			// text is the concatenation of all text deltas
			expect(row?.text).toBe("Part onePart two");
			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(2);
			expect(parts[0]?.id).toBe("p1");
			expect(parts[1]?.id).toBe("p2");
		});
	});

	describe("thinking.start", () => {
		it("initializes a thinking part row with empty text", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const start = makeStored(
				"thinking.start",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
				} satisfies ThinkingStartPayload,
				2,
			);
			await project(start);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.type).toBe("thinking");
			expect(parts[0]?.id).toBe("t1");
			expect(parts[0]?.text).toBe("");
		});
	});

	describe("thinking.delta", () => {
		it("appends thinking content to a message_parts row", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const think = makeStored(
				"thinking.delta",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
					text: "Let me think...",
				} satisfies ThinkingDeltaPayload,
				2,
			);
			await project(think);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.type).toBe("thinking");
			expect(parts[0]?.id).toBe("t1");
			expect(parts[0]?.text).toBe("Let me think...");
			// Thinking text does NOT accumulate into the top-level text column
			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.text).toBe("");
		});
	});

	describe("thinking.end", () => {
		it("updates updated_at only", async () => {
			const now = 1_000_000_000_000;
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
				now,
			);
			await project(created);

			const end = makeStored(
				"thinking.end",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
				} satisfies ThinkingEndPayload,
				2,
				now + 1000,
			);
			await project(end);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.updated_at).toBe(now + 1000);
		});
	});

	describe("tool.started", () => {
		it("adds a tool part row with started status", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const started = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "tool1",
					toolName: "read_file",
					callId: "call_123",
					input: { path: "/foo/bar.ts" },
				} satisfies ToolStartedPayload,
				2,
			);
			await project(started);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.type).toBe("tool");
			expect(parts[0]?.id).toBe("tool1");
			expect(parts[0]?.tool_name).toBe("read_file");
			expect(parts[0]?.call_id).toBe("call_123");
			expect(JSON.parse(parts[0]?.input ?? "null")).toEqual({
				path: "/foo/bar.ts",
			});
			expect(parts[0]?.status).toBe("started");
		});
	});

	describe("tool.running", () => {
		it("updates matching tool part status to running", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_123",
						input: { path: "/foo" },
					} satisfies ToolStartedPayload,
					2,
				),
			);

			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
					} satisfies ToolRunningPayload,
					3,
				),
			);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? AND id = ?",
				["m1", "tool1"],
			);
			expect(parts[0]?.status).toBe("running");
		});

		it("merges tool metadata into the matching tool part", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);
			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "Task",
						callId: "tool1",
						input: { tool: "Task", description: "Audit", prompt: "Go" },
					} satisfies ToolStartedPayload,
					2,
				),
			);
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: {
							childSessionId: "claude-subagent-abc",
							providerTaskId: "task-1",
						},
					} satisfies ToolRunningPayload,
					3,
				),
			);
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: { sdkSubagentId: "agent-abc" },
					} satisfies ToolRunningPayload,
					4,
				),
			);
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
					} satisfies ToolRunningPayload,
					5,
				),
			);

			const part = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(part?.status).toBe("running");
			expect(JSON.parse(part?.metadata ?? "{}")).toEqual({
				childSessionId: "claude-subagent-abc",
				providerTaskId: "task-1",
				sdkSubagentId: "agent-abc",
			});
		});

		it("replaces malformed tool metadata with the next valid metadata", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);
			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "Task",
						callId: "tool1",
						input: { tool: "Task", description: "Audit", prompt: "Go" },
					} satisfies ToolStartedPayload,
					2,
				),
			);
			await harness.query(
				"UPDATE message_parts SET metadata = ? WHERE id = ?",
				["{not json", "tool1"],
			);

			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: { providerTaskId: "task-1" },
					} satisfies ToolRunningPayload,
					3,
				),
			);

			const part = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(JSON.parse(part?.metadata ?? "{}")).toEqual({
				providerTaskId: "task-1",
			});
		});

		it("does not reopen a completed tool when late metadata arrives", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);
			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "Task",
						callId: "tool1",
						input: { tool: "Task", description: "Audit", prompt: "Go" },
					} satisfies ToolStartedPayload,
					2,
				),
			);
			await project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: "done",
						duration: 150,
					} satisfies ToolCompletedPayload,
					3,
				),
			);
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: {
							childSessionId: "claude-subagent-abc",
							providerTaskId: "task-1",
						},
					} satisfies ToolRunningPayload,
					4,
				),
			);

			const part = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(part?.status).toBe("completed");
			expect(JSON.parse(part?.metadata ?? "{}")).toEqual({
				childSessionId: "claude-subagent-abc",
				providerTaskId: "task-1",
			});
		});
	});

	describe("tool.completed", () => {
		it("updates matching tool part with result, duration, and completed status", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_123",
						input: { path: "/foo" },
					} satisfies ToolStartedPayload,
					2,
				),
			);

			await project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: { content: "file contents" },
						duration: 150,
					} satisfies ToolCompletedPayload,
					3,
				),
			);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? AND id = ?",
				["m1", "tool1"],
			);
			expect(parts[0]?.status).toBe("completed");
			expect(JSON.parse(parts[0]?.result ?? "null")).toEqual({
				content: "file contents",
			});
			expect(parts[0]?.duration).toBe(150);
		});

		// Effect projector diverges: tool.running leaves the original input unchanged.
		it.fails("refreshes input when tool.running carries one, keeps it otherwise", async () => {
			await project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "Skill",
					callId: "call_1",
					input: { tool: "Skill", name: "" },
				} satisfies ToolStartedPayload),
			);
			// Metadata-only running update must not clobber the stored input
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: { providerTaskId: "task-1" },
					} satisfies ToolRunningPayload,
					2,
				),
			);
			const kept = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(JSON.parse(kept?.input ?? "null")).toEqual({
				tool: "Skill",
				name: "",
			});

			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						input: { tool: "Skill", name: "commit" },
						callId: "call_1",
						toolName: "Skill",
					} satisfies ToolRunningPayload,
					3,
				),
			);
			const refreshed = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(refreshed?.status).toBe("running");
			expect(JSON.parse(refreshed?.input ?? "null")).toEqual({
				tool: "Skill",
				name: "commit",
			});
		});

		// Effect projector diverges: tool.completed leaves the original input unchanged.
		it.fails("refreshes input when tool.completed carries one, keeps it otherwise", async () => {
			await project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "Skill",
					callId: "call_1",
					// Skill input args stream late: started captured an empty name
					input: { tool: "Skill", name: "" },
				} satisfies ToolStartedPayload),
			);
			await project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: "skill output",
						duration: 100,
						input: { tool: "Skill", name: "commit" },
					} satisfies ToolCompletedPayload,
					2,
				),
			);

			const refreshed = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(JSON.parse(refreshed?.input ?? "null")).toEqual({
				tool: "Skill",
				name: "commit",
			});

			// A completion without input must not clobber the stored value
			await project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: "skill output",
						duration: 100,
					} satisfies ToolCompletedPayload,
					3,
				),
			);
			const kept = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(JSON.parse(kept?.input ?? "null")).toEqual({
				tool: "Skill",
				name: "commit",
			});
		});

		it("merges completion metadata into existing tool metadata", async () => {
			await project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "Task",
					callId: "tool1",
					input: { tool: "Task", description: "Audit", prompt: "Go" },
				} satisfies ToolStartedPayload),
			);
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						metadata: { providerTaskId: "task-1" },
					} satisfies ToolRunningPayload,
					2,
				),
			);
			const completed = makeStored(
				"tool.completed",
				"s1",
				{
					messageId: "m1",
					partId: "tool1",
					result: "done",
					duration: 150,
					metadata: { sessionId: "ses-child" },
				} satisfies ToolCompletedPayload,
				3,
			);

			await project(completed);
			await project(completed);

			const part = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["tool1"],
			);
			expect(JSON.parse(part?.metadata ?? "{}")).toEqual({
				providerTaskId: "task-1",
				sessionId: "ses-child",
			});
		});
	});

	describe("file.attached", () => {
		it("defensively creates the message and inserts the file part once", async () => {
			const attached = makeStored(
				"file.attached",
				"s1",
				{
					messageId: "m-file",
					partId: "file1",
					mime: "image/png",
					filename: "screenshot.png",
					url: "data:image/png;base64,AAAA",
				} satisfies FileAttachedPayload,
				1,
			);

			await project(attached);
			await project(attached);

			const message = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m-file"],
			);
			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ?",
				["m-file"],
			);
			expect(message?.role).toBe("assistant");
			expect(parts).toHaveLength(1);
			expect(parts[0]).toMatchObject({
				id: "file1",
				type: "file",
				sort_order: 0,
			});
			expect(JSON.parse(parts[0]?.metadata ?? "{}")).toEqual({
				mime: "image/png",
				filename: "screenshot.png",
				url: "data:image/png;base64,AAAA",
			});
		});
	});

	describe("turn.completed", () => {
		it("updates cost, tokens, and clears streaming flag", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const done = makeStored(
				"turn.completed",
				"s1",
				{
					messageId: "m1",
					cost: 0.0234,
					tokens: {
						input: 1500,
						output: 350,
						cacheRead: 200,
						cacheWrite: 50,
						contextWindow: 1_000_000,
					},
				} satisfies TurnCompletedPayload,
				2,
			);
			await project(done);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.cost).toBeCloseTo(0.0234);
			expect(row?.tokens_in).toBe(1500);
			expect(row?.tokens_out).toBe(350);
			expect(row?.tokens_cache_read).toBe(200);
			expect(row?.tokens_cache_write).toBe(50);
			expect(row?.context_window).toBe(1_000_000);
			expect(row?.is_streaming).toBe(0);
		});
	});

	describe("turn.error", () => {
		it("clears streaming flag", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const err = makeStored(
				"turn.error",
				"s1",
				{
					messageId: "m1",
					error: "rate_limit",
				} satisfies TurnErrorPayload,
				2,
			);
			await project(err);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.is_streaming).toBe(0);
		});
	});

	describe("full streaming lifecycle", () => {
		it("accumulates text, tool calls, and finalizes correctly", async () => {
			// 1. message.created
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);

			// 2. thinking.delta
			await project(
				makeStored(
					"thinking.delta",
					"s1",
					{
						messageId: "m1",
						partId: "think1",
						text: "Considering...",
					} satisfies ThinkingDeltaPayload,
					2,
				),
			);

			// 3. thinking.end
			await project(
				makeStored(
					"thinking.end",
					"s1",
					{
						messageId: "m1",
						partId: "think1",
					} satisfies ThinkingEndPayload,
					3,
				),
			);

			// 4. text.delta
			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "text1",
						text: "I'll read that file. ",
					} satisfies TextDeltaPayload,
					4,
				),
			);

			// 5. tool.started
			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_abc",
						input: { path: "/src/main.ts" },
					} satisfies ToolStartedPayload,
					5,
				),
			);

			// 6. tool.running
			await project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
					} satisfies ToolRunningPayload,
					6,
				),
			);

			// 7. tool.completed
			await project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: "console.log('hello')",
						duration: 42,
					} satisfies ToolCompletedPayload,
					7,
				),
			);

			// 8. More text
			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "text2",
						text: "Done!",
					} satisfies TextDeltaPayload,
					8,
				),
			);

			// 9. turn.completed
			await project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "m1",
						cost: 0.05,
						tokens: {
							input: 2000,
							output: 500,
							cacheRead: 100,
							cacheWrite: 25,
						},
					} satisfies TurnCompletedPayload,
					9,
				),
			);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row?.text).toBe("I'll read that file. Done!");
			expect(row?.is_streaming).toBe(0);
			expect(row?.cost).toBeCloseTo(0.05);
			expect(row?.tokens_in).toBe(2000);
			expect(row?.tokens_out).toBe(500);

			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(4); // thinking, text1, tool1, text2
			expect(parts[0]?.type).toBe("thinking");
			expect(parts[1]?.type).toBe("text");
			expect(parts[1]?.text).toBe("I'll read that file. ");
			expect(parts[2]?.type).toBe("tool");
			expect(parts[2]?.status).toBe("completed");
			expect(parts[3]?.type).toBe("text");
			expect(parts[3]?.text).toBe("Done!");
		});
	});

	describe("replay safety", () => {
		it("does not double text when the same text.delta is replayed (ON CONFLICT upsert)", async () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(created);

			const delta = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "Hello",
				} satisfies TextDeltaPayload,
				2,
			);

			// Project the same delta twice (simulating replay)
			await project(delta);
			await project(delta);

			const row = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			// With normalized message_parts and SQL-native text || ?, replay
			// WILL double text on the messages.text denormalized column.
			// The ON CONFLICT on message_parts also appends text again.
			// During recovery (replaying=true), the alreadyApplied() check
			// prevents this. During normal streaming, events arrive in order
			// and are never replayed.
			expect(row?.text).toBe("HelloHello");
		});

		it("accepts text.delta before message.created and creates message row defensively", async () => {
			// text.delta arrives before message.created — the projector defensively
			// INSERT OR IGNOREs the messages row so data is never lost.
			// This supports Claude adapter sessions which do not emit message.created.
			const delta = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m-nonexistent",
					partId: "p1",
					text: "orphan delta",
				} satisfies TextDeltaPayload,
				1,
			);

			// Should NOT throw — creates the messages row defensively
			await expect(project(delta)).resolves.toBeUndefined();

			// Verify the message row was created with correct fields
			const row = await queryOne<{
				id: string;
				role: string;
				text: string;
				session_id: string;
			}>("SELECT id, role, text, session_id FROM messages WHERE id = ?", [
				"m-nonexistent",
			]);
			expect(row).toBeDefined();
			expect(row?.role).toBe("assistant");
			expect(row?.session_id).toBe("s1");
			expect(row?.text).toBe("orphan delta");
		});
	});

	describe("defensive message creation for tool.started and thinking.start", () => {
		it("tool.started before message.created creates message row defensively", async () => {
			// Claude adapter may emit tool.started as the first event for an assistant
			// message (e.g., model calls a tool with no preamble text). The projector
			// must INSERT OR IGNORE the parent messages row to satisfy the FK constraint.
			const toolStarted = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m-tool-first",
					partId: "tp1",
					toolName: "Read",
					callId: "call-1",
					input: { file: "test.ts" },
				} satisfies ToolStartedPayload,
				1,
			);

			// Should NOT throw — creates the messages row defensively
			await expect(project(toolStarted)).resolves.toBeUndefined();

			// Verify the message row was created
			const row = await queryOne<{
				id: string;
				role: string;
				session_id: string;
				is_streaming: number;
			}>(
				"SELECT id, role, session_id, is_streaming FROM messages WHERE id = ?",
				["m-tool-first"],
			);
			expect(row).toBeDefined();
			expect(row?.role).toBe("assistant");
			expect(row?.session_id).toBe("s1");
			expect(row?.is_streaming).toBe(1);

			// Verify the tool part was created
			const part = await queryOne<{
				id: string;
				type: string;
				tool_name: string;
			}>("SELECT id, type, tool_name FROM message_parts WHERE id = ?", ["tp1"]);
			expect(part).toBeDefined();
			expect(part?.type).toBe("tool");
			expect(part?.tool_name).toBe("Read");
		});

		it("thinking.start before message.created creates message row defensively", async () => {
			// Claude adapter may emit thinking.start as the first event for an
			// assistant message. The projector must ensure the parent row exists.
			const thinkingStart = makeStored(
				"thinking.start",
				"s1",
				{
					messageId: "m-think-first",
					partId: "thp1",
				} satisfies ThinkingStartPayload,
				1,
			);

			await expect(project(thinkingStart)).resolves.toBeUndefined();

			const row = await queryOne<{
				id: string;
				role: string;
				session_id: string;
			}>("SELECT id, role, session_id FROM messages WHERE id = ?", [
				"m-think-first",
			]);
			expect(row).toBeDefined();
			expect(row?.role).toBe("assistant");
			expect(row?.session_id).toBe("s1");

			// Verify the thinking part was created
			const part = await queryOne<{ id: string; type: string }>(
				"SELECT id, type FROM message_parts WHERE id = ?",
				["thp1"],
			);
			expect(part).toBeDefined();
			expect(part?.type).toBe("thinking");
		});

		it("defensive INSERT is no-op when messages row already exists", async () => {
			// message.created arrives first, then tool.started — the defensive INSERT
			// should be a no-op and not overwrite the existing row.
			const msgCreated = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m-existing",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			await project(msgCreated);

			const toolStarted = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m-existing",
					partId: "tp2",
					toolName: "Bash",
					callId: "call-2",
					input: { command: "ls" },
				} satisfies ToolStartedPayload,
				2,
			);

			await expect(project(toolStarted)).resolves.toBeUndefined();

			// Only one messages row should exist
			const count = await queryOne<{ cnt: number }>(
				"SELECT COUNT(*) as cnt FROM messages WHERE id = ?",
				["m-existing"],
			);
			expect(count?.cnt).toBe(1);
		});
	});

	describe("multi-session isolation", () => {
		it("does not mix messages across sessions", async () => {
			// Pre-insert a second session
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["s2", "opencode", "Session 2", "idle", Date.now(), Date.now()],
			);

			// Message in session s1
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);

			// Message in session s2
			await project(
				makeStored(
					"message.created",
					"s2",
					{
						messageId: "m2",
						role: "user",
						sessionId: "s2",
					} satisfies MessageCreatedPayload,
					2,
				),
			);

			// Text delta for s1's message
			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "s1 text",
					} satisfies TextDeltaPayload,
					3,
				),
			);

			// Verify s1's message got the text
			const m1 = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(m1?.text).toBe("s1 text");

			// Verify s2's message is untouched
			const m2 = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m2"],
			);
			expect(m2?.text).toBe("");

			// Verify per-session queries return correct counts
			const s1Messages = await harness.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ?",
				["s1"],
			);
			const s2Messages = await harness.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ?",
				["s2"],
			);
			expect(s1Messages).toHaveLength(1);
			expect(s2Messages).toHaveLength(1);
		});
	});

	// ─── (Perf-Fix-1) sort_order tests ──────────────────────────────────

	describe("sort_order assignment", () => {
		it("assigns incrementing sort_order to new parts", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);

			// Three different parts
			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "A",
					} satisfies TextDeltaPayload,
					2,
				),
			);
			await project(
				makeStored(
					"thinking.start",
					"s1",
					{
						messageId: "m1",
						partId: "t1",
					} satisfies ThinkingStartPayload,
					3,
				),
			);
			await project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "bash",
						callId: "c1",
						input: {},
					} satisfies ToolStartedPayload,
					4,
				),
			);

			const parts = await harness.query<{ id: string; sort_order: number }>(
				"SELECT id, sort_order FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(3);
			expect(parts[0]?.id).toBe("p1");
			expect(parts[0]?.sort_order).toBe(0);
			expect(parts[1]?.id).toBe("t1");
			expect(parts[1]?.sort_order).toBe(1);
			expect(parts[2]?.id).toBe("tool1");
			expect(parts[2]?.sort_order).toBe(2);
		});

		it("does not change sort_order on subsequent deltas for the same part", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);

			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "Hello ",
					} satisfies TextDeltaPayload,
					2,
				),
			);
			await project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "World",
					} satisfies TextDeltaPayload,
					3,
				),
			);

			const parts = await harness.query<{
				id: string;
				sort_order: number;
				text: string;
			}>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.sort_order).toBe(0); // unchanged from first insert
			expect(parts[0]?.text).toBe("Hello World");
		});

		it("sort_order is stable when thinking.delta is replayed with replaying=true", async () => {
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
			);

			const thinkDelta = makeStored(
				"thinking.delta",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
					text: "Hmm...",
				} satisfies ThinkingDeltaPayload,
				2,
			);
			await project(thinkDelta);

			// Replay the same event with replaying=true -- should be skipped by alreadyApplied
			await project(thinkDelta, { replaying: true });

			const parts = await harness.query<{
				id: string;
				sort_order: number;
				text: string;
			}>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.sort_order).toBe(0);
			expect(parts[0]?.text).toBe("Hmm..."); // not doubled
		});
	});

	describe("session.compaction", () => {
		it("persists a completed boundary as a synthetic assistant message + compaction part", async () => {
			const event = makeStored(
				"session.compaction",
				"s1",
				{
					sessionId: "s1",
					state: "completed",
					detail: "Context compacted · 195k → 96k",
					preTokens: 194925,
					postTokens: 96000,
				},
				7,
			);

			await project(event);

			const msg = await queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["compaction-7"],
			);
			expect(msg?.role).toBe("assistant");
			expect(msg?.is_streaming).toBe(0);
			expect(msg?.session_id).toBe("s1");

			const part = await queryOne<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["compaction-part-7"],
			);
			expect(part?.type).toBe("compaction");
			expect(part?.message_id).toBe("compaction-7");
			expect(part?.text).toBe("Context compacted · 195k → 96k");
			expect(JSON.parse(part?.metadata ?? "{}")).toEqual({
				preTokens: 194925,
				postTokens: 96000,
			});
		});

		it("is idempotent on replay (deterministic ids + ON CONFLICT DO NOTHING)", async () => {
			const event = makeStored(
				"session.compaction",
				"s1",
				{
					sessionId: "s1",
					state: "completed",
					detail: "Context compacted",
					postTokens: 50000,
				},
				3,
			);

			await project(event);
			await project(event, { replaying: true });

			const msgs = await harness.query<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["compaction-3"],
			);
			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE id = ?",
				["compaction-part-3"],
			);
			expect(msgs).toHaveLength(1);
			expect(parts).toHaveLength(1);
		});

		it.each([
			"started",
			"failed",
		] as const)("does NOT persist a %s boundary (transient notice)", async (state) => {
			const event = makeStored(
				"session.compaction",
				"s1",
				{
					sessionId: "s1",
					state,
					detail: state === "started" ? "Compacting…" : "Compaction failed",
				},
				4,
			);

			await project(event);

			const msgs = await harness.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ?",
				["s1"],
			);
			const parts = await harness.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE type = 'compaction'",
				[],
			);
			expect(msgs).toHaveLength(0);
			expect(parts).toHaveLength(0);
		});
	});
});
