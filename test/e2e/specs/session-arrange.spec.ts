import { writeFileSync } from "node:fs";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

test("browse paging keeps older priorities visible and promotes a live pin without refetching", async ({
	page,
	relayUrl,
}, testInfo) => {
	const now = Date.now();
	const row = (id: string, updatedAt: number) => ({
		id,
		title: id,
		accountId: null,
		projectSlug: "e2e-replay",
		status: "idle" as const,
		updatedAt,
	});
	const priorities = [
		{ ...row("older-pinned", now - 100_000), pinnedAt: now - 10_000 },
		{
			...row("older-needs-you", now - 110_000),
			attention: "needs-approval" as const,
			pendingPermissionCount: 1,
		},
	];
	const promoted = row("older-new-pin", now - 120_000);
	const sessions = [
		...Array.from({ length: 35 }, (_, index) =>
			row(`recent-idle-${index}`, now - index),
		),
		...priorities,
		promoted,
	];
	const rpc = await mockWsRpc(page, {
		stubs: {
			ListDaemonSessions: ({ search, cursor, limit }) => {
				const matches = sessions.filter((session) =>
					session.title.includes(search ?? ""),
				);
				const start = cursor
					? matches.findIndex((session) => session.id === cursor.id) + 1
					: 0;
				const size = limit ?? matches.length;
				const page = matches.slice(start, start + size);
				const last = page.at(-1);
				const hasMore = start + size < matches.length;
				return {
					sessions: page,
					availability: [],
					hasMore,
					nextCursor:
						hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
				};
			},
		},
	});
	const serverStatus = {
		protocolVersion: WS_PROTOCOL_VERSION,
		buildId: "dev",
		restartAvailable: false,
	};
	rpc.setDaemonList("SubscribeServerStatus", {
		...serverStatus,
		sessionsRevision: 0,
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "e2e-replay",
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: "e2e-replay",
			},
			{ type: "shell_snapshot", roots: true, sessions },
		],
		responses: new Map(),
	});
	await page.goto(relayUrl);
	for (const priority of priorities)
		await expect(
			page.locator(`#session-list [data-session-id="${priority.id}"]`),
		).toBeVisible();
	await expect(
		page.locator('#session-list [data-session-id="older-new-pin"]'),
	).toHaveCount(0);
	const browseRequests = () =>
		rpc.getRequests().filter(({ tag }) => tag === "ListDaemonSessions");
	expect(browseRequests()).toHaveLength(0);
	rpc.upsertShellRow({ ...promoted, pinnedAt: now });
	await expect(
		page.locator('#session-list [data-session-id="older-new-pin"]'),
	).toBeVisible();
	expect(browseRequests()).toHaveLength(0);
	const initialBrowseRefetchCount = browseRequests().length;
	const input = page.getByRole("textbox", { name: "Search sessions" });
	await input.fill("recent-idle");
	await expect(page.getByTestId("session-search-summary")).toContainText(
		"30+ matches",
	);
	expect(
		browseRequests().some(({ payload }) => payload["search"] === "recent-idle"),
	).toBe(true);
	await input.fill("");
	await expect(page.getByTestId("session-search-summary")).toBeHidden();
	await expect(
		page.locator('#session-list [data-session-id="older-pinned"]'),
	).toBeVisible();
	await expect(page.locator("#session-list a[data-session-id]")).toHaveCount(
		30,
	);
	const requestCountWhenSearchCleared = browseRequests().length;
	await rpc.waitForRequest(({ tag }) => tag === "SubscribeServerStatus");
	rpc.setDaemonList("SubscribeServerStatus", {
		...serverStatus,
		sessionsRevision: 1,
	});
	const afterSearch = {
		...row("after-search-live", now + 1),
		pinnedAt: now + 1,
	};
	rpc.upsertShellRow(afterSearch);
	await expect(
		page.locator('#session-list [data-session-id="after-search-live"]'),
	).toBeVisible();
	await page.locator("#session-list-scroller").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(page.locator("#session-list a[data-session-id]")).toHaveCount(
		sessions.length + 1,
	);
	const browseRefetchCountAfterSearchCleared =
		browseRequests().length - requestCountWhenSearchCleared;
	expect(browseRefetchCountAfterSearchCleared).toBe(0);
	const artifact = testInfo.outputPath("browse-priority-paging.json");
	writeFileSync(
		artifact,
		`${JSON.stringify({ loadedRows: sessions.length, initialPriorities: priorities.map(({ id }) => id), promoted: promoted.id, browseRefetchCount: initialBrowseRefetchCount, searchRequestCount: requestCountWhenSearchCleared, browseRefetchCountAfterSearchCleared }, null, 2)}\n`,
	);
	await testInfo.attach("browse-priority-paging", {
		path: artifact,
		contentType: "application/json",
	});
});

test("status filter and grouping survive reload and follow browser history", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	await expect(rows.first()).toHaveClass(/(?:^|\s)active(?:\s|$)/);
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const originalCount = await rows.count();

	const runningCount = Number(
		await page
			.getByTestId("session-filter-chip-running")
			.locator("b")
			.innerText(),
	);
	const filter = runningCount < originalCount ? "running" : "unread";
	const filteredCount = Number(
		await page
			.getByTestId(`session-filter-chip-${filter}`)
			.locator("b")
			.innerText(),
	);
	expect(filteredCount).toBeLessThan(originalCount);
	await page.getByTestId(`session-filter-chip-${filter}`).click();
	await expect(page).toHaveURL(new RegExp(`status=${filter}`));
	await expect(rows).toHaveCount(filteredCount);
	await page.getByTestId(`session-filter-chip-${filter}`).click();
	await expect(rows).toHaveCount(originalCount);

	await page.getByTestId("session-filter-chip-needs-you").click();
	await expect(page).toHaveURL(/status=needs-you/);
	await expect(rows).toHaveCount(0);
	await expect(page.getByTestId("session-filter-empty")).toContainText(
		"Nothing needs you",
	);
	await page.getByTestId("session-filter-clear").click();
	await expect(rows).toHaveCount(originalCount);
	await expect(page).not.toHaveURL(/status=/);

	await page.getByTestId("session-group-button").click();
	await page.getByTestId("session-group-option-time").click();
	await expect(page).toHaveURL(/group=time/);
	await expect(
		page.locator(".session-group-label").filter({ hasText: "Today" }),
	).toBeVisible();

	await page.getByTestId("session-group-button").click();
	await page.getByTestId("session-group-option-project").click();
	await expect(page).toHaveURL(/group=project/);
	await expect(page.getByTestId("session-group-chip")).toContainText(
		"By project",
	);
	await expect(page.locator(".session-group-label").first()).toContainText(
		"e2e-replay",
	);

	await page.getByTestId("session-filter-chip-running").click();
	await expect(page).toHaveURL(/status=running/);
	await page.reload();
	await expect(page.getByTestId("session-filter-chip-running")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("session-group-chip")).toContainText(
		"By project",
	);
	await expect(page).toHaveURL(/group=project/);
	await page.goBack();
	await expect(page).not.toHaveURL(/status=/);
	await expect(page).toHaveURL(/group=project/);
	await expect(rows).toHaveCount(originalCount);
	await page.getByTestId("session-group-chip").click();
	await expect(page).not.toHaveURL(/group=/);
});
