import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple", daemonSessionQueries: true });

const row = (page: Page, id: string) =>
	page.locator(`#session-list [data-session-id="${id}"]`);

function browse(
	harness: ReplayHarness,
	search?: string,
	includeArchived = false,
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup, { flatten: true });
			return yield* client("ListDaemonSessions", {
				projectSlug: "e2e-replay",
				...(search === undefined ? {} : { search }),
				...(includeArchived ? { includeArchived: true } : {}),
			});
		}).pipe(
			Effect.provide(
				RpcClient.layerProtocolSocket().pipe(
					Layer.provide(
						Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
					),
					Layer.provide(Socket.layerWebSocketConstructorGlobal),
					Layer.provide(RpcSerialization.layerJson),
				),
			),
			Effect.scoped,
		),
	);
}

test("manual archive leaves both sidebars, requires search opt-in and restores on send", async ({
	page,
	context,
	relayUrl,
	harness,
}, testInfo) => {
	const id = decodeURIComponent(harness.projectUrl.slice(3));
	await gotoRelay(page, relayUrl);
	const other = await context.newPage();
	await gotoRelay(other, relayUrl);
	await expect(row(page, id)).toBeVisible();
	await expect(row(other, id)).toBeVisible();
	const title = (
		await row(page, id).locator(".session-title-inner").innerText()
	).trim();
	// Archive a settled conversation to exercise both independent states and
	// the existing unsettle-on-send path when it is restored.
	await row(page, id).click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await page.getByTestId("settled-shelf-toggle").click();
	await row(page, id).click({ button: "right" });
	await page.getByTestId("session-ctx-archive").click();
	await expect(row(page, id)).toHaveCount(0);
	await expect(row(other, id)).toHaveCount(0);
	await expect(page.getByTestId("settled-shelf-toggle")).toHaveCount(0);
	await expect(other.getByTestId("settled-shelf-toggle")).toHaveCount(0);
	expect(
		(await browse(harness)).sessions.some((session) => session.id === id),
	).toBe(false);
	expect(
		(await browse(harness, title)).sessions.some(
			(session) => session.id === id,
		),
	).toBe(false);
	const found = (await browse(harness, title, true)).sessions.find(
		(session) => session.id === id,
	);
	expect(found).toMatchObject({ id, archivedAt: expect.any(Number) });
	// Removing a row from the feed must leave its open transcript and composer.
	await expect(page.locator("#input")).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("archived-two-browsers.png"),
	});
	await new AppPage(page).sendMessage("Hello from the archive");
	await expect(row(page, id)).toBeVisible();
	await expect(row(other, id)).toBeVisible();
	await expect(page.getByTestId("session-bar-state-chip")).toHaveCount(0);
	const restored = (await browse(harness)).sessions.find(
		(session) => session.id === id,
	);
	expect(restored?.archivedAt).toBeUndefined();
	expect(restored?.settledAt).toBeUndefined();
	await page.screenshot({ path: testInfo.outputPath("restored-active.png") });
});

