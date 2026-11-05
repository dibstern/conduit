// Head moves on the new flow (82tn.51), over the isolated process harness and the fake Claude SDK.
// How it could fail (lane 51 audit, failure catalogue):
// 1. a daemon that dies between a move's start and its landing never lands it, or lands it and
//    never sends its resend;
// 11. a second restart moves the rows again or sends the resend again;
// 2, 4. desktop and phone confirming the same proposal get two moves, two resends, different
//    receipts, or the second is refused as stale.
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
});
