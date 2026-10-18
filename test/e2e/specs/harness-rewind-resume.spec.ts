// Going back to a session after a rewind, or its undo, resumes it
// (conduit-test-k7pp), through the built server and a real browser. A rewind
// moves every row of the session at one version. The tab rewinds, leaves for
// another session, and comes back. Then it undoes the rewind and does the same
// again. One session is longer than a page. The other is shorter than a page,
// but its page was cut short by the frame budget.
//
// Ways it can fail, each checked below:
// - the return resumes from just below the version the rewind moved every
//   row at, so the whole session comes back: a snapshot past one page, or
//   a page the frame budget cut short;
// - the return resumes past rows it only partly applied, and the checksum
//   disowns the view (a mismatch, then a snapshot);
// - the rewind point travels only with rows of its own version, so a return
//   from past it loses the Undo notice, or keeps a stale one after undo;
// - the resumed transcript is not the tail of a cold load: a stale, missing
//   or hidden row. (A cold first page refills to a full page; the resumed one
//   keeps the window it had, so it may start a turn later.)
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --workers=1 harness-rewind-resume

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	EventPayloadMap,
	LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const OTHER = "rewind-other";
const START = Date.UTC(2026, 9, 1);
const MISMATCH = "[resume] checksum mismatch";
/** Past one page of messages: 30 turns are 60 messages. */
const LONG = { id: "rewind-long", turns: 30, replyBytes: 200 };
/** Under one page of messages, over its frame budget: 10 turns of ~40 KB. */
const HEAVY = { id: "rewind-heavy", turns: 10, replyBytes: 40_000 };

const replyEnd = (sessionId: string, turn: number) =>
	`END-OF-${sessionId}-${turn}.`;
const prose = (label: string, bytes: number) =>
	Array.from(
		{ length: Math.ceil(bytes / 64) },
		(_, line) => `${label} line ${line}: the quick brown fox jumps over it.`,
	).join("\n");

const event =
	(sessionId: string, createdAt: number) =>
	<T extends LiveEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, sessionId, data, { provider: "claude", createdAt });

const userId = (sessionId: string, turn: number) => `${sessionId}-u${turn}`;

/** A session of `count` prompts, each answered with ~`replyBytes`. */
const session = (
	sessionId: string,
	count: number,
	replyBytes: number,
): CanonicalEvent[] => [
	event(sessionId, START)("session.created", {
		sessionId,
		title: sessionId,
		provider: "claude",
		providerSessionId: sessionId,
	}),
	...Array.from({ length: count }, (_, turn) => {
		const at = START + 1000 + turn * 1000;
		const user = userId(sessionId, turn);
		const assistant = `${sessionId}-a${turn}`;
		const prompt = event(sessionId, at);
		const answer = event(sessionId, at + 500);
		return [
			prompt("message.created", { messageId: user, role: "user", sessionId }),
			prompt("text.delta", {
				messageId: user,
				partId: `${user}-0`,
				text: `Prompt ${turn}.`,
			}),
			answer("message.created", {
				messageId: assistant,
				role: "assistant",
				sessionId,
			}),
			answer("text.delta", {
				messageId: assistant,
				partId: `${assistant}-text`,
				text: `${prose(`Reply ${turn}`, replyBytes)}\n${replyEnd(sessionId, turn)}`,
			}),
			answer("turn.completed", {
				messageId: assistant,
				tokens: { input: 10, output: 10 },
				duration: 1000,
			}),
		];
	}).flat(),
];

