// Admission for head moves, fork and provider switch (82tn.49), over the isolated process harness and
// the fake Claude SDK. How it could fail (lane 49 audit):
// 1, 8, 9. a rewind or an undo during a Run is accepted, or refused with no reason the page can show;
// (3, a prompt open with no Run, is not reachable on Claude here: the turn's end closes it. The
// admission unit test covers it.)
// 18, 19. a fork during a Run is refused, or a switch during a Run is accepted;
// 10, 17, 21. a second move, a fork or a switch while a move is in progress is accepted;
// 11, 12. a send during a move is handed off before the move lands, or never after it;
// 16. a browser that reconnects mid move loses the send, or its resubmit sends it twice;
// 15. a daemon that dies mid move leaves the send queued forever, or sends it before the move lands.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const MOVE_DELAY_MS = 4_000;

/** The session's head-move journal, landings and sends, in store order. */
const journal = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, type, json_extract(data, '$.inputId') AS inputId FROM events WHERE session_id = ? AND type IN ('head.move_started', 'head.moved', 'input.admitted', 'input.sent') ORDER BY sequence",
			)
			.all(sessionId) as {
			sequence: number;
			type: string;
			inputId: string | null;
		}[];
	} finally {
		db.close();
	}
};

const openPrompts = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT count(*) AS n FROM pending_approvals WHERE session_id = ? AND status = 'pending'",
				)
				.get(sessionId) as { n: number }
		).n;
	} finally {
		db.close();
	}
};

/** The fake SDK's prompt intakes for one text, from its proof file: it outlives a daemon restart. */
const enqueued = (harness: ProcessHarness, text: string) => {
	const proof = join(harness.root, "sdk-proof.ndjson");
	return existsSync(proof)
		? readFileSync(proof, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
				.filter((mark) => mark.kind === "enqueue" && mark.request === text)
		: [];
};

/** Adds two Claude accounts with their own login folders. */
const addAccounts = async (harness: ProcessHarness) => {
	const ids: string[] = [];
	for (const name of ["A", "B"]) {
		const configDir = join(harness.root, name);
		mkdirSync(configDir, { recursive: true });
		const { addedInstanceId } = await harness.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "claude",
			configDir,
		});
		if (!addedInstanceId) throw new Error("Missing fixture account");
		ids.push(addedInstanceId);
	}
	const [a, b] = ids;
	if (!a || !b) throw new Error("Missing fixture accounts");
	return { a, b };
};

/** The typed refusal a command failed with, as the page receives it. */
const refusal = async <A, E extends { readonly message: string }>(
	effect: Effect.Effect<A, E>,
) => {
	const error = await Effect.runPromise(Effect.flip(effect));
	return {
		...(error as unknown as {
			_tag: string;
			command?: string;
			reason?: string;
		}),
		message: error.message,
	};
};

const userMessage = async (
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
) => {
	const found = (await browser.history(sessionId)).find(
		(message) =>
			message.role === "user" &&
			(message.parts ?? []).some((part) => part.text === text),
	);
	if (!found) throw new Error(`Missing user message ${text}`);
	return found;
};

