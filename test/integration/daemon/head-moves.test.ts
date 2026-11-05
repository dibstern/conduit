// Head moves on the new flow (82tn.51), over the isolated process harness and the fake Claude SDK.
// How it could fail (lane 51 audit, failure catalogue):
// 1. a daemon that dies between a move's start and its landing never lands it, or lands it and
//    never sends its resend;
// 11. a second restart moves the rows again or sends the resend again;
// 2, 4. desktop and phone confirming the same proposal get two moves, two resends, different
//    receipts, or the second is refused as stale.
// 25, 26. an edit or a regenerate overwrites the turn it replaces instead of making a sibling
//    branch, or its reply lands on the old branch;
// 5. an undo pops the entry it undoes, or cannot itself be undone; the next send after a chain of
//    moves tells the provider the wrong cut.
// 6, 7. a switch to another branch brings back other rows than that branch's own, lands mid-branch
//    instead of at its tip, or cannot be undone; a branch whose rows are gone is offered or moved to.
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

/** The session's head moves and admissions, in store order. */
const journal = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, type, json_extract(data, '$.moveId') AS moveId, json_extract(data, '$.inputId') AS inputId FROM events WHERE session_id = ? AND type IN ('head.move_started', 'head.moved', 'session.rewind_committed', 'input.admitted', 'input.sent') ORDER BY sequence",
			)
			.all(sessionId) as {
			sequence: number;
			type: string;
			moveId: string | null;
			inputId: string | null;
		}[];
	} finally {
		db.close();
	}
};

/** The fake SDK's marks, from its proof file: they outlive a daemon restart. */
const sdkMarks = (harness: ProcessHarness) => {
	const proof = join(harness.root, "sdk-proof.ndjson");
	return existsSync(proof)
		? readFileSync(proof, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
		: [];
};

const enqueued = (harness: ProcessHarness, text: string) =>
	sdkMarks(harness).filter(
		(mark) => mark.kind === "enqueue" && mark.request === text,
	);

/** Each native query's thread, and the point it resumed that thread at. */
const resumes = (harness: ProcessHarness) =>
	sdkMarks(harness).flatMap((mark) =>
		mark.kind === "query"
			? [
					{
						thread: mark.sessionId,
						at:
							(JSON.parse(mark.optionsJson) as { resumeSessionAt?: string })
								.resumeSessionAt ?? null,
					},
				]
			: [],
	);

const openSends = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return (
			db
				.prepare(
					"SELECT count(*) AS n FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' AND status IN ('pending', 'running', 'retryable_failed')",
				)
				.get(sessionId) as { n: number }
		).n;
	} finally {
		db.close();
	}
};

/** The session's history graph: every node with its parent, and the Head. */
const graph = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			nodes: db
				.prepare(
					"SELECT id, parent_id AS parent FROM history_nodes WHERE session_id = ? ORDER BY created_at, id",
				)
				.all(sessionId) as { id: string; parent: string | null }[],
			head: (
				db
					.prepare(
						"SELECT node_id AS head FROM history_heads WHERE session_id = ?",
					)
					.get(sessionId) as { head: string | null } | undefined
			)?.head,
			kept: (
				db
					.prepare(
						"SELECT count(*) AS n FROM history_off_head WHERE session_id = ? AND source_table = 'messages'",
					)
					.get(sessionId) as { n: number }
			).n,
		};
	} finally {
		db.close();
	}
};

type MoveIntent = Parameters<
	ProcessBrowser["rpc"]["PreviewHeadMove"]
>[0]["intent"];

/** What a page does: preview the move, then confirm the proposal it was shown. */
const move = async (
	browser: ProcessBrowser,
	sessionId: string,
	intent: MoveIntent,
) => {
	const { moveId } = await Effect.runPromise(
		browser.rpc.PreviewHeadMove({ sessionId, intent }),
	);
	return Effect.runPromise(
		browser.rpc.CommitHeadMove({ sessionId, intent, moveId }),
	);
};

const userTexts = async (browser: ProcessBrowser, sessionId: string) =>
	(await browser.history(sessionId)).flatMap((message) =>
		message.role === "user"
			? [(message.parts ?? []).map((part) => part.text ?? "").join("")]
			: [],
	);

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

