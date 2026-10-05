// The sidebar pager's "Loading…" row. A list whose rows mostly sit in the
// collapsed settled shelf stays too short to scroll, so the pager fetches page
// after page on load; showing the row for each one flashed it at the bottom of
// the sidebar. The row is for a user waiting at the bottom of a scrollable list,
// and it must stay put for the whole run of pages: mounting it per request
// grew and shrank the list under that user's scroll.

import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

type Page = import("@playwright/test").Page;

const LOCAL = "e2e-replay";

/** By default half the root rows are local (shell feed), half foreign (daemon
 *  pager). Subagent children (parentOf) belong to the local project. */
async function mockSessions(
	page: Page,
	{
		total,
		settled,
		parentOf = () => undefined,
		foreign = (index) => index % 2 === 1,
	}: {
		total: number;
		settled: (index: number) => boolean;
		parentOf?: (index: number) => string | undefined;
		foreign?: (index: number) => boolean;
	},
): Promise<{ requested: string[]; exhausted: () => boolean }> {
	const now = Date.now();
	const sessions = Array.from({ length: total }, (_, index) => {
		const parentID = parentOf(index);
		return {
			id: `sess-${String(index).padStart(3, "0")}`,
			title: `Session ${index}`,
			status: "idle",
			projectSlug:
				parentID === undefined && foreign(index) ? "other-proj" : LOCAL,
			updatedAt: now - 1000 - index,
			messageCount: 1,
			...(settled(index) ? { settledAt: now - 500 } : {}),
			...(parentID !== undefined ? { parentID } : {}),
		};
	});
	const requested: string[] = [];
	let exhausted = false;
	await mockWsRpc(page, {
		handlers: {
			ListDaemonSessions: async (params) => {
				await new Promise((resolve) => setTimeout(resolve, 300));
				const limit = Number(params["limit"]);
				const cursor = params["cursor"] as { id: string } | undefined;
				requested.push(cursor?.id ?? "first");
				// The server's roots filter is `parent_id IS NULL`.
				const pool = sessions.filter(
					(session) =>
						(params["roots"] !== true || session.parentID === undefined) &&
						session.projectSlug !== params["exclude"],
				);
				const start = cursor
					? pool.findIndex((session) => session.id === cursor.id) + 1
					: 0;
				const rows = pool.slice(start, start + limit);
				const last = rows.at(-1);
				const hasMore = start + limit < pool.length;
				exhausted = !hasMore;
				return {
					sessions: rows,
					availability: [],
					hasMore,
					nextCursor:
						hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
				};
			},
			ViewSession: () => ({ ok: true }),
		},
		streams: {
			SubscribeShell: () => [
				{
					_tag: "snapshot",
					sequence: 1,
					rows: sessions
						.filter(
							(session) =>
								session.projectSlug === LOCAL && session.parentID === undefined,
						)
						.map(({ id, title, status, updatedAt, settledAt }) => ({
							id,
							title,
							status,
							updatedAt: new Date(updatedAt).toISOString(),
							...(settledAt ? { settledAt } : {}),
						})),
				},
				{ _tag: "synchronized" },
			],
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{ slug: LOCAL, title: LOCAL, folders: [`/tmp/${LOCAL}`] },
					{
						slug: "other-proj",
						title: "other-proj",
						folders: ["/tmp/other-proj"],
					},
				],
				current: LOCAL,
			},
		],
		responses: new Map(),
	});
	return { requested, exhausted: () => exhausted };
}

test("a list too short to scroll pages in without flashing the loading row", async ({
	page,
	relayUrl,
}) => {
	const { requested } = await mockSessions(page, {
		total: 150,
		settled: (index) => index >= 15,
	});
	await page.addInitScript(() => {
		const w = window as unknown as { __loadingShown: boolean };
		w.__loadingShown = false;
		new MutationObserver(() => {
			if (document.querySelector('[data-testid="session-list-loading-more"]')) {
				w.__loadingShown = true;
			}
		}).observe(document, { childList: true, subtree: true });
	});
	await page.goto(relayUrl);

	// Every page still arrives; only the indicator stays quiet.
	await expect.poll(() => requested.length, { timeout: 10_000 }).toBe(3);
	await expect(
		page.locator("#session-list .session-item").first(),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => (window as unknown as { __loadingShown: boolean }).__loadingShown,
		),
	).toBe(false);
});

test("scrolling to the bottom of a long list shows the loading row", async ({
	page,
	relayUrl,
}) => {
	const { requested } = await mockSessions(page, {
		total: 150,
		settled: () => false,
	});
	await page.goto(relayUrl);
	await expect.poll(() => requested.length).toBe(1);
	await expect(
		page.locator("#session-list .session-item").first(),
	).toBeVisible();

	await page
		.locator("#session-list-scroller")
		.evaluate((element) => element.scrollTo(0, element.scrollHeight));
	await expect(page.getByTestId("session-list-loading-more")).toBeVisible();
	await expect.poll(() => requested.length).toBe(2);
});

test("pages landing in the collapsed shelf do not resize the list under the user", async ({
	page,
	relayUrl,
}) => {
	// Scrollable after the first page, and every later page is settled, so it
	// adds nothing visible: only the loading row could change the list's height.
	const { requested } = await mockSessions(page, {
		total: 150,
		settled: (index) => index >= 30,
	});
	await page.goto(relayUrl);
	await expect.poll(() => requested.length).toBe(1);
	await expect(
		page.locator("#session-list .session-item").first(),
	).toBeVisible();

	const run = page.evaluate(async () => {
		const scroller = document.querySelector(
			"#session-list-scroller",
		) as HTMLElement;
		scroller.scrollTo(0, scroller.scrollHeight);
		const heights: number[] = [];
		let mounts = 0;
		let shown = false;
		const t0 = performance.now();
		while (performance.now() - t0 < 2500) {
			const now = !!document.querySelector(
				'[data-testid="session-list-loading-more"]',
			);
			if (now && !shown) mounts += 1;
			shown = now;
			if (now) heights.push(scroller.scrollHeight);
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		return { mounts, heights };
	});
	await expect.poll(() => requested.length, { timeout: 10_000 }).toBe(3);
	const { mounts, heights } = await run;
	expect(mounts).toBe(1);
	expect(new Set(heights).size).toBe(1);
});

test("a store of mostly subagent sessions loads the sidebar from one page", async ({
	page,
	relayUrl,
}) => {
	// The sidebar shows root sessions only. A real store held 8,641 subagent
	// children beside 142 roots; asking for every session made each page add
	// nothing visible, so the pager walked all 293 pages on every load and
	// session opens queued behind it.
	const { requested, exhausted } = await mockSessions(page, {
		total: 300,
		settled: () => false,
		parentOf: (index) => (index < 10 ? undefined : "sess-000"),
	});
	await page.goto(relayUrl);

	await expect.poll(exhausted, { timeout: 10_000 }).toBe(true);
	expect(requested).toEqual(["first"]);
	await expect(page.locator("#session-list .session-item")).toHaveCount(10);
});

test("a store dominated by this project loads other projects from one page", async ({
	page,
	relayUrl,
}) => {
	// This project's roots arrive on the shell feed, so browse pages that also
	// carried them added nothing visible and the pager walked every root.
	const { requested, exhausted } = await mockSessions(page, {
		total: 300,
		settled: () => false,
		foreign: (index) => index < 10,
	});
	await page.goto(relayUrl);

	await expect.poll(exhausted, { timeout: 10_000 }).toBe(true);
	expect(requested).toEqual(["first"]);
	await expect(
		page.locator('#session-list .session-item[data-session-id="sess-009"]'),
	).toBeAttached();
});
