// A turn Claude starts by itself is a Run that names its waking task (82tn.32.23; CONTRACT.md 8.3),
// over the isolated process harness and the recorded background-shell-turn trace. How it could fail
// (lane audit 1-11):
// 1. the arm never hands the active wake Run over, so the session row never names it;
// 2. the row names the wake by task id, or not at all, because the empty snapshot (trace line 85)
//    replaced the list that named the task before its notification (line 87);
// 3. the wake stays on the row after its Run ends, completed or interrupted;
// 4. the user Run that started the shell shows as woken;
// 5. the row is not re-sent when only the wake changes;
// 8. Stop does not interrupt the wake Run, or it ends forced at the alarm;
// 9. a message sent during the wake goes into the wake's turn instead of waiting;
// 10. it runs before the wake ends, or never runs after it.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, json_extract(data, '$.wakeTask.taskId') AS wakeTask FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as {
				sequence: number;
				type: string;
				wakeTask: string | null;
			}[],
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.forced') AS forced FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				reason: string;
				forced: number | null;
			}[],
			runs: db
				.prepare(
					"SELECT id FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string }[],
		};
	} finally {
		db.close();
	}
};

/** Every session_row this browser saw for the session, in order, with the feed that sent it. */
const rows = (browser: ProcessBrowser, sessionId: string) => {
	let feed = "";
	return browser.frames.flatMap(({ message }): Record<string, unknown>[] => {
		if (message["type"] === "shell" || message["type"] === "family")
			feed = String(message["type"]);
		return message["type"] === "session_row" && message["id"] === sessionId
			? [{ ...message, feed }]
			: [];
	});
};

describe("Claude wake Runs", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[task.name] = {
				...(proof[task.name] as object),
				outcome: task.result?.state === "pass" ? "passed" : "failed",
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-23-wake-runs-proof.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	const wakeHeld = async (title: string) => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: {
				turns: ["background-shell-turn", "pong-thinking-text-turn"],
			},
		});
		harness = fixture;
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession(title);
		// Hold the wake before its result (trace line 153), so it is still in flight.
		const hold = join(fixture.root, "claude-replay-hold");
		writeFileSync(hold, JSON.stringify({ turn: 1, message: 153, id: 1 }));
		await browser.send(sessionId, "Run sleep 8 in the background");
		// test-waits-allow polling: the held replay line reports only through this file.
		await vi.waitFor(() => expect(existsSync(`${hold}.reached`)).toBe(true), {
			timeout: 10_000,
		});
		const named = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["wakeRun"] !== undefined,
		);
		expect(named["wakeRun"]).toEqual({ task: "sleep 8" });
		// 8.3: a start waits for the wake's turn, so this send stays Queued.
		const queued = browser.send(sessionId, "ping");
		// test-waits-allow polling: the browser sees no frame when a Queued send is admitted.
		await vi.waitFor(() =>
			expect(
				read(fixture, sessionId).events.filter(
					(event) => event.type === "input.admitted",
				),
			).toHaveLength(2),
		);
		return { fixture, browser, sessionId, hold, queued };
	};

	/** The row named the wake only while it ran, and the queued send ran after it. */
	const settled = async (
		name: string,
		{
			fixture,
			browser,
			sessionId,
			queued,
		}: Awaited<ReturnType<typeof wakeHeld>>,
	) => {
		expect((await queued).chunks.join("")).toBe("pong");
		const ledger = read(fixture, sessionId);
		const turns = ledger.events.filter((event) =>
			event.type.startsWith("evidence.turn_"),
		);
		expect(turns).toEqual([
			expect.objectContaining({
				type: "evidence.turn_started",
				wakeTask: "bxtrbpf91",
			}),
			expect.objectContaining({ type: "evidence.turn_ended" }),
		]);
		const dispatched = ledger.events.filter(
			(event) => event.type === "run.dispatched",
		);
		expect(dispatched).toHaveLength(2);
		expect(dispatched[1]?.sequence).toBeGreaterThan(turns[1]?.sequence ?? 0);
		const seen = rows(browser, sessionId);
		const wakeEnds = ledger.ends.filter(
			(end) => !ledger.runs.some((run) => run.id === end.runId),
		);
		proof[name] = {
			sessionId,
			turns,
			ends: ledger.ends,
			wakeEnds,
			rows: seen.map((row) => ({
				wakeRun: row["wakeRun"] ?? null,
				backgroundTasks: row["backgroundTasks"] ?? null,
				processing: row["processing"] ?? null,
				attention: row["attention"] ?? null,
				feed: row["feed"],
				updatedAt: row["updatedAt"] ?? null,
			})),
		};
		// Per feed (the sidebar's shell feed and the session's family feed each send rows in order):
		// the rows before the wake (the user Run listing the shell) never name one, every row while
		// it runs names it the same, and none after.
		for (const feed of ["shell", "family"]) {
			const fed = seen.filter((row) => row["feed"] === feed);
			const woken = fed.flatMap((row, index) =>
				row["wakeRun"] === undefined ? [] : [index],
			);
			const first = woken[0] ?? -1;
			const last = woken.at(-1) ?? -1;
			expect(woken.length, feed).toBeGreaterThan(0);
			expect(last - first + 1, feed).toBe(woken.length);
			expect(
				fed
					.slice(0, first)
					.some((row) => Array.isArray(row["backgroundTasks"])),
				feed,
			).toBe(true);
			for (const index of woken)
				expect(fed[index]?.["wakeRun"], feed).toEqual({ task: "sleep 8" });
			expect(fed.length, feed).toBeGreaterThan(last + 1);
		}
		return wakeEnds;
	};

	it("names the waking task while the wake runs, and queues a send behind it", async () => {
		const held = await wakeHeld("Claude wake completes");
		rmSync(held.hold);
		const wakeEnds = await settled(
			"names the waking task while the wake runs, and queues a send behind it",
			held,
		);
		expect(wakeEnds).toEqual([
			expect.objectContaining({ reason: "completed" }),
		]);
	});

	it("ends a woken Run at Stop, interrupted, and clears its name from the row", async () => {
		const held = await wakeHeld("Claude wake stopped");
		await held.fixture.requestRpc({
			_tag: "CancelSession",
			sessionId: held.sessionId,
			commandId: randomUUID(),
		});
		const wakeEnds = await settled(
			"ends a woken Run at Stop, interrupted, and clears its name from the row",
			held,
		);
		expect(wakeEnds).toEqual([
			expect.objectContaining({ reason: "interrupted", forced: 0 }),
		]);
	});
});