test("archived sessions are opt-in search results and can be restored in Settings", async ({
	page,
	relayUrl,
	harness,
}, testInfo) => {
	const id = decodeURIComponent(harness.projectUrl.slice(3));
	await gotoRelay(page, relayUrl);
	const sidebar = new SidebarPage(page);
	await expect(row(page, id)).toBeVisible();
	const title = (
		await row(page, id).locator(".session-title-inner").innerText()
	).trim();
	await sidebar.openContextMenu(id);
	await page.getByTestId("session-ctx-archive").click();
	await expect(row(page, id)).toHaveCount(0);

	await sidebar.searchSessions(title);
	const includeArchived = page.getByTestId("search-include-archived");
	await expect(includeArchived).toBeVisible();
	await expect(includeArchived).not.toBeChecked();
	await expect(page.getByText("No matching sessions")).toBeVisible();
	await expect(row(page, id)).toHaveCount(0);
	await includeArchived.check();
	await expect(row(page, id)).toBeVisible();
	await expect(row(page, id).getByTestId("session-archived-badge")).toHaveText(
		"Archived",
	);
	await page.screenshot({
		path: testInfo.outputPath("search-include-archived.png"),
	});
	await sidebar.searchSessions("");
	await expect(includeArchived).toHaveCount(0);
	await sidebar.searchSessions(title);
	await expect(includeArchived).not.toBeChecked();
	await expect(row(page, id)).toHaveCount(0);
	await sidebar.searchSessions("");

	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("deep-search-input").fill(title);
	await expect(page.getByText(`No sessions match “${title}”`)).toBeVisible();
	const deepIncludeArchived = page.getByTestId("deep-search-include-archived");
	await expect(deepIncludeArchived).not.toBeChecked();
	await deepIncludeArchived.check();
	const deepResult = page
		.getByTestId("deep-search-result")
		.filter({ hasText: title });
	await expect(deepResult.getByTestId("session-archived-badge")).toBeVisible();
	await page.getByTestId("deep-search-input").fill("");
	await expect(deepIncludeArchived).not.toBeChecked();
	await page.keyboard.press("Escape");
	await page.keyboard.press("ControlOrMeta+k");
	await expect(deepIncludeArchived).not.toBeChecked();
	await expect(page.getByTestId("deep-search-result")).toHaveCount(0);
	await page.keyboard.press("Escape");

	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-archived").click();
	const archived = page.locator(
		`[data-testid="archived-session-row"][data-session-id="${id}"]`,
	);
	await expect(archived).toBeVisible();
	await expect(archived).toContainText(title);
	await expect(
		page.getByTestId("archived-project-group").filter({ has: archived }),
	).toHaveAttribute("data-project-slug", "e2e-replay");
	await page.screenshot({ path: testInfo.outputPath("settings-archived.png") });
	await archived.getByTestId("archived-unarchive").click();
	await expect(archived).toHaveCount(0);
	await expect(page.getByTestId("archived-empty")).toBeVisible();
	await page.getByTestId("settings-close-btn").click();
	await expect(row(page, id)).toBeVisible();
	await expect(row(page, id).getByTestId("session-archived-badge")).toHaveCount(
		0,
	);
	await page.screenshot({ path: testInfo.outputPath("unarchived.png") });
});

test("the sweep archives old settled sessions once and leaves restored activity alone", async ({
	page,
	relayUrl,
	harness,
}, testInfo) => {
	const id = decodeURIComponent(harness.projectUrl.slice(3));
	await gotoRelay(page, relayUrl);
	await expect(row(page, id)).toBeVisible();
	const title = (
		await row(page, id).locator(".session-title-inner").innerText()
	).trim();
	await row(page, id).click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	const old = Date.now() - 31 * 86_400_000;
	const db = new Database(harness.eventsDbPath);
	try {
		db.prepare(
			"UPDATE sessions SET last_message_at = ?, settled_at = ? WHERE id = ?",
		).run(old, old, id);
		db.prepare("UPDATE messages SET created_at = ? WHERE session_id = ?").run(
			old,
			id,
		);
		db.prepare(
			"UPDATE turns SET requested_at = ?, started_at = ?, completed_at = ? WHERE session_id = ?",
		).run(old, old, old, id);
	} finally {
		db.close();
	}
	expect(
		await Effect.runPromise(
			harness.stack.archiveIdleSessions(30 * 86_400_000, Date.now()),
		),
	).toBe(1);
	expect(
		await Effect.runPromise(
			harness.stack.archiveIdleSessions(30 * 86_400_000, Date.now()),
		),
	).toBe(0);
	await expect(page.getByTestId("settled-shelf-toggle")).toHaveCount(0);
	expect(
		(await browse(harness, title, true)).sessions.find(
			(session) => session.id === id,
		)?.archivedAt,
	).toEqual(expect.any(Number));
	await new AppPage(page).sendMessage("Return to this old conversation");
	await expect(row(page, id)).toBeVisible();
	expect(
		await Effect.runPromise(
			harness.stack.archiveIdleSessions(30 * 86_400_000, Date.now()),
		),
	).toBe(0);
	await page.screenshot({
		path: testInfo.outputPath("automatic-archive-restored.png"),
	});
});
