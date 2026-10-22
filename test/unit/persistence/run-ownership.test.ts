import { afterEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";

describe("run terminal ownership", () => {
	let harness: EffectProjectionHarness;
	afterEach(async () => {
		await harness?.dispose();
	});
	it("leaves unowned signals unplaced and closes only member inputs of the terminal run once", async () => {
		harness = makeEffectProjectionHarness();
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s', 'claude', 'test', 'idle', 1, 1)",
		);
		let sequence = 0;
		const project = async (type: string, data: object, runId?: string) => {
			sequence += 1;
			await harness.reproject([
				{
					eventId: createEventId(),
					type,
					sessionId: "s",
					projectId: "test-project",
					provider: "claude",
					createdAt: sequence,
					sequence,
					streamVersion: sequence,
					metadata: runId ? { runId } : {},
					data,
				} as StoredEvent,
			]);
		};
		await project(
			"message.created",
			{
				messageId: "a",
				sessionId: "s",
				role: "user",
				inputId: "a",
			},
			"r1",
		);
		await project("session.status", { sessionId: "s", status: "busy" });
		expect(
			await harness.query("SELECT state FROM turns WHERE id = 'a'"),
		).toEqual([{ state: "pending" }]);
		await project("run.requested", { runId: "r1", inputId: "a" }, "r1");
		await project("run.started", { inputId: "a", requestedRunId: "r1" }, "r1");
		await project(
			"message.created",
			{
				messageId: "b",
				sessionId: "s",
				role: "user",
				inputId: "b",
			},
			"r2",
		);
		await project("run.requested", { runId: "r2", inputId: "b" }, "r2");
		await project("run.started", { inputId: "b", requestedRunId: "r2" }, "r1");
		await project(
			"message.created",
			{
				messageId: "c",
				sessionId: "s",
				role: "user",
				inputId: "c",
			},
			"r3",
		);
		await project("run.requested", { runId: "r3", inputId: "c" }, "r3");
		await project("run.started", { inputId: "c", requestedRunId: "r3" }, "r3");
		const endBefore = await harness.query(
			"SELECT last_turn_end_version FROM sessions WHERE id = 's'",
		);
		await project("turn.completed", { messageId: "unowned" });
		expect(
			await harness.query(
				"SELECT last_turn_end_version FROM sessions WHERE id = 's'",
			),
		).toEqual(endBefore);
		expect(
			await harness.query("SELECT id, state FROM turns ORDER BY id"),
		).toEqual([
			{ id: "a", state: "running" },
			{ id: "b", state: "running" },
			{ id: "c", state: "running" },
		]);
		await project("turn.completed", { messageId: "irrelevant", cost: 1 }, "r1");
		const finished = await harness.query(
			"SELECT id, state, completed_at, cost FROM turns ORDER BY id",
		);
		expect(finished).toEqual([
			{ id: "a", state: "completed", completed_at: sequence, cost: null },
			{ id: "b", state: "completed", completed_at: sequence, cost: null },
			{ id: "c", state: "running", completed_at: null, cost: null },
		]);
		await project("turn.completed", { messageId: "irrelevant", cost: 1 }, "r1");
		expect(
			await harness.query(
				"SELECT id, state, completed_at, cost FROM turns ORDER BY id",
			),
		).toEqual(finished);
		await project("turn.interrupted", { messageId: "c" }, "r1");
		expect(
			await harness.query("SELECT finish FROM messages WHERE id = 'c'"),
		).toEqual([{ finish: null }]);
		const boundary = await harness.query(
			"SELECT last_turn_end_input_id, last_turn_end_version FROM sessions WHERE id = 's'",
		);
		await project(
			"run.requested",
			{ runId: "unplaced", inputId: "never-placed" },
			"unplaced",
		);
		await project(
			"turn.error",
			{ messageId: "", error: "Intake refused" },
			"unplaced",
		);
		expect(
			await harness.query(
				"SELECT last_turn_end_input_id, last_turn_end_version FROM sessions WHERE id = 's'",
			),
		).toEqual(boundary);
		await project("turn.interrupted", { messageId: "irrelevant" }, "r3");
		expect(
			await harness.query("SELECT finish FROM messages WHERE id = 'c'"),
		).toEqual([{ finish: "interrupted" }]);
	});
	// A background task finishing after its run ended wakes Claude into a new
	// turn under the same run id; that turn's end is new output to read.
	it("marks a seen session unread when its ended run wakes into another turn", async () => {
		harness = makeEffectProjectionHarness();
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s', 'claude', 'test', 'idle', 1, 1)",
		);
		const facts: Array<[string, object]> = [
			[
				"message.created",
				{ messageId: "a", sessionId: "s", role: "user", inputId: "a" },
			],
			["run.requested", { runId: "r1", inputId: "a" }],
			["run.started", { inputId: "a", requestedRunId: "r1" }],
			[
				"message.created",
				{ messageId: "m1", sessionId: "s", role: "assistant" },
			],
			["turn.completed", { messageId: "m1" }],
		];
		const project = (from: number, batch: Array<[string, object]>) =>
			harness.reproject(
				batch.map(
					([type, data], index) =>
						({
							eventId: createEventId(),
							type,
							sessionId: "s",
							projectId: "test-project",
							provider: "claude",
							createdAt: from + index,
							sequence: from + index,
							streamVersion: from + index,
							metadata: { runId: "r1" },
							data,
						}) as StoredEvent,
				),
			);
		await project(1, facts);
		await harness.query(
			"UPDATE sessions SET seen_version = last_turn_end_version WHERE id = 's'",
		);
		await project(6, [
			["session.status", { sessionId: "s", status: "busy" }],
			[
				"message.created",
				{ messageId: "m2", sessionId: "s", role: "assistant" },
			],
			["turn.completed", { messageId: "m2" }],
		]);
		expect(
			await harness.query(
				"SELECT last_turn_end_version, unread FROM sessions WHERE id = 's'",
			),
		).toEqual([{ last_turn_end_version: 8, unread: 1 }]);
	});
	// OpenCode's idle ends its run, so a second idle on the ended run is
	// dropped: a late busy taken there would never be lifted.
	it("keeps an ended OpenCode run's late busy from sticking the session busy", async () => {
		harness = makeEffectProjectionHarness();
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('oc', 'opencode', 'test', 'idle', 1, 1)",
		);
		const facts: Array<[string, object]> = [
			[
				"message.created",
				{ messageId: "a", sessionId: "oc", role: "user", inputId: "a" },
			],
			["run.requested", { runId: "r1", inputId: "a" }],
			["run.started", { inputId: "a", requestedRunId: "r1" }],
			["session.status", { sessionId: "oc", status: "idle" }],
			["session.status", { sessionId: "oc", status: "busy" }],
			["session.status", { sessionId: "oc", status: "idle" }],
		];
		await harness.reproject(
			facts.map(
				([type, data], index) =>
					({
						eventId: createEventId(),
						type,
						sessionId: "oc",
						projectId: "test-project",
						provider: "opencode",
						createdAt: index + 1,
						sequence: index + 1,
						streamVersion: index + 1,
						metadata: { runId: "r1" },
						data,
					}) as StoredEvent,
			),
		);
		expect(
			await harness.query("SELECT status FROM sessions WHERE id = 'oc'"),
		).toEqual([{ status: "idle" }]);
	});
	it("places a delayed acceptance on its already-ended run without touching a newer run", async () => {
		harness = makeEffectProjectionHarness();
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('late', 'opencode', 'test', 'idle', 1, 1)",
		);
		const facts = [
			{
				type: "run.requested",
				data: { runId: "old-run", inputId: "old-input" },
				runId: "old-run",
			},
			{
				type: "session.status",
				data: { sessionId: "late", status: "idle" },
				runId: "old-run",
			},
			{
				type: "message.created",
				data: {
					sessionId: "late",
					messageId: "new-input",
					inputId: "new-input",
					role: "user",
				},
				runId: "new-run",
			},
			{
				type: "run.requested",
				data: { runId: "new-run", inputId: "new-input" },
				runId: "new-run",
			},
			{
				type: "run.started",
				data: { requestedRunId: "new-run", inputId: "new-input" },
				runId: "new-run",
			},
			{
				type: "message.created",
				data: {
					sessionId: "late",
					messageId: "old-input",
					inputId: "old-input",
					role: "user",
				},
				runId: "old-run",
			},
			{
				type: "run.started",
				data: { requestedRunId: "old-run", inputId: "old-input" },
				runId: "old-run",
			},
		];
		await harness.reproject(
			facts.map(
				({ type, data, runId }, index) =>
					({
						type,
						data,
						metadata: runId ? { runId } : {},
						sessionId: "late",
						projectId: "test-project",
						eventId: createEventId(),
						provider: "opencode",
						sequence: index + 1,
						streamVersion: index,
						createdAt: index + 1,
					}) as StoredEvent,
			),
		);
		expect(
			await harness.query(
				"SELECT id, state, run_id, completed_at FROM turns ORDER BY id",
			),
		).toEqual([
			{
				id: "new-input",
				state: "running",
				run_id: "new-run",
				completed_at: null,
			},
			{
				id: "old-input",
				state: "completed",
				run_id: "old-run",
				completed_at: 2,
			},
		]);
		expect(
			await harness.query("SELECT id, status FROM provider_runs ORDER BY id"),
		).toEqual([
			{ id: "new-run", status: "running" },
			{ id: "old-run", status: "completed" },
		]);
	});
});