const seed = (filename: string, events: readonly CanonicalEvent[]) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([...events], { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

/** Every value anywhere in a frame that matches `match`. */
const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};
const tagged = (tag: string) => (value: object) =>
	"_tag" in value && value._tag === tag;
const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** The transcript's text, without the "↓ Latest" button, which shows or not
 * depending on where the tab happens to be scrolled. */
const transcriptOf = (page: Page) =>
	page.locator("#messages").evaluate((messages: HTMLElement) => {
		const button = messages.querySelector<HTMLElement>("#scroll-btn");
		if (!button) return messages.innerText;
		const display = button.style.display;
		button.style.display = "none";
		try {
			return messages.innerText;
		} finally {
			button.style.display = display;
		}
	});

test.describe.configure({ retries: 0 });

test("returning to a session after a rewind or its undo resumes it", async ({
	browser,
	harness,
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"The wire is the same on every device; desktop shows the sidebar beside the transcript.",
	);
	test.setTimeout(300_000);
	const store = harness.daemonStorePath();
	const viewport = testInfo.project.use.viewport ?? null;
	const url = (sessionId: string) =>
		`${harness.baseUrl}/s/${sessionId}?p=process-test`;

	await harness.terminate();
	await seed(store, [
		...session(LONG.id, LONG.turns, LONG.replyBytes),
		...session(HEAVY.id, HEAVY.turns, HEAVY.replyBytes),
		...session(OTHER, 1, 200),
	]);
	await harness.restart({ keepPort: true, skipBrowserProbe: true });
	const rpc = (
		await harness.connect(undefined, undefined, "process-test", false)
	).rpc;

	const sent: unknown[] = [];
	const received: unknown[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => sent.push(parse(String(payload))));
		socket.on("framereceived", ({ payload }) =>
			received.push(parse(String(payload))),
		);
	});
	let mismatches = 0;
	page.on("console", (message) => {
		if (message.text().includes(MISMATCH)) mismatches += 1;
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	const messages = page.locator("#messages");
	const notice = page.getByTestId("rewind-pending");
	const open = async (sessionId: string, shown: string) => {
		// The title: a hovered row's middle is its mark-read and settle verbs.
		await page
			.locator(
				`#session-list .session-item[data-session-id="${sessionId}"] .session-item-title`,
			)
			.click();
		await expect(page).toHaveURL(new RegExp(`/s/${sessionId}(\\?|$)`));
		await expect(messages).toContainText(shown, { timeout: 30_000 });
	};

	const detailRequests = (sessionId: string, from: number) =>
		sent
			.slice(from)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						tagged("Request")(found) &&
						"tag" in found &&
						found.tag === "SubscribeSessionDetail" &&
						"payload" in found &&
						typeof found.payload === "object" &&
						found.payload !== null &&
						"sessionId" in found.payload &&
						found.payload.sessionId === sessionId,
				),
			);
	const detailEnvelopes = (
		requests: readonly object[],
		receivedFrom: number,
	) => {
		const ids = new Set(
			requests.map((request) => ("id" in request ? String(request.id) : "")),
		);
		return received
			.slice(receivedFrom)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						tagged("Chunk")(found) &&
						"requestId" in found &&
						ids.has(String(found.requestId)),
				),
			)
			.flatMap((chunk): object[] =>
				"values" in chunk && Array.isArray(chunk.values) ? chunk.values : [],
			);
	};

	const coldOpen = async (sessionId: string, shown: string) => {
		const context = await browser.newContext({ viewport });
		try {
			const fresh = await context.newPage();
			await fresh.goto(url(sessionId));
			await expect(fresh.locator("#messages")).toContainText(shown, {
				timeout: 30_000,
			});
			return await transcriptOf(fresh);
		} finally {
			await context.close();
		}
	};

	/** Leave for another session and come back, and report the return. */
	const leaveAndReturn = async (
		sessionId: string,
		shown: string,
		hidden: string | undefined,
	) => {
		await open(OTHER, replyEnd(OTHER, 0));
		const sentFrom = sent.length;
		const receivedFrom = received.length;
		const mismatchesBefore = mismatches;
		await open(sessionId, shown);
		await expect
			.poll(
				() =>
					detailEnvelopes(
						detailRequests(sessionId, sentFrom),
						receivedFrom,
					).some(tagged("synchronized")),
				{ timeout: 30_000 },
			)
			.toBe(true);
		// Anything a mismatch would trigger has landed by now.
		await page.waitForTimeout(1_500);
		const requests = detailRequests(sessionId, sentFrom);
		const envelopes = detailEnvelopes(requests, receivedFrom);
		const cold = await coldOpen(sessionId, shown);
		const transcript = await transcriptOf(page);
		return {
			detailRequests: requests.length,
			resumed: find(requests[0], (found) => "resumeBase" in found).length > 0,
			detailSnapshots: envelopes.filter(tagged("snapshot")).length,
			checkedSyncs: envelopes.filter(
				(envelope) =>
					tagged("synchronized")(envelope) && "checksum" in envelope,
			).length,
			mismatches: mismatches - mismatchesBefore,
			undoShown: await notice.isVisible(),
			hiddenShown: hidden === undefined ? false : transcript.includes(hidden),
			transcriptIsColdTail: cold.endsWith(transcript),
		};
	};

	const scenarios: {
		name: string;
		verdicts: Record<string, unknown>;
		expected: Record<string, unknown>;
	}[] = [];
	const resumed = {
		detailRequests: 1,
		resumed: true,
		detailSnapshots: 0,
		checkedSyncs: 1,
		mismatches: 0,
		hiddenShown: false,
		transcriptIsColdTail: true,
	};

	await page.goto(url(OTHER));
	await expect(messages).toContainText(replyEnd(OTHER, 0), {
		timeout: 30_000,
	});
	for (const { id, turns } of [LONG, HEAVY]) {
		const last = turns - 1;
		await open(id, replyEnd(id, last));

		// Rewind to the last prompt: its turn leaves the transcript.
		await Effect.runPromise(
			rpc.RewindSession({
				sessionId: id,
				messageId: userId(id, last),
			}),
		);
		await expect(notice).toBeVisible({ timeout: 30_000 });
		await expect(messages).not.toContainText(replyEnd(id, last));
		scenarios.push({
			name: `${id}:rewind`,
			verdicts: await leaveAndReturn(
				id,
				replyEnd(id, last - 1),
				replyEnd(id, last),
			),
			expected: { ...resumed, undoShown: true },
		});

		// Undo it: the turn comes back.
		await Effect.runPromise(rpc.UndoRewind({ sessionId: id }));
		await expect(notice).toBeHidden({ timeout: 30_000 });
		await expect(messages).toContainText(replyEnd(id, last));
		scenarios.push({
			name: `${id}:undo`,
			verdicts: await leaveAndReturn(id, replyEnd(id, last), undefined),
			expected: { ...resumed, undoShown: false },
		});
	}

	const report = {
		schema: 1,
		project: testInfo.project.name,
		recordedAt: new Date().toISOString(),
		sessions: { long: LONG, heavy: HEAVY },
		scenarios,
		pageErrors,
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`rewind-resume.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("rewind-resume-report", { path: output });

	for (const { name, verdicts, expected } of scenarios)
		expect(verdicts, name).toMatchObject(expected);
	expect(pageErrors).toEqual([]);
});
