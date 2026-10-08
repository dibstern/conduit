// The page budget (conduit-test-y7eo.7), through the built server and a real
// browser. A transcript page is up to 50 messages or 256 KB of encoded frame,
// whichever comes first; it never splits a message and always holds one whole
// message. What the browser receives is read off its /rpc socket.
//
// Ways it can fail, each checked below:
// - a page over 256 KB, because rows were weighed without their envelope;
// - a message larger than the budget dropped, leaving an empty page, or cut;
// - a message split across two pages;
// - a page cut short by the budget reporting no more history, stranding the
//   rest behind "load older";
// - a cursor naming a message the page left out, so "load older" skips or
//   repeats messages;
// - a "load older" page over the budget, or one that never makes progress.
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts harness-page-budget

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const PAGE_FRAME_BUDGET = 256 * 1024;
const SESSION = "page-budget";
const TURNS = 30;
const replyEnd = (turn: number) => `END-OF-reply-${turn}.`;
const HUGE_END = "END-OF-huge-reply";

// Agent text is never cut, so a turn's reply weighs on the page as written.
const prose = (label: string, bytes: number) =>
	Array.from(
		{ length: Math.ceil(bytes / 64) },
		(_, line) => `${label} line ${line}: the quick brown fox jumps over it.`,
	).join("\n");
// Each earlier reply is ~20 KB, so 50 messages would weigh ~500 KB.
const reply = (turn: number) =>
	`${prose(`Reply ${turn}`, 20_000)}\n${replyEnd(turn)}`;
// Bigger than a whole page on its own.
const HUGE_REPLY = `${prose("Huge", 300_000)}\n${HUGE_END}`;

const userId = (turn: number) => `${SESSION}-u${turn}`;
const assistantId = (turn: number) => `${SESSION}-a${turn}`;

const seed = (filename: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const start = Date.UTC(2026, 9, 1);
			const turn = (index: number, text: string): CanonicalEvent[] => {
				// The reply comes half a second after its prompt, so it is newer.
				const event =
					(offset: number) =>
					<T extends CanonicalEventType>(type: T, data: EventPayloadMap[T]) =>
						canonicalEvent(type, SESSION, data, {
							provider: "claude",
							createdAt: start + index * 1000 + offset,
						});
				const prompt = event(0);
				const answer = event(500);
				return [
					prompt("message.created", {
						messageId: userId(index),
						role: "user",
						sessionId: SESSION,
					}),
					prompt("text.delta", {
						messageId: userId(index),
						partId: `${userId(index)}-0`,
						text: `Prompt ${index}: next step.`,
					}),
					answer("message.created", {
						messageId: assistantId(index),
						role: "assistant",
						sessionId: SESSION,
					}),
					answer("text.delta", {
						messageId: assistantId(index),
						partId: `${assistantId(index)}-text`,
						text,
					}),
					answer("turn.completed", {
						messageId: assistantId(index),
						tokens: { input: 10, output: 10 },
						duration: 1000,
					}),
				];
			};
			yield* commit(
				[
					canonicalEvent(
						"session.created",
						SESSION,
						{
							sessionId: SESSION,
							title: "Page budget",
							provider: "claude",
							providerSessionId: SESSION,
						},
						{ provider: "claude", createdAt: start },
					),
					...Array.from({ length: TURNS }, (_, index) =>
						turn(index, reply(index)),
					).flat(),
					...turn(TURNS, HUGE_REPLY),
				],
				{ publish: false },
			);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
		),
	);

interface WireMessage {
	readonly id: string;
}

interface PageFrame {
	readonly bytes: number;
	readonly ids: readonly string[];
	readonly hasMore: boolean;
	readonly cursor?: string;
}

/** Every value anywhere in a frame that matches `match`. */
const find = <T extends object>(
	value: unknown,
	match: (value: object) => value is T,
): T[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};

const isSnapshot = (
	value: object,
): value is {
	readonly rows: readonly { readonly message?: WireMessage }[];
	readonly hasMore?: boolean;
	readonly cursor?: string;
} =>
	"_tag" in value &&
	value._tag === "snapshot" &&
	"rows" in value &&
	Array.isArray(value.rows);

