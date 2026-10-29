import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllEffectProjectors } from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	canonicalEvent,
	type LiveEventType,
	type StoredEvent,
} from "../../../../src/lib/persistence/events.js";
import resumedTurnEvents from "../../../fixtures/claude-resumed-turn.json" with {
	type: "json",
};
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../../helpers/effect-projection-harness.js";
import { providerRuntimeEventFromCanonical } from "../../../helpers/provider-runtime-event.js";

interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	run_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
	requested_model: string | null;
	expected_model: string | null;
	actual_model: string | null;
}

// Failure cases: recency invents ownership, queued inputs join too soon,
// foreign/duplicate terminals settle another run, late output reopens a run,
// or run ownership drops accounting and model evidence.
describe("TurnProjector", () => {
	let harness: EffectProjectionHarness;
	let sequence: number;
	const now = 1_000;

	beforeEach(async () => {
		sequence = 0;
		const projector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "turn",
		);
		if (!projector) throw new Error("Turn projector not found");
		harness = makeEffectProjectionHarness([projector]);
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s1', 'claude', 'Test', 'idle', ?, ?)",
			[now, now],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	function event<T extends LiveEventType>(
		type: T,
		data: Parameters<typeof canonicalEvent<T>>[2],
		options: { runId?: string; provider?: string; sessionId?: string } = {},
	): StoredEvent {
		sequence += 1;
		return {
			...canonicalEvent(type, options.sessionId ?? "s1", data, {
				provider: options.provider ?? "claude",
				createdAt: now + sequence,
				metadata: options.runId ? { runId: options.runId } : {},
			}),
			sequence,
			streamVersion: sequence,
			projectId: "test-project",
		} as StoredEvent;
	}

	async function project<T extends LiveEventType>(
		type: T,
		data: Parameters<typeof canonicalEvent<T>>[2],
		options?: { runId?: string; provider?: string; sessionId?: string },
	): Promise<StoredEvent> {
		const stored = event(type, data, options);
		await harness.reproject([stored]);
		return stored;
	}

	async function input(inputId: string, runId?: string): Promise<void> {
		await project(
			"message.created",
			{
				messageId: inputId,
				role: "user",
				sessionId: "s1",
			},
			runId ? { runId } : {},
		);
	}

	async function reserve(runId: string, inputId: string): Promise<void> {
		await project("run.requested", { runId, inputId }, { runId });
	}

	async function accept(
		inputId: string,
		runId: string,
		requestedRunId = runId,
	): Promise<void> {
		await project("run.started", { inputId, requestedRunId }, { runId });
	}

	async function turn(inputId: string): Promise<TurnRow | undefined> {
		return (
			await harness.query<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				inputId,
			])
		)[0];
	}

	it("keeps historical unowned resumed output unplaced", async () => {
		const sessionId = "ses_c2d8cd521bc14f9f8f7700096bbf1d23";
		await harness.query(
			"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES (?, 'claude', ?, ?)",
			[sessionId, now, now],
		);
		for (const [index, recorded] of resumedTurnEvents.entries()) {
			await harness.reproject([
				{
					...recorded,
					eventId: `recorded-${recorded.sequence}`,
					sessionId,
					projectId: "test-project",
					streamVersion: index,
					metadata: {},
				} as StoredEvent,
			]);
			expect(await turn("52feab57-ed40-4885-b23b-71dcd78209a8")).toMatchObject({
				state: "pending",
				run_id: null,
				assistant_message_id: null,
				started_at: null,
				completed_at: null,
				cost: null,
			});
		}
	});

	// An unaccepted steer has no foreground children; its failure cannot idle
	// another run's Task subtree, while that subtree's own failure still must.
	it.each([
		"turn.error",
		"turn.interrupted",
	] as const)("keeps active subagents busy when an unrelated pending reservation receives %s", async (terminal) => {
		await harness.dispose();
		harness = makeEffectProjectionHarness();
		for (const sessionId of ["s1", "child", "grandchild", "background"]) {
			await project(
				"session.created",
				{ sessionId, title: sessionId, provider: "claude" },
				{ sessionId },
			);
			if (sessionId !== "s1")
				await project(
					"session.status",
					{ sessionId, status: "busy" },
					{ sessionId },
				);
		}
		await reserve("active", "u1");
		await input("u1", "active");
		await accept("u1", "active");
		await project(
			"message.created",
			{ messageId: "a1", role: "assistant", sessionId: "s1", parentID: "u1" },
			{ runId: "active" },
		);
		await project(
			"message.created",
			{ messageId: "child-answer", role: "assistant", sessionId: "child" },
			{ sessionId: "child" },
		);
		for (const [sessionId, messageId, partId, childSessionId, backgrounded] of [
			["s1", "a1", "task", "child", false],
			["s1", "a1", "background-task", "background", true],
			["child", "child-answer", "nested-task", "grandchild", false],
		] as const) {
			await project(
				"tool.started",
				{
					messageId,
					partId,
					callId: partId,
					toolName: "Task",
					input: { tool: "Task", description: "Child task", prompt: "Work" },
				},
				{ sessionId },
			);
			await project(
				"tool.running",
				{ messageId, partId, metadata: { childSessionId, backgrounded } },
				{ sessionId },
			);
		}
		await reserve("pending", "u2");
		if (terminal === "turn.error") await input("u2", "pending");
		await project(
			terminal,
			terminal === "turn.error"
				? { messageId: "", error: "before intake" }
				: { messageId: "" },
			{ runId: "pending" },
		);
		expect(
			await harness.query(
				"SELECT id, status FROM sessions WHERE id <> 's1' ORDER BY id",
			),
		).toEqual([
			{ id: "background", status: "busy" },
			{ id: "child", status: "busy" },
			{ id: "grandchild", status: "busy" },
		]);
		await project(
			terminal,
			terminal === "turn.error"
				? { messageId: "a1", error: "active failed" }
				: { messageId: "a1" },
			{ runId: "active" },
		);
		expect(
			await harness.query(
				"SELECT id, status FROM sessions WHERE id <> 's1' ORDER BY id",
			),
		).toEqual([
			{ id: "background", status: "busy" },
			{ id: "child", status: "idle" },
			{ id: "grandchild", status: "idle" },
		]);
	});

	it("leaves placed input pending until its provider accepts it", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await project(
			"session.status",
			{ sessionId: "s1", status: "busy" },
			{ runId: "r1" },
		);
		await project(
			"message.created",
			{ messageId: "a1", role: "assistant", sessionId: "s1" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "pending",
			run_id: "r1",
			started_at: null,
		});
		const accepted = await project(
			"run.started",
			{ inputId: "u1", requestedRunId: "r1" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "running",
			run_id: "r1",
			started_at: accepted.createdAt,
		});
	});

	it.each([
		"turn.completed",
		"turn.error",
		"turn.interrupted",
	] as const)("%s closes streaming member messages without an adapter message identity", async (type) => {
		for (const [runId, userId, messageId] of [
			["r1", "u1", "a1"],
			["r2", "u2", "a2"],
		] as const) {
			await reserve(runId, userId);
			await input(userId, runId);
			await accept(userId, runId);
			await harness.query(
				"INSERT INTO messages (id, session_id, role, turn_id, is_streaming, created_at, updated_at) VALUES (?, 's1', 'assistant', ?, 1, 1, 1)",
				[messageId, userId],
			);
			await harness.query(
				"INSERT INTO message_parts (id, message_id, type, status, sort_order, created_at, updated_at) VALUES (?, ?, 'thinking', 'running', 0, 1, 1)",
				[`thinking-${messageId}`, messageId],
			);
		}
		await project(type, { messageId: "", error: "Ended" }, { runId: "r1" });
		expect(
			await harness.query("SELECT id, is_streaming FROM messages ORDER BY id"),
		).toEqual([
			{ id: "a1", is_streaming: 0 },
			{ id: "a2", is_streaming: 1 },
		]);
		expect(
			await harness.query(
				"SELECT message_id, status FROM message_parts ORDER BY message_id",
			),
		).toEqual([
			{ message_id: "a1", status: "completed" },
			{ message_id: "a2", status: "running" },
		]);
	});

	it("joins a placed steer on acceptance and closes both member inputs together", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		await input("u2", "r2");
		await reserve("r2", "u2");
		expect(await turn("u2")).toMatchObject({ state: "pending", run_id: "r2" });
		await accept("u2", "r1", "r2");
		expect(
			await harness.query("SELECT id, status FROM provider_runs ORDER BY id"),
		).toEqual([
			{ id: "r1", status: "running" },
			{ id: "r2", status: "joined" },
		]);
		const terminal = await project(
			"turn.completed",
			{ messageId: "a1" },
			{ runId: "r1" },
		);
		for (const id of ["u1", "u2"])
			expect(await turn(id)).toMatchObject({
				state: "completed",
				run_id: "r1",
				completed_at: terminal.createdAt,
			});
	});

	it.each([
		"turn.error",
		"turn.interrupted",
	] as const)("%s closes its exact member input without inventing acceptance", async (type) => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await input("u2", "r2");
		await reserve("r2", "u2");
		const terminal = await project(
			type,
			{ messageId: "", error: "Stopped before intake" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			state: type === "turn.error" ? "error" : "interrupted",
			run_id: "r1",
			started_at: null,
			completed_at: terminal.createdAt,
		});
		expect(await turn("u2")).toMatchObject({
			state: "pending",
			run_id: "r2",
			completed_at: null,
		});
	});

	it("keeps back-to-back runs independent and ignores late duplicate completion", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		const terminal = await project(
			"turn.completed",
			{ messageId: "a1" },
			{ runId: "r1" },
		);
		await input("u2", "r2");
		await reserve("r2", "u2");
		await accept("u2", "r2");
		await harness.reproject([terminal]);
		await project(
			"message.created",
			{ messageId: "late", role: "assistant", sessionId: "s1" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "completed",
			completed_at: terminal.createdAt,
		});
		expect(await turn("u2")).toMatchObject({
			state: "running",
			run_id: "r2",
			completed_at: null,
		});
		await project("turn.completed", { messageId: "a2" }, { runId: "r2" });
		expect(await turn("u2")).toMatchObject({ state: "completed" });
	});

	it.each([
		"turn.completed",
		"turn.error",
		"turn.interrupted",
	] as const)("requires ownership for %s even with a matching message id", async (type) => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		for (const runId of [undefined, "unknown"]) {
			await project(
				type,
				{ messageId: "u1", error: "failed" },
				runId ? { runId } : {},
			);
			expect(await turn("u1")).toMatchObject({
				state: "running",
				completed_at: null,
			});
		}
		await project(
			type,
			{ messageId: "unmatched", error: "failed" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			state:
				type === "turn.completed"
					? "completed"
					: type === "turn.error"
						? "error"
						: "interrupted",
		});
	});

	it("does not settle a foreign session through a known run id", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		await harness.query(
			"INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('s2', 'claude', ?, ?)",
			[now, now],
		);
		await project(
			"turn.error",
			{ messageId: "u1", error: "wrong session" },
			{ runId: "r1", sessionId: "s2" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "running",
			completed_at: null,
		});
	});

	it("retains OpenCode message parents without using them to settle a run", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		await project(
			"message.created",
			{ messageId: "a1", role: "assistant", sessionId: "s1", parentID: "u1" },
			{ runId: "r1", provider: "opencode" },
		);
		expect(await turn("u1")).toMatchObject({
			assistant_message_id: "a1",
			state: "running",
		});
		await project(
			"turn.completed",
			{
				messageId: "a1",
				userMessageId: "u1",
				cost: 0.042,
				tokens: { input: 3000, output: 800 },
			},
			{ runId: "r1", provider: "opencode" },
		);
		await project(
			"turn.completed",
			{
				messageId: "a2",
				userMessageId: "u1",
				cost: 0.05,
				tokens: { input: 100, output: 20 },
			},
			{ runId: "r1", provider: "opencode" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "running",
			cost: 0.05,
			tokens_in: 3100,
			tokens_out: 820,
			completed_at: null,
		});
		const terminal = await project(
			"session.status",
			{ sessionId: "s1", status: "idle" },
			{ runId: "r1", provider: "opencode" },
		);
		expect(await turn("u1")).toMatchObject({
			state: "completed",
			completed_at: terminal.createdAt,
		});
	});

	it("preserves known accounting when usage is omitted and accepts zero values", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		for (const [index, usage] of [
			{},
			{ cost: 0.5, tokens: { input: 100, output: 20 } },
			{ tokens: { output: 0 } },
			{ cost: 0, tokens: { input: 0 } },
		].entries()) {
			await project(
				"turn.completed",
				{ messageId: `a${index}`, userMessageId: "u1", ...usage },
				{ runId: "r1", provider: "opencode" },
			);
			expect(await turn("u1")).toMatchObject({
				state: "running",
				cost: index === 0 ? null : index === 3 ? 0 : 0.5,
				tokens_in: index === 0 ? null : 100,
				tokens_out: index === 0 ? null : 20,
			});
		}
	});

	it("applies model evidence only to accepted inputs of its run and is replay-idempotent", async () => {
		for (const id of ["u1", "u2", "queued"])
			await input(id, id === "queued" ? undefined : "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		await accept("u2", "r1");
		const resolved = await project(
			"turn.model_resolved",
			{
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5[1m]",
				actualModel: "claude-sonnet-5[1m]",
			},
			{ runId: "r1" },
		);
		await harness.reproject([resolved]);
		for (const id of ["u1", "u2"])
			expect(await turn(id)).toMatchObject({
				requested_model: "sonnet",
				expected_model: "claude-sonnet-5[1m]",
				actual_model: "claude-sonnet-5[1m]",
			});
		expect(await turn("queued")).toMatchObject({ actual_model: null });
	});

	it("preserves nullable model evidence and leaves unowned evidence unplaced", async () => {
		await input("u1", "r1");
		await reserve("r1", "u1");
		await accept("u1", "r1");
		await project("turn.model_resolved", { actualModel: "unowned" });
		expect(await turn("u1")).toMatchObject({ actual_model: null });
		await project(
			"turn.model_resolved",
			{ actualModel: "claude-opus-4-6" },
			{ runId: "r1" },
		);
		expect(await turn("u1")).toMatchObject({
			requested_model: null,
			expected_model: null,
			actual_model: "claude-opus-4-6",
		});
	});
});

