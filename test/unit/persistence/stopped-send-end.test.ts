import { afterEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";

// 82tn.83: a send a Stop ends before delivery is placed by main's writer after its Run's end
// (CONTRACT 664-666, 970-973). Failure modes: lane-83 audit rows 7, 8, 10, 11, 12.
type Fact = [type: string, data: object, runId?: string];

const user = (input: string): object => ({
	messageId: input,
	sessionId: "s",
	role: "user",
	inputId: input,
});

const events = (facts: readonly Fact[]) =>
	facts.map(
		([type, data, runId], index) =>
			({
				eventId: createEventId(),
				type,
				sessionId: "s",
				projectId: "test-project",
				provider: "opencode",
				createdAt: index + 1,
				sequence: index + 1,
				streamVersion: index + 1,
				metadata: runId ? { runId } : {},
				data,
			}) as StoredEvent,
	);

describe("a stopped send placed after its Run's end", () => {
	const harnesses: EffectProjectionHarness[] = [];
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
	});

	/** Projects the facts one by one, or as one replay batch. */
	const project = async (facts: readonly Fact[], batch = false) => {
		const harness = makeEffectProjectionHarness();
		harnesses.push(harness);
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES ('s', 'opencode', 'test', 'idle', 0, 0)",
		);
		const stored = events(facts);
		if (batch) await harness.reproject(stored);
		else for (const event of stored) await harness.reproject([event]);
		return harness.query<{
			last_turn_end_input_id: string | null;
			last_turn_end_version: number | null;
			last_turn_error_at: number | null;
		}>(
			"SELECT last_turn_end_input_id, last_turn_end_version, last_turn_error_at FROM sessions WHERE id = 's'",
		);
	};

	const stoppedThenPlaced: Fact[] = [
		["run.requested", { runId: "r1", inputId: "i1" }, "r1"],
		["turn.interrupted", { messageId: "" }, "r1"],
		["message.created", user("i1"), "r1"],
	];

	it("ends the browser's send at its placement, after the Run's end", async () => {
		expect(await project(stoppedThenPlaced)).toEqual([
			{
				last_turn_end_input_id: "i1",
				last_turn_end_version: 3,
				last_turn_error_at: null,
			},
		]);
	});

	it("gives a replay batch the same end as live projection (audit 10)", async () => {
		expect(await project(stoppedThenPlaced, true)).toEqual(
			await project(stoppedThenPlaced),
		);
	});

	it("keeps an error end's time for a send refused before delivery", async () => {
		expect(
			await project([
				["run.requested", { runId: "r1", inputId: "i1" }, "r1"],
				["turn.error", { messageId: "", error: "refused" }, "r1"],
				["message.created", user("i1"), "r1"],
			]),
		).toEqual([
			{
				last_turn_end_input_id: "i1",
				last_turn_end_version: 3,
				last_turn_error_at: 2,
			},
		]);
	});

	it("leaves the end alone for a second Stop after the placement (audit 7)", async () => {
		expect(
			await project([
				...stoppedThenPlaced,
				["turn.interrupted", { messageId: "" }, "r1"],
			]),
		).toEqual(await project(stoppedThenPlaced));
	});

	it("never moves a newer Run's end back to the late placement (audit 8)", async () => {
		const [end] = await project([
			["run.requested", { runId: "r1", inputId: "i1" }, "r1"],
			["turn.interrupted", { messageId: "" }, "r1"],
			["message.created", user("i2"), "r2"],
			["run.requested", { runId: "r2", inputId: "i2" }, "r2"],
			["run.started", { requestedRunId: "r2", inputId: "i2" }, "r2"],
			// OpenCode's Run ends at its idle status.
			["session.status", { sessionId: "s", status: "idle" }, "r2"],
			["message.created", user("i1"), "r1"],
		]);
		expect(end).toMatchObject({
			last_turn_end_input_id: "i2",
			last_turn_end_version: 6,
		});
	});

	it("never moves an end that already named another member of the Run (audit 11)", async () => {
		const [end] = await project([
			["run.requested", { runId: "r1", inputId: "i1" }, "r1"],
			["message.created", user("i1"), "r1"],
			["run.started", { requestedRunId: "r1", inputId: "i1" }, "r1"],
			["turn.interrupted", { messageId: "" }, "r1"],
			["message.created", user("i2"), "r1"],
		]);
		expect(end).toMatchObject({
			last_turn_end_input_id: "i1",
			last_turn_end_version: 4,
		});
	});

	it("never moves the end for a placement into a Run still open (audit 12)", async () => {
		expect(
			await project([
				["run.requested", { runId: "r1", inputId: "i1" }, "r1"],
				["message.created", user("i1"), "r1"],
			]),
		).toEqual([
			{
				last_turn_end_input_id: null,
				last_turn_end_version: null,
				last_turn_error_at: null,
			},
		]);
	});
});
