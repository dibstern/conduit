import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

type SearchRow = {
	id: string;
	title: string;
	projectSlug: string;
	updatedAt: number;
	settledAt?: number;
};

// The replay harness hosts one relay without the daemon's cross-project
// reader. Intercept only that RPC; all other calls still reach the real relay.
async function mockDaemonSearch(page: Page) {
	const rows: SearchRow[] = [];
	const requests: Record<string, unknown>[] = [];
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			if (typeof message !== "string") {
				server.send(message);
				return;
			}
			let frame: unknown;
			try {
				frame = JSON.parse(message);
			} catch {
				server.send(message);
				return;
			}
			if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
				server.send(message);
				return;
			}
			const request = frame as {
				_tag?: string;
				tag?: string;
				id?: string;
				payload?: Record<string, unknown>;
			};
			if (
				request._tag !== "Request" ||
				request.tag !== "ListDaemonSessions" ||
				!request.id
			) {
				server.send(message);
				return;
			}
			const params = request.payload ?? {};
			requests.push(params);
			const query =
				typeof params["search"] === "string"
					? params["search"].toLowerCase()
					: "";
			const limit = typeof params["limit"] === "number" ? params["limit"] : 20;
			const matches = rows.filter((row) =>
				row.title.toLowerCase().includes(query),
			);
			const cursor = params["cursor"] as { id?: string } | undefined;
			const offset = cursor?.id
				? matches.findIndex((row) => row.id === cursor.id) + 1
				: 0;
			const sessions = matches.slice(offset, offset + limit);
			const last = sessions.at(-1);
			const hasMore = offset + limit < matches.length;
			ws.send(
				JSON.stringify({
					_tag: "Exit",
					requestId: request.id,
					exit: {
						_tag: "Success",
						value: {
							projectSlug: params["projectSlug"],
							sessions,
							availability: [],
							hasMore,
							nextCursor:
								hasMore && last
									? { updatedAt: last.updatedAt, id: last.id }
									: null,
						},
					},
				}),
			);
		});
	});
	return { rows, requests };
}

test("searches recent and settled sessions, then opens one without unsettling it", async ({
	page,
	relayUrl,
}) => {
	const daemonSearch = await mockDaemonSearch(page);
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const target = rows.last();
	const id = await target.getAttribute("data-session-id");
	const title = (
		await target.locator(".session-title-inner").innerText()
	).trim();
	if (!id || !title) throw new Error("missing session title or id");
	daemonSearch.rows.push({
		id,
		title,
		projectSlug: "e2e-replay",
		updatedAt: Date.now(),
		settledAt: Date.now(),
	});
	await target.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await expect(
		page.locator(`#session-list [data-session-id="${id}"]`),
	).toHaveCount(0);

	await rows.first().click();
	await expect(page).toHaveURL(/\/s\/[^/]+/);
	const composer = page.locator("#input");
	await composer.focus();
	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByTestId("deep-search")).toBeVisible();
	const input = page.getByTestId("deep-search-input");
	await expect(input).toBeFocused();
	await expect(page.getByText("Recent", { exact: true })).toBeVisible();
	await expect
		.poll(() => page.getByTestId("deep-search-result").count())
		.toBeGreaterThan(0);
	await expect
		.poll(() => page.getByTestId("deep-search-result").count())
		.toBeLessThanOrEqual(8);
	await input.fill(title);
	// Recent rows stay on screen until the search page lands, so wait for it.
	await expect
		.poll(() => daemonSearch.requests.at(-1))
		.toMatchObject({ roots: true, search: title, limit: 20 });
	await expect(
		page.getByTestId("deep-search-result").filter({ hasNotText: title }),
	).toHaveCount(0);
	const match = page
		.getByTestId("deep-search-result")
		.filter({ hasText: title })
		.first();
	await expect(match).toBeVisible();
	await expect(match).toContainText("Settled");
	await expect(match.getByText("e2e-replay", { exact: true })).toBeVisible();
	expect(daemonSearch.requests.at(-1)).not.toHaveProperty("scope");
	await input.focus();
	await page.keyboard.press("ArrowDown");
	await expect(input).toHaveAttribute(
		"aria-activedescendant",
		"deep-search-option-0",
	);
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("deep-search")).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`/s/${id}`));
	await page.getByTestId("settled-shelf-toggle").click();
	await expect(
		page.locator(`#settled-shelf-rows [data-session-id="${id}"]`),
	).toBeVisible();
});

test("no match, Escape, and repeated shortcut leave sidebar state intact", async ({
	page,
	relayUrl,
}) => {
	const daemonSearch = await mockDaemonSearch(page);
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	const title = (
		await rows.first().locator(".session-title-inner").innerText()
	).trim();
	const id = await rows.first().getAttribute("data-session-id");
	if (!id) throw new Error("missing session id");
	daemonSearch.rows.push({
		id,
		title,
		projectSlug: "e2e-replay",
		updatedAt: Date.now(),
	});
	const sidebarSearch = page.locator("#session-search-input");
	await sidebarSearch.fill(title);
	await expect(rows.first()).toBeVisible();
	const before = await rows.evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-session-id")),
	);
	await rows.first().click();
	const composer = page.locator("#input");
	await composer.focus();
	await page.keyboard.press("ControlOrMeta+k");
	const input = page.getByTestId("deep-search-input");
	await expect(input).toBeFocused();
	await page.keyboard.press("ControlOrMeta+k");
	await expect(input).toBeFocused();
	await input.fill("unlikely-session-title-xyz-987");
	await expect(
		page.getByText("No sessions match “unlikely-session-title-xyz-987”"),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("deep-search")).toHaveCount(0);
	await expect(composer).toBeFocused();
	await expect(sidebarSearch).toHaveValue(title);
	await expect
		.poll(() =>
			rows.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-session-id")),
			),
		)
		.toEqual(before);
});

test("palette fits a phone viewport", async ({ page, relayUrl }) => {
	await mockDaemonSearch(page);
	await page.setViewportSize({ width: 393, height: 852 });
	await gotoRelay(page, relayUrl);
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByTestId("deep-search");
	await expect(palette).toBeVisible();
	await expect(page.getByTestId("deep-search-input")).toBeFocused();
	const box = await palette.boundingBox();
	if (!box) throw new Error("missing palette bounds");
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(393);
});

test("query results page by cursor without loading the whole match set", async ({
	page,
	relayUrl,
}) => {
	const daemonSearch = await mockDaemonSearch(page);
	for (let index = 0; index < 25; index++) {
		daemonSearch.rows.push({
			id: `batch-${index}`,
			title: `Batch session ${index}`,
			projectSlug: index % 2 === 0 ? "e2e-replay" : "another-project",
			updatedAt: Date.now() - index,
		});
	}
	await gotoRelay(page, relayUrl);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("deep-search-input").fill("Batch session");
	await expect(page.getByTestId("deep-search-result")).toHaveCount(20);
	await expect(page.getByText("20+ results")).toBeVisible();
	await page.getByTestId("deep-search-more").click();
	await expect(page.getByTestId("deep-search-result")).toHaveCount(25);
	await expect(page.getByText("25 results")).toBeVisible();
	await expect(page.getByTestId("deep-search-more")).toHaveCount(0);
	expect(daemonSearch.requests.at(-1)).toMatchObject({
		roots: true,
		search: "Batch session",
		limit: 20,
		cursor: { id: "batch-19" },
	});
	expect(daemonSearch.requests.at(-1)).not.toHaveProperty("scope");
});