describe("a head move, a fork and a provider switch are admitted from the Run Ledger", () => {
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
				"test-results/82tn-49-admission.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	const start = async (moveDelayMs?: number) => {
		const fixture = ProcessHarness.create({
			restartProof: true,
			logLevel: "warn",
			serverLogFile: join("test-results", "82tn-49-daemon.log"),
		});
		harness = fixture;
		await fixture.restart(
			moveDelayMs === undefined
				? {}
				: {
						serviceEnvironment: {
							CONDUIT_TEST_HEAD_MOVE_DELAY_MS: String(moveDelayMs),
						},
					},
		);
		const browser = await fixture.connect();
		await browser.followSessions();
		const accounts = await addAccounts(fixture);
		const sessionId = await browser.createSession("Admission", accounts.a);
		await browser.followSession(sessionId);
		return { fixture, browser, accounts, sessionId };
	};

	// 1, 8, 9, 18, 19.
	it("refuses a rewind, an undo and a switch with a typed reason during a Run, admits a fork, and lands both moves once idle", async () => {
		const { fixture, browser, accounts, sessionId } = await start();
		await browser.send(sessionId, "admission-first");
		const target = await userMessage(browser, sessionId, "admission-first");

		const held = browser.send(sessionId, "approval-admission");
		void held.catch(() => undefined);
		// test-waits-allow polling: the open permission is a store row, not a frame this test follows.
		await vi.waitFor(() => expect(openPrompts(fixture, sessionId)).toBe(1), {
			timeout: 10_000,
		});
		const duringRun = {
			rewind: await refusal(
				browser.rpc.RewindSession({ sessionId, messageId: target.id }),
			),
			undo: await refusal(browser.rpc.UndoRewind({ sessionId })),
			switch: await refusal(
				browser.rpc.ContinueSession({
					sessionId,
					instanceId: accounts.b,
					expectedInstanceId: accounts.a,
				}),
			),
		};
		proof["during a Run"] = duringRun;
		expect(duringRun).toEqual({
			rewind: {
				_tag: "SessionBusy",
				sessionId,
				command: "head_move",
				reason: "run_active",
				message: "Stop the current turn first.",
			},
			undo: {
				_tag: "SessionBusy",
				sessionId,
				command: "head_move",
				reason: "run_active",
				message: "Stop the current turn first.",
			},
			switch: {
				_tag: "SessionBusy",
				sessionId,
				command: "provider_switch",
				reason: "run_active",
				message: "Stop the current turn first.",
			},
		});
		const fork = await Effect.runPromise(
			browser.rpc.ForkSession({ sessionId, originId: browser.originId }),
		);
		proof["fork during a Run"] = fork;
		expect(fork.forkedFrom).toBe(sessionId);
		expect(journal(fixture, sessionId).map(({ type }) => type)).not.toContain(
			"head.move_started",
		);

		const stoppedFrom = browser.frames.length;
		await Effect.runPromise(
			browser.rpc.CancelSession({ sessionId, commandId: crypto.randomUUID() }),
		);
		await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "idle",
			stoppedFrom,
		);
		await Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: target.id }),
		);
		await Effect.runPromise(browser.rpc.UndoRewind({ sessionId }));
		const moves = journal(fixture, sessionId)
			.map(({ type }) => type)
			.filter(
				(type) => type.startsWith("head.") || type.startsWith("session."),
			);
		proof["idle moves"] = moves;
		// 82tn.51: a rewind and its undo are head moves alone; no pending-rewind event rides along.
		expect(moves).toEqual([
			"head.move_started",
			"head.moved",
			"head.move_started",
			"head.moved",
		]);
	});

	// 10, 11, 12, 16, 17, 21.
	it("queues a send behind a rewind in progress, refuses a second move, a fork and a switch, and sends it once after the move lands", async () => {
		const { fixture, browser, accounts, sessionId } =
			await start(MOVE_DELAY_MS);
		await browser.send(sessionId, "admission-kept");
		await browser.send(sessionId, "admission-cut");
		const target = await userMessage(browser, sessionId, "admission-cut");

		const moving = Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: target.id }),
		);
		// test-waits-allow polling: the move's start is a store event, not a frame this test follows.
		await vi.waitFor(() =>
			expect(journal(fixture, sessionId).map(({ type }) => type)).toContain(
				"head.move_started",
			),
		);
		const inputId = crypto.randomUUID();
		const text = "admission-during-move";
		const submit = (tab: ProcessBrowser) =>
			Effect.runPromise(
				tab.rpc["input.submit"]({
					sessionId,
					originId: tab.originId,
					inputId,
					delivery: "queue",
					text,
				}),
			);
		const submitted = await submit(browser);
		const duringMove = {
			rewind: await refusal(
				browser.rpc.RewindSession({ sessionId, messageId: target.id }),
			),
			undo: await refusal(browser.rpc.UndoRewind({ sessionId })),
			fork: await refusal(
				browser.rpc.ForkSession({ sessionId, originId: browser.originId }),
			),
			switch: await refusal(
				browser.rpc.ContinueSession({
					sessionId,
					instanceId: accounts.b,
					expectedInstanceId: accounts.a,
				}),
			),
		};
		// A browser reconnecting mid move resubmits the same input.
		const reconnected = await fixture.connect(sessionId);
		const resubmitted = await submit(reconnected);
		const beforeLanding = journal(fixture, sessionId);
		proof["during a move"] = {
			submitted,
			resubmitted,
			refusals: duringMove,
			journal: beforeLanding,
		};
		for (const [command, refused] of Object.entries(duringMove))
			expect(refused, command).toMatchObject({
				_tag: "SessionBusy",
				reason: "head_move_in_progress",
			});
		expect(beforeLanding.map(({ type }) => type)).not.toContain("head.moved");
		expect(
			beforeLanding.filter(
				(event) => event.type === "input.sent" && event.inputId === inputId,
			),
		).toEqual([]);
		expect(enqueued(fixture, text)).toEqual([]);

		await moving;
		proof["landed"] = journal(fixture, sessionId);
		// test-waits-allow polling: the fake SDK reports its sends only through its marks.
		await vi.waitFor(() => expect(enqueued(fixture, text)).toHaveLength(1), {
			timeout: 15_000,
		});
		const after = journal(fixture, sessionId);
		proof["after the move"] = { journal: after, sent: enqueued(fixture, text) };
		const moved = after.find(({ type }) => type === "head.moved");
		const sent = after.filter(
			(event) => event.type === "input.sent" && event.inputId === inputId,
		);
		// 82tn.51: the rewind is one head move, with no pending-rewind event.
		expect(
			after.filter(({ type }) => type === "head.move_started"),
		).toHaveLength(1);
		expect(
			after.filter(
				(event) => event.type === "input.admitted" && event.inputId === inputId,
			),
		).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.sequence).toBeGreaterThan(moved?.sequence ?? Infinity);
		await reconnected.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "idle",
		);
		const seen = (await reconnected.history(sessionId)).map((message) =>
			(message.parts ?? []).map((part) => part.text ?? "").join(""),
		);
		expect(seen).toContain(text);
		expect(seen).not.toContain("admission-cut");
		expect(enqueued(fixture, text)).toHaveLength(1);
	});

	// 15.
	it("lands a move a dead daemon left in progress on restart, then sends the send queued behind it once", async () => {
		const { fixture, browser, sessionId } = await start(60_000);
		await browser.send(sessionId, "admission-kept");
		await browser.send(sessionId, "admission-cut");
		const target = await userMessage(browser, sessionId, "admission-cut");
		void Effect.runPromise(
			browser.rpc.RewindSession({ sessionId, messageId: target.id }),
		).catch(() => undefined);
		// test-waits-allow polling: the move's start is a store event, not a frame this test follows.
		await vi.waitFor(() =>
			expect(journal(fixture, sessionId).map(({ type }) => type)).toContain(
				"head.move_started",
			),
		);
		const inputId = crypto.randomUUID();
		const text = "admission-across-restart";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text,
			}),
		);
		const dangling = journal(fixture, sessionId);
		await fixture.kill();
		await fixture.restart();
		// test-waits-allow polling: the fake SDK reports its sends only through its marks.
		await vi
			.waitFor(() => expect(enqueued(fixture, text)).toHaveLength(1), {
				timeout: 20_000,
			})
			.finally(() => {
				proof["restarted"] = journal(fixture, sessionId);
			});
		const after = journal(fixture, sessionId);
		proof["restart mid move"] = {
			dangling,
			journal: after,
			sent: enqueued(fixture, text),
		};
		expect(dangling.map(({ type }) => type)).not.toContain("head.moved");
		const moved = after.filter(({ type }) => type === "head.moved");
		const sent = after.filter(
			(event) => event.type === "input.sent" && event.inputId === inputId,
		);
		expect(moved).toHaveLength(1);
		// 82tn.51: restart lands the one move it started; no pending-rewind event rides along.
		expect(
			after.filter(({ type }) => type === "head.move_started"),
		).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.sequence).toBeGreaterThan(moved[0]?.sequence ?? Infinity);
	});
});
