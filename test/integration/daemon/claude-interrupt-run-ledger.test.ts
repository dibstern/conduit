// A Claude Stop on the Run Ledger, replayed from the live order Claude CLI 2.1.301 showed
// (82tn.32.36; CONTRACT.md 3095-3112, 3.5): after an interrupt the stopped input's `cancelled`
// follows its `started` and its result, and inputs the interrupt's receipt lists `still_queued`
// then run as one merged turn whose result names them all. How it could fail (lane audit):
// 280. a `cancelled` after `started` ends the input's Run, or settles its send as never consumed,
//      so main sends it again;
// 281. that `cancelled` arriving before the input's result ends the Run twice, or before its turn;
// 282. a `cancelled` before `started` no longer ends its input;
// 283. a `still_queued` input's Run ends at the interrupt though the agent then runs it;
// 284. the merged result ends only one of the inputs it names, so the other's Run never ends;
// 285. a `still_queued` input's Run ends twice, or other than completed;
// 286. the stopped input's Run does not end interrupted at its own result;
// 287. a `still_queued` input is placed twice or not at all, or the session idles before the merged turn ends.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TRACE = "stop-with-steer-pending";
// stop-with-steer-pending.jsonl: a Stop during a tool call with one steer queued (line 26),
// the stopped input's error result (29), its cancelled (30), then the steer's turn (31-56).
const captured = readFileSync(
	join(import.meta.dirname, `../../fixtures/claude-sdk-traces/${TRACE}.jsonl`),
	"utf8",
)
	.split("\n")
	.filter((line) => line.trim() !== "");
const nativeSession = "f186b7cd-6f1a-468c-9871-349c497272d0";
const recordedSteer = "9b43c62f-1587-4e80-a70d-421c0c8ac373";
const command = (commandId: string, state: string) =>
	JSON.stringify({
		type: "command_lifecycle",
		command_uuid: commandId,
		state,
		uuid: randomUUID(),
		session_id: nativeSession,
	});
const lines = (from: number, to: number) => captured.slice(from - 1, to);

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				reason: string;
				forced: number | null;
			}[],
			sends: db
				.prepare(
					"SELECT status, attempt_count AS attempts FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as { status: string; attempts: number }[],
			inputs: db
				.prepare(
					"SELECT state FROM pending_inputs WHERE session_id = ? ORDER BY admitted_at, rowid",
				)
				.all(sessionId)
				.map((row) => (row as { state: string }).state),
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map((row) => (row as { state: string }).state),
			userMessages: db
				.prepare(
					"SELECT input_id AS inputId FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at, rowid",
				)
				.all(sessionId)
				.map((row) => (row as { inputId: string }).inputId),
			terminals: db
				.prepare(
					"SELECT type, json_extract(metadata, '$.runId') AS runId, data FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.interrupted', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => {
					const { type, runId, data } = row as {
						type: string;
						runId: string | null;
						data: string;
					};
					return {
						type,
						runId,
						messageId: (JSON.parse(data) as { messageId?: string }).messageId,
					};
				}),
		};
	} finally {
		db.close();
	}
};