const isHistoryPage = (
	value: object,
): value is {
	readonly messages: readonly WireMessage[];
	readonly hasMore: boolean;
} =>
	"sessionId" in value &&
	value.sessionId === SESSION &&
	"messages" in value &&
	Array.isArray(value.messages) &&
	"hasMore" in value;

const strings = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: typeof value === "object" && value !== null
			? Object.values(value).flatMap(strings)
			: [];

test.describe.configure({ retries: 0 });

test("a page holds up to 256 KB of whole messages, and load older reaches the rest", async ({
	harness,
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await harness.terminate();
	await seed(harness.projectStorePath());
	await harness.restart({ keepPort: true });

	const snapshots: PageFrame[] = [];
	const olderPages: PageFrame[] = [];
	let hugeArrivedWhole = false;
	page.on("websocket", (socket) => {
		if (!new URL(socket.url()).pathname.endsWith("/rpc")) return;
		socket.on("framereceived", ({ payload }) => {
			const text = payload.toString();
			if (!text.includes(SESSION)) return;
			const bytes = Buffer.byteLength(text);
			const value: unknown = JSON.parse(text);
			for (const snapshot of find(value, isSnapshot)) {
				const ids = snapshot.rows.flatMap(({ message }) => message?.id ?? []);
				if (!ids.some((id) => id.startsWith(SESSION))) continue;
				snapshots.push({
					bytes,
					ids,
					hasMore: snapshot.hasMore ?? false,
					...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
				});
				hugeArrivedWhole ||= strings(snapshot).includes(HUGE_REPLY);
			}
			for (const older of find(value, isHistoryPage))
				olderPages.push({
					bytes,
					ids: older.messages.map(({ id }) => id),
					hasMore: older.hasMore,
				});
		});
	});

	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${SESSION}?p=process-test`);
	await expect(
		page.locator(".msg-assistant").filter({ hasText: HUGE_END }),
	).toBeVisible({ timeout: 30_000 });

	// A message over the budget arrives whole, alone on its page, and the page
	// says there is more, from that message.
	const [first] = snapshots;
	expect(first).toBeDefined();
	expect(first?.ids).toEqual([assistantId(TURNS)]);
	expect(first?.hasMore).toBe(true);
	expect(first?.cursor).toBe(assistantId(TURNS));
	expect(first?.bytes).toBeGreaterThan(PAGE_FRAME_BUDGET);
	expect(hugeArrivedWhole).toBe(true);

	// Load older until the first prompt shows: every earlier message arrives.
	const messages = page.locator("#messages");
	const oldest = page.locator(".msg-user").filter({ hasText: "Prompt 0:" });
	await expect(async () => {
		await messages.evaluate((element) => {
			element.scrollTop = 0;
		});
		await expect(oldest).toBeVisible({ timeout: 1_000 });
	}).toPass({ timeout: 60_000 });
	for (let turn = 0; turn < TURNS; turn++) {
		await expect(
			page.locator(".msg-user").filter({ hasText: `Prompt ${turn}:` }),
		).toHaveCount(1);
		await expect(
			page.locator(".msg-assistant").filter({ hasText: replyEnd(turn) }),
		).toHaveCount(1);
	}

	// Each older page fits the budget with at least one whole message, and
	// together the pages hold every message exactly once.
	const report = {
		project: testInfo.project.name,
		budgetBytes: PAGE_FRAME_BUDGET,
		firstPage: first,
		olderPages,
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`page-budget.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("page-budget-report", { path: output });

	expect(olderPages.length).toBeGreaterThan(1);
	for (const older of olderPages) {
		expect(older.bytes).toBeLessThanOrEqual(PAGE_FRAME_BUDGET);
		expect(older.ids.length).toBeGreaterThan(0);
		expect(older.ids.length).toBeLessThanOrEqual(50);
	}
	expect(olderPages.at(-1)?.hasMore).toBe(false);
	expect(olderPages.slice(0, -1).every(({ hasMore }) => hasMore)).toBe(true);
	const delivered = [
		...olderPages.flatMap(({ ids }) => ids),
		...(first?.ids ?? []),
	];
	const seeded = Array.from({ length: TURNS + 1 }, (_, turn) => [
		userId(turn),
		assistantId(turn),
	]).flat();
	expect([...delivered].sort()).toEqual([...seeded].sort());
});