const count = (
	events: ReturnType<typeof journal>,
	type: string,
	key?: { moveId?: string; inputId?: string },
) =>
	events.filter(
		(event) =>
			event.type === type &&
			(key?.moveId === undefined || event.moveId === key.moveId) &&
			(key?.inputId === undefined || event.inputId === key.inputId),
	).length;

describe("a head move lands once, with its resend, across devices and crashes", () => {
	let harness: ProcessHarness | undefined;
	let proof: Record<string, unknown> = {};
	let artifact = "";

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof["outcome"] = task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				join("test-results", artifact),
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
			proof = {};
		}
	});

	const start = async (name: string, moveDelayMs: number) => {
		artifact = `82tn-51-${name}.json`;
		const fixture = ProcessHarness.create({
			restartProof: true,
			logLevel: "warn",
			serverLogFile: join("test-results", `82tn-51-${name}-daemon.log`),
		});
		harness = fixture;
		await fixture.restart({
			serviceEnvironment: {
				CONDUIT_TEST_HEAD_MOVE_DELAY_MS: String(moveDelayMs),
			},
		});
		const browser = await fixture.connect();
		await browser.followSessions();
		const configDir = join(fixture.root, "A");
		mkdirSync(configDir, { recursive: true });
		// The fake SDK keeps a native transcript, so a resume at a cut can be checked.
		writeFileSync(join(configDir, "conduit-test-record-forks"), "record");
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "A",
			driver: "claude",
			configDir,
		});
		if (!addedInstanceId) throw new Error("Missing fixture account");
		const sessionId = await browser.createSession("Moves", addedInstanceId);
		await browser.followSession(sessionId);
		for (const prompt of ["moves-kept", "moves-cut"]) {
			await browser.send(sessionId, prompt);
			// test-waits-allow polling: the native cursor publishes when the send command settles.
			await vi.waitFor(() => expect(openSends(fixture, sessionId)).toBe(0));
		}
		const target = await userMessage(browser, sessionId, "moves-cut");
		return { fixture, browser, sessionId, target };
	};

	// 1, 11.
	it("lands an edit-and-resend a dead daemon left started, and sends the new text once, across two restarts", async () => {
		const { fixture, browser, sessionId, target } = await start(
			"crash-roll-forward",
			60_000,
		);
		const intent = {
			_tag: "rewind" as const,
			messageId: target.id,
			resend: "moves-edited",
		};
		const { moveId } = await Effect.runPromise(
			browser.rpc.PreviewHeadMove({ sessionId, intent }),
		);
		void Effect.runPromise(
			browser.rpc.CommitHeadMove({ sessionId, intent, moveId }),
		).catch(() => undefined);
		// test-waits-allow polling: the move's start is a store event, not a frame this test follows.
		await vi.waitFor(() =>
			expect(count(journal(fixture, sessionId), "head.move_started")).toBe(1),
		);
		const dangling = journal(fixture, sessionId);
		await fixture.kill();
		await fixture.restart();
		// test-waits-allow polling: the fake SDK reports its sends only through its marks.
		await vi.waitFor(
			() => expect(enqueued(fixture, "moves-edited")).toHaveLength(1),
			{ timeout: 20_000 },
		);
		const reader = await fixture.connect();
		// test-waits-allow polling: the resend's reply lands after its intake mark.
		await vi.waitFor(
			async () =>
				expect(await userTexts(reader, sessionId)).toEqual([
					"moves-kept",
					"moves-edited",
				]),
			{ timeout: 20_000 },
		);
		const first = journal(fixture, sessionId);
		await fixture.kill();
		await fixture.restart();
		const again = await fixture.connect();
		const texts = await userTexts(again, sessionId);
		// The resend tells Claude to drop the cut: it resumes its own thread at the reply before it.
		const keptReply = (await again.history(sessionId))[1]?.id;
		const queries = resumes(fixture);
		const resumed = queries.at(-1);
		const nativeFile = join(
			fixture.root,
			"A",
			`conduit-test-transcript-${resumed?.thread}.ndjson`,
		);
		const native = (
			existsSync(nativeFile) ? readFileSync(nativeFile, "utf8") : ""
		)
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as { uuid?: string; message?: { id?: string } },
			);
		const resumedAt = native.find(({ uuid }) => uuid === resumed?.at)?.message
			?.id;
		const second = journal(fixture, sessionId);
		const log = await Effect.runPromise(again.rpc.GetHeadLog({ sessionId }));
		proof = {
			moveId,
			dangling,
			afterRestart: first,
			afterSecondRestart: second,
			transcript: texts,
			sent: enqueued(fixture, "moves-edited"),
			headLog: log.entries,
			keptReply,
			queries,
			resumedAt,
		};
		expect(count(dangling, "head.moved")).toBe(0);
		expect(second).toEqual(first);
		expect(count(second, "head.moved", { moveId })).toBe(1);
		expect(
			count(second, "input.admitted", { inputId: `resend:${moveId}` }),
		).toBe(1);
		expect(enqueued(fixture, "moves-edited")).toHaveLength(1);
		expect(texts).toEqual(["moves-kept", "moves-edited"]);
		expect(resumed?.thread).toBe(queries[0]?.thread);
		expect(resumedAt).toBe(keptReply);
		expect(log.entries.map((entry) => [entry.moveId, entry.landed])).toEqual([
			[moveId, true],
		]);
	});

	// 2, 4.
	it("gives desktop and phone confirming the same proposal one move, one resend and the same receipt", async () => {
		const { fixture, browser, sessionId, target } = await start(
			"two-devices",
			2_000,
		);
		const phone = await fixture.connect();
		await phone.followSession(sessionId);
		const intent = {
			_tag: "rewind" as const,
			messageId: target.id,
			resend: "moves-from-both",
		};
		const [desktopProposal, phoneProposal] = await Promise.all(
			[browser, phone].map((device) =>
				Effect.runPromise(device.rpc.PreviewHeadMove({ sessionId, intent })),
			),
		);
		const receipts = await Promise.all(
			[browser, phone].map((device) =>
				Effect.runPromise(
					device.rpc.CommitHeadMove({
						sessionId,
						intent,
						moveId: desktopProposal?.moveId ?? "",
					}),
				),
			),
		);
		// test-waits-allow polling: the fake SDK reports its sends only through its marks.
		await vi.waitFor(
			() => expect(enqueued(fixture, "moves-from-both")).toHaveLength(1),
			{ timeout: 20_000 },
		);
		// test-waits-allow polling: the resend's reply lands after its intake mark.
		await vi.waitFor(
			async () =>
				expect(await userTexts(phone, sessionId)).toEqual([
					"moves-kept",
					"moves-from-both",
				]),
			{ timeout: 20_000 },
		);
		const events = journal(fixture, sessionId);
		const moveId = desktopProposal?.moveId ?? "";
		const late = await Effect.runPromise(
			phone.rpc.CommitHeadMove({ sessionId, intent, moveId }),
		);
		proof = {
			proposals: [desktopProposal, phoneProposal],
			receipts,
			lateReceipt: late,
			journal: events,
			afterLateRetry: journal(fixture, sessionId),
			sent: enqueued(fixture, "moves-from-both"),
			queries: resumes(fixture),
			transcript: await userTexts(browser, sessionId),
		};
		expect(phoneProposal).toEqual(desktopProposal);
		expect(receipts).toEqual([{ moveId }, { moveId }]);
		expect(late).toEqual({ moveId });
		expect(count(events, "head.move_started")).toBe(1);
		expect(count(events, "head.moved", { moveId })).toBe(1);
		expect(
			count(events, "input.admitted", { inputId: `resend:${moveId}` }),
		).toBe(1);
		expect(journal(fixture, sessionId)).toEqual(events);
		expect(enqueued(fixture, "moves-from-both")).toHaveLength(1);
		// One realignment: the resend resumes Claude's own thread at a cut.
		const [opened, resumed, ...more] = resumes(fixture);
		expect(more).toEqual([]);
		expect(resumed?.thread).toBe(opened?.thread);
		expect(resumed?.at).not.toBeNull();
	});

	// 5.
	it("undoes a rewind from the Head Log, undoes that undo, and keeps every entry", async () => {
		const { browser, sessionId, target, fixture } = await start(
			"undo-chain",
			0,
		);
		const ids = async () =>
			(await browser.history(sessionId)).map(({ id }) => id);
		const whole = await ids();
		const log = async () =>
			(await Effect.runPromise(browser.rpc.GetHeadLog({ sessionId }))).entries;
		const rewind = await move(browser, sessionId, {
			_tag: "rewind",
			messageId: target.id,
		});
		const rewound = await ids();
		const undo = await move(browser, sessionId, {
			_tag: "undo",
			moveId: rewind.moveId,
		});
		const undone = await ids();
		const redo = await move(browser, sessionId, {
			_tag: "undo",
			moveId: undo.moveId,
		});
		const redone = await ids();
		const entries = await log();
		await browser.send(sessionId, "moves-after-chain");
		proof = {
			whole,
			rewound,
			undone,
			redone,
			entries,
			afterSend: await userTexts(browser, sessionId),
			journal: journal(fixture, sessionId),
			queries: resumes(fixture),
		};
		expect(rewound).toEqual(whole.slice(0, 2));
		expect(undone).toEqual(whole);
		expect(redone).toEqual(rewound);
		expect(
			entries.map(({ moveId, kind, undoes, landed }) => ({
				moveId,
				kind,
				undoes,
				landed,
			})),
		).toEqual([
			{ moveId: redo.moveId, kind: "undo", undoes: undo.moveId, landed: true },
			{
				moveId: undo.moveId,
				kind: "undo",
				undoes: rewind.moveId,
				landed: true,
			},
			{
				moveId: rewind.moveId,
				kind: "rewind",
				undoes: undefined,
				landed: true,
			},
		]);
		expect(await userTexts(browser, sessionId)).toEqual([
			"moves-kept",
			"moves-after-chain",
		]);
		// The three moves reach Claude as one cut: it resumes its own thread before the cut.
		const [opened, resumed, ...more] = resumes(fixture);
		expect(more).toEqual([]);
		expect(resumed?.thread).toBe(opened?.thread);
		expect(resumed?.at).not.toBeNull();
	});

	// 25, 26.
	it("regenerates a reply and edits a message, each as a sibling branch of the same point", async () => {
		const { browser, sessionId, target, fixture } = await start("siblings", 0);
		const before = graph(fixture, sessionId);
		// Regenerate: back to before the message, the same text again.
		const regenerate = await move(browser, sessionId, {
			_tag: "rewind",
			messageId: target.id,
			resend: "moves-cut",
		});
		// test-waits-allow polling: the resend's reply lands after the move's receipt.
		await vi.waitFor(
			async () =>
				expect(
					(await browser.history(sessionId)).map(({ role }) => role),
				).toEqual(["user", "assistant", "user", "assistant"]),
			{ timeout: 20_000 },
		);
		// test-waits-allow polling: the Run's node is sealed when its send settles.
		await vi.waitFor(() =>
			expect(graph(fixture, sessionId).nodes).toHaveLength(3),
		);
		const regenerated = await browser.history(sessionId);
		const again = regenerated[2];
		if (!again) throw new Error("Missing regenerated message");
		const edit = await move(browser, sessionId, {
			_tag: "rewind",
			messageId: again.id,
			resend: "moves-edited-sibling",
		});
		// test-waits-allow polling: the resend's reply lands after the move's receipt.
		await vi.waitFor(
			async () =>
				expect(await userTexts(browser, sessionId)).toEqual([
					"moves-kept",
					"moves-edited-sibling",
				]),
			{ timeout: 20_000 },
		);
		// test-waits-allow polling: the Run's node is sealed when its send settles.
		await vi.waitFor(() =>
			expect(graph(fixture, sessionId).nodes).toHaveLength(4),
		);
		const after = graph(fixture, sessionId);
		const [root] = before.nodes;
		proof = {
			before,
			after,
			regenerate,
			edit,
			regenerated: regenerated.map(({ id, role }) => ({ id, role })),
			journal: journal(fixture, sessionId),
		};
		expect(before.nodes).toHaveLength(2);
		expect(enqueued(fixture, "moves-cut")).toHaveLength(2);
		expect(regenerated[2]?.id).not.toBe(target.id);
		// Three siblings under the first turn: the original, the regenerate and the edit.
		const siblings = after.nodes.filter(({ parent }) => parent === root?.id);
		expect(siblings).toHaveLength(3);
		expect(after.head).toBe(siblings.at(-1)?.id);
		// The two branches left behind keep their user message and reply each.
		expect(after.kept).toBe(4);
	});

	// 6, 7.
	it("switches back to a branch at its tip, undoes the switch, and refuses a branch whose rows are gone", async () => {
		const { browser, sessionId, target, fixture } = await start(
			"branch-switch",
			0,
		);
		const ids = async () =>
			(await browser.history(sessionId)).map(({ id }) => id);
		const branches = async (reader: ProcessBrowser) =>
			(await Effect.runPromise(reader.rpc.GetHeadBranches({ sessionId })))
				.forks;
		/** Waits for a send's reply and for its Run's node, sealed when the send settles. */
		const settled = async (messages: number, nodes: number) => {
			// test-waits-allow polling: the reply lands after the send's receipt.
			await vi.waitFor(
				async () =>
					expect(await browser.history(sessionId)).toHaveLength(messages),
				{ timeout: 20_000 },
			);
			// test-waits-allow polling: the Run's node is sealed when its send settles.
			await vi.waitFor(() =>
				expect(graph(fixture, sessionId).nodes).toHaveLength(nodes),
			);
		};
		const original = await ids();
		await move(browser, sessionId, {
			_tag: "rewind",
			messageId: target.id,
			resend: "moves-branch-b",
		});
		await settled(4, 3);
		const edited = await ids();
		const [, cut, branchB] = graph(fixture, sessionId).nodes;
		if (!cut || !branchB) throw new Error("Missing branch nodes");
		const offered = await branches(browser);
		// Back to the cut branch, then one more turn on it.
		await move(browser, sessionId, { _tag: "switch", nodeId: cut.id });
		const back = await ids();
		await browser.send(sessionId, "moves-cut-more");
		await settled(6, 4);
		const deeper = await ids();
		const cutTip = graph(fixture, sessionId).nodes[3];
		if (!cutTip) throw new Error("Missing cut branch tip");
		await move(browser, sessionId, { _tag: "switch", nodeId: branchB.id });
		const onB = await ids();
		// The page offers the cut branch at its tip, so a switch returns to where it was left.
		const offeredOnB = await branches(browser);
		const tip = offeredOnB[0]?.branches[0]?.tip ?? "";
		const switched = await move(browser, sessionId, {
			_tag: "switch",
			nodeId: tip,
		});
		const atTip = await ids();
		const [entry] = (
			await Effect.runPromise(browser.rpc.GetHeadLog({ sessionId }))
		).entries;
		await move(browser, sessionId, { _tag: "undo", moveId: switched.moveId });
		const undone = await ids();
		// The cut branch's rows are lost while the daemon is down.
		await fixture.kill();
		const db = new Database(fixture.daemonStorePath());
		db.prepare(
			"UPDATE history_nodes SET available = 0 WHERE session_id = ? AND id = ?",
		).run(sessionId, cut.id);
		db.close();
		await fixture.restart();
		const reader = await fixture.connect();
		const offeredLost = await branches(reader);
		const refused = await Effect.runPromise(
			Effect.flip(
				reader.rpc.PreviewHeadMove({
					sessionId,
					intent: { _tag: "switch", nodeId: tip },
				}),
			),
		);
		proof = {
			original,
			edited,
			offered,
			back,
			deeper,
			onB,
			offeredOnB,
			atTip,
			entry,
			undone,
			offeredLost,
			refused: { ...refused, message: refused.message },
			graph: graph(fixture, sessionId),
			journal: journal(fixture, sessionId),
		};
		const fork = (tipOfCut: string, available = true) => [
			{
				messageId: edited[2],
				branches: [
					{ tip: tipOfCut, text: "moves-cut", onHead: false, available },
					{
						tip: branchB.id,
						text: "moves-branch-b",
						onHead: true,
						available: true,
					},
				],
			},
		];
		expect(offered).toEqual(fork(cut.id));
		// A switch brings back that branch's own rows, and nothing else.
		expect(back).toEqual(original);
		expect(deeper.slice(0, 4)).toEqual(original);
		expect(onB).toEqual(edited);
		expect(offeredOnB).toEqual(fork(cutTip.id));
		expect(atTip).toEqual(deeper);
		expect(entry).toMatchObject({
			moveId: switched.moveId,
			kind: "switch",
			landed: true,
		});
		expect(undone).toEqual(edited);
		expect(offeredLost).toEqual(fork(cutTip.id, false));
		expect(refused).toMatchObject({
			_tag: "SessionBusy",
			command: "head_move",
			reason: "history_unavailable",
		});
		// A switch sends nothing: each prompt reached Claude once.
		for (const prompt of ["moves-cut", "moves-branch-b", "moves-cut-more"])
			expect(enqueued(fixture, prompt)).toHaveLength(1);
	});
});
