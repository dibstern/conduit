// The destructive confirm (82tn.32.25; CONTRACT.md 8.4 2870-2890, row 213), over the isolated process
// harness and the fake Claude SDK's held task-stop turn, made deaf so Stop's interrupt is ignored.
// How it could fail (lane 3225 audit):
// 1, 2. past the Stop deadline with tasks live, U2 closes the process anyway;
// 3. past the deadline U2 never retires, even after a confirm;
// 4. with no tasks, the deadline waits for a confirm;
// 5, 6, 7. a confirm copied before a newer snapshot is accepted, or rejected without a fresh ask;
// 8. a task ending on its own while asked leaves U2 waiting;
// 9. Stop pressed twice while asked opens a second wait or clears the ask;
// 18. a confirm with nothing asked changes state;
// 16. a task that starts after the Stop (no gate at the Stop) is closed, or held with no ask;
// 19. the list shown and the snapshot entry come from different reads;
// 13, 14. a confirmed close leaves no timeline entry, or a close with no tasks leaves one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskStopFixture } from "../../helpers/fake-claude-process-sdk.js";
import {
	type ProcessBrowser as BrowserClient,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const deaf = "task-stop-foreground-deaf";
const allIds = taskStopFixture.map((task) => task.task_id).sort();
/** Short enough to wait through, long enough for the interrupt to be delivered first. */
const STOP_WAIT_MS = 3_000;

const marks = (harness: ProcessHarness): Record<string, unknown>[] => {
	const file = join(harness.root, "sdk-proof.ndjson");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
};
const closedQueries = (harness: ProcessHarness, queryId: string) =>
	marks(harness).filter(
		(mark) => mark["queryId"] === queryId && mark["kind"] === "query-closed",
	);

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT type, json_extract(data, '$.snapshotEntry') AS snapshotEntry, json_extract(data, '$.retireRunIds') AS retire FROM events WHERE session_id = ? AND type IN ('escalation.confirmed', 'interrupt.requested', 'session.end_requested') ORDER BY sequence",
			)
			.all(sessionId) as {
			type: string;
			snapshotEntry: number | null;
			retire: string | null;
		}[];
	} finally {
		db.close();
	}
};

const lostNotices = async (browser: BrowserClient, sessionId: string) =>
	(await browser.history(sessionId)).flatMap((message) =>
		(message.parts ?? []).flatMap((part) =>
			part.type === "notice" && part.text?.startsWith("Background work")
				? [part.text]
				: [],
		),
	);

type StopConfirm = {
	readonly snapshotEntry: number;
	readonly tasks?: readonly { readonly id: string }[];
};
const confirmOf = (message: Record<string, unknown>) =>
	message["stopConfirm"] as StopConfirm | undefined;

/** The sidebar's row for the session, from `cursor` on, matching `predicate`. */
const row = (
	browser: BrowserClient,
	sessionId: string,
	cursor: number,
	predicate: (message: Record<string, unknown>) => boolean,
) =>
	browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			"workspaceHint" in message &&
			predicate(message),
		cursor,
	);

/** The deaf held turn, once its four tasks show on the session row. */
const startTurn = async (harness: ProcessHarness, browser: BrowserClient) => {
	const sessionId = await browser.createSession("Destructive confirm");
	await browser.followSession(sessionId);
	const turn = browser.send(sessionId, deaf);
	void turn.catch(() => undefined);
	await browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			Array.isArray(message["backgroundTasks"]) &&
			message["backgroundTasks"].length === taskStopFixture.length,
	);
	// test-waits-allow polling: the fake SDK reports its held turn only through sdk-proof.ndjson.
	const held = await vi.waitFor(() => {
		const mark = marks(harness).find(
			(mark) =>
				mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
		);
		expect(typeof mark?.["queryId"]).toBe("string");
		return mark;
	});
	return { sessionId, queryId: String(held?.["queryId"]) };
};

const stop = (browser: BrowserClient, sessionId: string) => {
	const stopped = Effect.runPromise(
		browser.rpc.CancelSession({ sessionId, commandId: crypto.randomUUID() }),
	);
	void stopped.catch(() => undefined);
	return stopped;
};