describe("Claude Stop on the Run Ledger, in the live order", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-36-claude-interrupt.json",
			JSON.stringify({ ticket: "conduit-test-82tn.32.36", proofs }, null, 2),
		);
	});

	const replay = async (trace: readonly string[]) => {
		const plan = { turns: [TRACE] as const, delayMs: 50, tracesDir: "" };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
			claudeReplay: plan,
		});
		const fixture = harness;
		plan.tracesDir = join(fixture.root, "traces");
		mkdirSync(plan.tracesDir);
		writeFileSync(join(plan.tracesDir, `${TRACE}.jsonl`), trace.join("\n"));
		await fixture.restart();
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		return { fixture, browser };
	};
	const prompted = (fixture: ProcessHarness, text: string) =>
		fixture
			.claudeOptions()
			// A steer reaches the SDK after its hidden context handoff.
			.some((record) => record.prompt?.endsWith(text));

	it.each([
		["result then cancelled", [...lines(1, 25), ...lines(27, 30)]],
		[
			"cancelled then result",
			[...lines(1, 25), ...lines(27, 28), ...lines(30, 30), ...lines(29, 29)],
		],
	])("ends a stopped input's Run once, at its own result, when its cancel follows its start (%s)", async (order, trace) => {
		const { fixture, browser } = await replay(trace);
		const sessionId = await browser.createSession("Claude cancel after start");
		void browser.send(sessionId, "Alpha").catch(() => undefined);
		// test-waits-allow polling: the replay holds at its recorded interrupt; only the store shows it.
		await vi.waitFor(() => expect(prompted(fixture, "Alpha")).toBe(true), {
			timeout: 10_000,
		});
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		// test-waits-allow polling: the Run's end reaches only the store.
		await vi.waitFor(
			() => {
				const state = read(fixture, sessionId);
				expect(state.session.status).toBe("idle");
				expect(state.ends).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);
		const state = read(fixture, sessionId);
		expect(state.runs).toHaveLength(1);
		expect(state.ends).toEqual([
			expect.objectContaining({
				runId: state.runs[0]?.id,
				reason: "interrupted",
			}),
		]);
		// Sent once and consumed: the cancel after its start did not put it back in the queue.
		expect(state.sends).toEqual([{ status: "failed", attempts: 1 }]);
		expect(state.inputs).toEqual(["removed"]);
		expect(state.turns).toEqual(["interrupted"]);
		// Ended by its own result, which names the turn's message; the cancel names none.
		expect(state.terminals).toEqual([
			{
				type: "turn.interrupted",
				runId: state.runs[0]?.id,
				messageId: expect.stringMatching(/^msg_/),
			},
		]);
		expect(state.userMessages).toHaveLength(1);
		proofs.push({ case: `cancel after start, ${order}`, sessionId, ...state });
	});

	it("keeps both inputs an interrupt's receipt lists still queued, and ends their Run once at the merged result naming them", async () => {
		// The live order with two steers: both queued (26 and a second), the interrupt (27-29),
		// the stopped input's cancelled (30), both started (31 and a second), one merged turn
		// (32-54) whose result names both (55), and both completed (56 and a second).
		const second = randomUUID();
		const merged = JSON.parse(captured[54] ?? "{}") as Record<string, unknown>;
		const trace = [
			...lines(1, 26),
			command(second, "queued"),
			...lines(27, 31),
			command(second, "started"),
			...lines(32, 54),
			JSON.stringify({
				...merged,
				result: "bravo\ncharlie",
				user_message_uuid: second,
				user_message_uuids: [recordedSteer, second],
			}),
			...lines(56, 56),
			command(second, "completed"),
		];
		const { fixture, browser } = await replay(trace);
		const sessionId = await browser.createSession(
			"Claude interrupt still queued",
		);
		void browser.send(sessionId, "Alpha").catch(() => undefined);
		// test-waits-allow polling: the SDK's prompt queue reports only through the options file.
		await vi.waitFor(() => expect(prompted(fixture, "Alpha")).toBe(true), {
			timeout: 10_000,
		});
		for (const text of ["Bravo", "Charlie"]) {
			void browser
				.send(sessionId, text, undefined, "steer")
				.catch(() => undefined);
			// test-waits-allow polling: the SDK's prompt queue reports only through the options file.
			await vi.waitFor(() => expect(prompted(fixture, text)).toBe(true), {
				timeout: 10_000,
			});
		}
		await fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		// test-waits-allow polling: the merged turn's end reaches only the store.
		await vi.waitFor(
			() => {
				const state = read(fixture, sessionId);
				expect(state.session.status).toBe("idle");
				expect(state.turns).not.toContain("running");
				expect(state.ends.length).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 15_000 },
		);
		const state = read(fixture, sessionId);
		proofs.push({ case: "interrupt still queued", sessionId, ...state });
		// The stopped input's Run ends once at its own result, interrupted. The first still-queued
		// input starts a Run of its own after that end and the second joins it (CONTRACT.md 978-990,
		// case d); the merged result naming both ends that Run once, completed (3107-3108).
		expect(state.runs.map(({ status }) => status)).toEqual([
			"interrupted",
			"completed",
			"joined",
		]);
		const [stopped, owner] = state.runs;
		expect(state.ends).toEqual([
			expect.objectContaining({ runId: stopped?.id, reason: "interrupted" }),
			expect.objectContaining({ runId: owner?.id, reason: "completed" }),
		]);
		expect(state.terminals).toEqual([
			expect.objectContaining({ type: "turn.interrupted", runId: stopped?.id }),
			expect.objectContaining({ type: "turn.completed", runId: owner?.id }),
		]);
		expect(state.sends).toEqual([
			{ status: "failed", attempts: 1 },
			{ status: "completed", attempts: 1 },
			{ status: "completed", attempts: 1 },
		]);
		expect(state.turns).toEqual(["interrupted", "completed", "completed"]);
		expect(state.userMessages).toHaveLength(3);
		expect(new Set(state.userMessages).size).toBe(3);
		expect(state.inputs).toEqual(["removed", "removed", "removed"]);
	});
});