// Placement can precede intake or follow the run's end; neither ordering may
// borrow a newer run, accept another input, or leave a member unsettled.
describe("turn membership through provider ingestion", () => {
	let harness: EffectProjectionHarness;
	let sequence: number;

	beforeEach(async () => {
		sequence = 0;
		harness = makeEffectProjectionHarness();
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s1', 'claude', 'Test', 'idle', 1, 1)",
		);
	});

	afterEach(async () => {
		await harness.dispose();
	});

	async function ingest<T extends Exclude<LiveEventType, "run.requested">>(
		type: T,
		data: Parameters<typeof canonicalEvent<T>>[2],
		runId?: string,
	) {
		const event = canonicalEvent(type, "s1", data, {
			provider: "claude",
			createdAt: ++sequence,
			metadata: runId ? { runId } : {},
		});
		await harness.ingest({
			...providerRuntimeEventFromCanonical(event),
			...(runId ? { runId } : {}),
		});
		return event;
	}

	async function reserve(runId: string, inputId: string) {
		await harness.reproject([
			{
				...canonicalEvent(
					"run.requested",
					"s1",
					{ runId, inputId },
					{
						provider: "claude",
						createdAt: ++sequence,
						metadata: { runId },
					},
				),
				sequence,
				streamVersion: sequence,
				projectId: "test-project",
			},
		]);
	}

	const place = (inputId: string, runId?: string) =>
		ingest(
			"message.created",
			{ messageId: inputId, inputId, sessionId: "s1", role: "user" },
			runId,
		);

	const turns = () =>
		harness.query(
			"SELECT id, state, run_id, started_at, completed_at FROM turns ORDER BY id",
		);

	it("does not infer membership for an unowned input from later acceptance", async () => {
		await place("u1");
		await reserve("r1", "u1");
		await ingest("run.started", { inputId: "u1", requestedRunId: "r1" }, "r1");
		await ingest("turn.completed", { messageId: "" }, "r1");
		expect(await turns()).toEqual([
			{
				id: "u1",
				state: "pending",
				run_id: null,
				started_at: null,
				completed_at: null,
			},
		]);
	});

	it("records placement membership before intake and settles without an input identity", async () => {
		await reserve("r1", "u1");
		await place("u1", "r1");
		await place("unowned");
		expect(await turns()).toEqual([
			{
				id: "u1",
				state: "pending",
				run_id: "r1",
				started_at: null,
				completed_at: null,
			},
			{
				id: "unowned",
				state: "pending",
				run_id: null,
				started_at: null,
				completed_at: null,
			},
		]);
		const terminal = await ingest(
			"turn.error",
			{ messageId: "", error: "Rejected before intake" },
			"r1",
		);
		expect(await turns()).toEqual([
			{
				id: "u1",
				state: "error",
				run_id: "r1",
				started_at: null,
				completed_at: terminal.createdAt,
			},
			{
				id: "unowned",
				state: "pending",
				run_id: null,
				started_at: null,
				completed_at: null,
			},
		]);
	});

	it("rewrites a joined reservation cohort and timestamps each input at its own intake", async () => {
		await reserve("root", "u1");
		await place("u1", "root");
		const rootStarted = await ingest(
			"run.started",
			{ inputId: "u1", requestedRunId: "root" },
			"root",
		);
		await reserve("steer", "u2");
		await place("u2", "steer");
		await place("u3", "steer");
		const steerStarted = await ingest(
			"run.started",
			{ inputId: "u2", requestedRunId: "steer" },
			"root",
		);
		expect(await turns()).toEqual([
			{
				id: "u1",
				state: "running",
				run_id: "root",
				started_at: rootStarted.createdAt,
				completed_at: null,
			},
			{
				id: "u2",
				state: "running",
				run_id: "root",
				started_at: steerStarted.createdAt,
				completed_at: null,
			},
			{
				id: "u3",
				state: "pending",
				run_id: "root",
				started_at: null,
				completed_at: null,
			},
		]);
		const terminal = await ingest("turn.completed", { messageId: "" }, "root");
		expect(
			await harness.query(
				"SELECT id, state, completed_at FROM turns ORDER BY id",
			),
		).toEqual(
			["u1", "u2", "u3"].map((id) => ({
				id,
				state: "completed",
				completed_at: terminal.createdAt,
			})),
		);
	});

	it.each([
		["turn.completed", "completed"],
		["turn.error", "error"],
		["turn.interrupted", "interrupted"],
	] as const)("late placement inherits its exact %s without intake", async (type, state) => {
		await reserve("old", "u1");
		const terminal = await ingest(
			type,
			{ messageId: "", error: "Ended" },
			"old",
		);
		await reserve("new", "u2");
		await place("u2", "new");
		const newerStarted = await ingest(
			"run.started",
			{ inputId: "u2", requestedRunId: "new" },
			"new",
		);
		await place("u1", "old");
		expect(await turns()).toEqual([
			{
				id: "u1",
				state,
				run_id: "old",
				started_at: null,
				completed_at: terminal.createdAt,
			},
			{
				id: "u2",
				state: "running",
				run_id: "new",
				started_at: newerStarted.createdAt,
				completed_at: null,
			},
		]);
		// The browser can settle the exact input even if the shell feed has
		// already advanced to a later run's boundary.
		expect(
			(await harness.sessionMessagesWithParts("s1")).find(
				(message) => message.input_id === "u1",
			),
		).toMatchObject({
			turnTiming: { endedAt: terminal.createdAt },
		});
	});

	it("resolves a joined reservation when its member is placed after the effective run ends", async () => {
		await reserve("root", "u1");
		await place("u1", "root");
		await ingest(
			"run.started",
			{ inputId: "u1", requestedRunId: "root" },
			"root",
		);
		await reserve("steer", "u2");
		await ingest(
			"run.started",
			{ inputId: "u2", requestedRunId: "steer" },
			"root",
		);
		const terminal = await ingest(
			"turn.interrupted",
			{ messageId: "" },
			"root",
		);
		await place("u2", "steer");
		expect(
			await harness.query(
				"SELECT state, run_id, started_at, completed_at FROM turns WHERE id = 'u2'",
			),
		).toEqual([
			{
				state: "interrupted",
				run_id: "root",
				started_at: null,
				completed_at: terminal.createdAt,
			},
		]);
	});

	it("persists terminal provider state with the run transition and ignores duplicate terminal updates", async () => {
		await reserve("r1", "u1");
		await place("u1", "r1");
		await ingest("run.started", { inputId: "u1", requestedRunId: "r1" }, "r1");
		await ingest(
			"turn.completed",
			{
				messageId: "",
				providerStateUpdates: [
					{ key: "cursor", value: "finished" },
					{
						key: "nativeThread:claude",
						value: JSON.stringify({
							resumeSessionId: "sdk-thread",
							firstSequence: 0,
							deliveredThrough: 0,
						}),
					},
				],
			},
			"r1",
		);
		const rows = await harness.query<{ key: string; value: string }>(
			"SELECT key, value FROM provider_state WHERE session_id = 's1' ORDER BY key",
		);
		expect(rows[0]).toEqual({ key: "cursor", value: "finished" });
		expect(JSON.parse(rows[1]?.value ?? "null")).toEqual({
			resumeSessionId: "sdk-thread",
			firstSequence: 1,
			deliveredThrough: 3,
		});
		await ingest(
			"turn.completed",
			{
				messageId: "",
				providerStateUpdates: [{ key: "cursor", value: "duplicate" }],
			},
			"r1",
		);
		expect(
			await harness.query(
				"SELECT value FROM provider_state WHERE session_id = 's1' AND key = 'cursor'",
			),
		).toEqual([{ value: "finished" }]);
	});

	it("rolls back terminal provider state and run settlement together when an update is invalid", async () => {
		await reserve("r1", "u1");
		await place("u1", "r1");
		await ingest("run.started", { inputId: "u1", requestedRunId: "r1" }, "r1");
		await expect(
			ingest(
				"turn.completed",
				{
					messageId: "",
					providerStateUpdates: [
						{ key: "cursor", value: "must roll back" },
						{ key: "nativeThread:claude", value: "invalid json" },
					],
				},
				"r1",
			),
		).rejects.toThrow();
		expect(
			await harness.query(
				"SELECT key FROM provider_state WHERE session_id = 's1'",
			),
		).toEqual([]);
		expect(
			await harness.query("SELECT status FROM provider_runs WHERE id = 'r1'"),
		).toEqual([{ status: "running" }]);
		expect(
			await harness.query(
				"SELECT state, completed_at FROM turns WHERE id = 'u1'",
			),
		).toEqual([{ state: "running", completed_at: null }]);
	});
});