describe("a stuck Stop asks before it ends background tasks", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-25-destructive-confirm.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	const start = async () => {
		const fixture = ProcessHarness.create({ restartProof: true });
		harness = fixture;
		await fixture.restart({
			serviceEnvironment: {
				CONDUIT_TEST_STOP_ABORT_WAIT_MS: String(STOP_WAIT_MS),
			},
		});
		const browser = await fixture.connect();
		await browser.followSessions();
		return { fixture, browser };
	};

	it("waits past the deadline with live tasks, rejects a stale confirm and asks again, then closes on a current one", async () => {
		const { fixture, browser } = await start();
		const { sessionId, queryId } = await startTurn(fixture, browser);

		// A confirm with nothing asked is refused and records nothing.
		const unasked = await Effect.runPromise(
			Effect.flip(
				browser.rpc.ConfirmEscalation({ sessionId, snapshotEntry: 1 }),
			),
		);
		proof["nothing asked"] = { message: unasked.message };
		expect(unasked.message).toBe("Nothing is waiting for a confirm");

		const cursor = browser.frames.length;
		const stopped = stop(browser, sessionId);
		// Stop pressed twice joins the same wait.
		const again = stop(browser, sessionId);
		const asked = await row(browser, sessionId, cursor, (message) =>
			Boolean(confirmOf(message)),
		);
		const first = confirmOf(asked);
		proof["asked"] = first;
		expect(first?.tasks?.map((task) => task.id).sort()).toEqual(allIds);
		// test-waits-allow real-wait: nothing destroying is an absence past the deadline.
		await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS));
		expect(closedQueries(fixture, queryId)).toEqual([]);
		expect(
			read(fixture, sessionId).filter((event) => event.retire !== null),
		).toEqual([]);

		// A snapshot lands between the ask and the confirm: the shell's stop drops it.
		const [shell] = taskStopFixture;
		await Effect.runPromise(
			browser.rpc.StopTasks({ sessionId, tasks: [shell.task_id] }),
		);
		const refreshedFrom = browser.frames.length;
		writeFileSync(join(fixture.root, "task-stop-confirm-all"), "release");
		const reasked = confirmOf(
			await row(browser, sessionId, refreshedFrom, (message) => {
				const confirm = confirmOf(message);
				return confirm !== undefined && confirm.tasks?.length === 3;
			}),
		);
		proof["asked again"] = reasked;
		expect(reasked?.snapshotEntry).toBeGreaterThan(first?.snapshotEntry ?? 0);

		const stale = await Effect.runPromise(
			Effect.flip(
				browser.rpc.ConfirmEscalation({
					sessionId,
					snapshotEntry: first?.snapshotEntry ?? 0,
				}),
			),
		);
		proof["stale confirm"] = { message: stale.message };
		expect(stale.message).toBe(
			"The background tasks changed; check the list and confirm again",
		);
		expect(closedQueries(fixture, queryId)).toEqual([]);

		// The fake SDK repeats its snapshot, and any newer one makes a confirm stale (D45), so confirm
		// what the newest ask shows and, like the UI, ask again on a stale answer.
		const answers: string[] = [];
		// test-waits-allow polling: each try reads the newest ask the browser has.
		const confirmedEntry = await vi.waitFor(
			async () => {
				const newest = browser.frames
					.slice(refreshedFrom)
					.map(({ message }) =>
						message["type"] === "session_row" && message["id"] === sessionId
							? confirmOf(message)
							: undefined,
					)
					.filter((confirm) => confirm !== undefined)
					.at(-1);
				const entry = newest?.snapshotEntry ?? 0;
				const answer = await Effect.runPromise(
					Effect.result(
						browser.rpc.ConfirmEscalation({ sessionId, snapshotEntry: entry }),
					),
				);
				answers.push(
					answer._tag === "Success" ? `ok ${entry}` : answer.failure.message,
				);
				expect(answer._tag).toBe("Success");
				return entry;
			},
			{ timeout: 10_000, interval: 200 },
		);
		proof["confirm answers"] = answers;
		expect(confirmedEntry).toBeGreaterThanOrEqual(reasked?.snapshotEntry ?? 0);
		await stopped;
		await again;
		// test-waits-allow polling: the fake SDK reports a closed query only through sdk-proof.ndjson.
		await vi.waitFor(() =>
			expect(closedQueries(fixture, queryId)).toHaveLength(1),
		);
		const events = read(fixture, sessionId);
		proof["confirmed"] = events;
		expect(
			events.filter((event) => event.type === "escalation.confirmed"),
		).toEqual([expect.objectContaining({ snapshotEntry: confirmedEntry })]);
		expect(events.filter((event) => event.retire !== null)).toHaveLength(1);
		const cleared = await row(
			browser,
			sessionId,
			cursor,
			(message) =>
				message["stopConfirm"] === undefined && message["status"] === "idle",
		);
		expect(confirmOf(cleared)).toBeUndefined();
		// 8.4 L5: the tasks the confirm ended are a timeline entry.
		// test-waits-allow polling: the notice is read back as history, which has no push to wait on.
		const lost = await vi.waitFor(async () => {
			const found = await lostNotices(browser, sessionId);
			expect(found).toHaveLength(1);
			return found;
		});
		proof["confirmed: lost work"] = lost;
		expect(lost[0]).toMatch(/^Background work ended: .*\(shell\)/);
	});

	it("closes on its own when the tasks end while asked", async () => {
		const { fixture, browser } = await start();
		const { sessionId, queryId } = await startTurn(fixture, browser);
		const cursor = browser.frames.length;
		const stopped = stop(browser, sessionId);
		await row(browser, sessionId, cursor, (message) =>
			Boolean(confirmOf(message)),
		);
		expect(closedQueries(fixture, queryId)).toEqual([]);

		await Effect.runPromise(browser.rpc.StopTasks({ sessionId, tasks: "all" }));
		writeFileSync(join(fixture.root, "task-stop-confirm-all"), "release");
		await stopped;
		// test-waits-allow polling: the fake SDK reports a closed query only through sdk-proof.ndjson.
		await vi.waitFor(() =>
			expect(closedQueries(fixture, queryId)).toHaveLength(1),
		);
		const events = read(fixture, sessionId);
		proof["tasks ended while asked"] = events;
		expect(
			events.filter((event) => event.type === "escalation.confirmed"),
		).toEqual([]);
	});

	it("closes at the deadline without asking when there are no tasks", async () => {
		const { fixture, browser } = await start();
		const { sessionId, queryId } = await startTurn(fixture, browser);
		const cursor = browser.frames.length;
		await Effect.runPromise(browser.rpc.StopTasks({ sessionId, tasks: "all" }));
		writeFileSync(join(fixture.root, "task-stop-confirm-all"), "release");
		await row(
			browser,
			sessionId,
			cursor,
			(message) => message["backgroundTasks"] === undefined,
		);

		const askedFrom = browser.frames.length;
		const startedAt = Date.now();
		await stop(browser, sessionId);
		// test-waits-allow polling: the fake SDK reports a closed query only through sdk-proof.ndjson.
		await vi.waitFor(() =>
			expect(closedQueries(fixture, queryId)).toHaveLength(1),
		);
		proof["no tasks"] = {
			elapsedMs: Date.now() - startedAt,
			events: read(fixture, sessionId),
		};
		expect(
			browser.frames
				.slice(askedFrom)
				.some(
					({ message }) =>
						message["type"] === "session_row" &&
						message["id"] === sessionId &&
						message["stopConfirm"] !== undefined,
				),
		).toBe(false);
		// 8.4 L5 (r2-2): no tasks, no lost-work entry, once the next process has started.
		await browser.send(sessionId, "after the close");
		const lost = await lostNotices(browser, sessionId);
		proof["no tasks: lost work"] = lost;
		expect(lost).toEqual([]);
	});

	it("asks when a task starts after the Stop", async () => {
		const { fixture, browser } = await start();
		const { sessionId, queryId } = await startTurn(fixture, browser);
		const cursor = browser.frames.length;
		await Effect.runPromise(browser.rpc.StopTasks({ sessionId, tasks: "all" }));
		writeFileSync(join(fixture.root, "task-stop-confirm-all"), "release");
		await row(
			browser,
			sessionId,
			cursor,
			(message) => message["backgroundTasks"] === undefined,
		);
		const stopped = stop(browser, sessionId);
		// test-waits-allow real-wait: the Stop must be committed with no tasks before one starts.
		await new Promise((resolve) => setTimeout(resolve, 500));
		const askedFrom = browser.frames.length;
		writeFileSync(join(fixture.root, "task-stop-late-task"), "start");
		const asked = confirmOf(
			await row(browser, sessionId, askedFrom, (message) =>
				Boolean(confirmOf(message)),
			),
		);
		proof["late task asked"] = asked;
		expect(asked?.tasks?.map((task) => task.id)).toEqual(["task-stop-monitor"]);
		// test-waits-allow real-wait: nothing destroying is an absence past the deadline.
		await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS));
		expect(closedQueries(fixture, queryId)).toEqual([]);
		expect(
			await Effect.runPromise(
				browser.rpc.ConfirmEscalation({
					sessionId,
					snapshotEntry: asked?.snapshotEntry ?? 0,
				}),
			),
		).toEqual({ ok: true });
		await stopped;
		// test-waits-allow polling: the fake SDK reports a closed query only through sdk-proof.ndjson.
		await vi.waitFor(() =>
			expect(closedQueries(fixture, queryId)).toHaveLength(1),
		);
	});
});
