import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

async function openPane(page: Page, relayUrl: string) {
	await new AppPage(page).goto(relayUrl);
	const files = page.getByTestId("views-rail-files");
	await files.click();
	const pane = page.getByTestId("side-pane-files");
	await expect(pane).toBeVisible();
	return {
		files,
		pane,
		divider: page.getByRole("separator", { name: "Resize Files pane" }),
	};
}

async function failFileContentRpc(page: Page) {
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
			const request = frame as { _tag?: string; tag?: string; id?: string };
			if (
				request._tag !== "Request" ||
				request.tag !== "GetFileContent" ||
				!request.id
			) {
				server.send(message);
				return;
			}
			ws.send(
				JSON.stringify({ _tag: "Defect", defect: "Preview unavailable" }),
			);
		});
	});
}

test("Files opens between chat and rail without horizontal overflow", async ({
	page,
	relayUrl,
}) => {
	const { files, pane, divider } = await openPane(page, relayUrl);
	const rail = page.getByTestId("views-rail");
	const chat = await page.locator("#messages").boundingBox();
	const split = await divider.boundingBox();
	const side = await pane.boundingBox();
	const right = await rail.boundingBox();
	expect(chat && split && side && right).toBeTruthy();
	if (!chat || !split || !side || !right) return;
	expect(chat.x + chat.width).toBeLessThanOrEqual(split.x + 1);
	expect(split.x + split.width).toBeLessThanOrEqual(side.x + 1);
	expect(side.x + side.width).toBeLessThanOrEqual(right.x + 1);
	expect(right.x + right.width).toBeLessThanOrEqual(1440);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(1440);
	await expect(files).toHaveAttribute("aria-pressed", "true");
});

test("divider pointer and keyboard controls resize and clamp both columns", async ({
	page,
	relayUrl,
}) => {
	const { divider, pane } = await openPane(page, relayUrl);
	const initial = await divider.boundingBox();
	expect(initial).toBeTruthy();
	if (!initial) return;
	await page.mouse.move(initial.x + initial.width / 2, initial.y + 70);
	await page.mouse.down();
	await page.mouse.move(initial.x + 500, initial.y + 70);
	await page.mouse.up();
	await expect(divider).toHaveAttribute("aria-valuenow", "280");
	await divider.focus();
	await divider.press("ArrowLeft");
	await expect(divider).toHaveAttribute("aria-valuenow", "296");
	await divider.press("ArrowRight");
	await expect(divider).toHaveAttribute("aria-valuenow", "280");
	await divider.press("End");
	const max = Number(await divider.getAttribute("aria-valuemax"));
	await expect(divider).toHaveAttribute("aria-valuenow", String(max));
	expect(
		(await page.locator("#messages").boundingBox())?.width ?? 0,
	).toBeGreaterThanOrEqual(360);
	const atMax = await divider.boundingBox();
	expect(atMax).toBeTruthy();
	if (!atMax) return;
	await page.mouse.move(atMax.x + atMax.width / 2, atMax.y + 70);
	await page.mouse.down();
	await page.mouse.move(0, atMax.y + 70);
	await page.mouse.up();
	await expect(divider).toHaveAttribute("aria-valuenow", String(max));
	await divider.press("Home");
	await expect(divider).toHaveAttribute("aria-valuenow", "280");
	expect((await pane.boundingBox())?.width).toBe(280);
});

test("expand restores split width and focus; close returns focus to Files", async ({
	page,
	relayUrl,
}) => {
	const { files, divider } = await openPane(page, relayUrl);
	await divider.press("Home");
	await divider.press("ArrowLeft");
	const width = await divider.getAttribute("aria-valuenow");
	const expand = page.locator("#files-pane-expand");
	await expand.click();
	await expect(expand).toHaveAttribute("aria-pressed", "true");
	await expect(expand).toBeFocused();
	await expect(page.locator("#messages")).toBeHidden();
	await expect(
		page.locator("#messages").locator("xpath=ancestor::*[@inert][1]"),
	).toHaveCount(1);
	await expect(divider).toHaveCount(0);
	await expand.click();
	await expect(expand).toBeFocused();
	await expect(expand).toHaveAttribute("aria-pressed", "false");
	await expect(divider).toHaveAttribute("aria-valuenow", width ?? "");
	await page.getByRole("button", { name: "Close Files pane" }).click();
	await expect(files).toHaveAttribute("aria-pressed", "false");
	await expect(files).toBeFocused();
});

test("800px forces expansion without changing the saved split", async ({
	page,
	relayUrl,
}) => {
	const { divider } = await openPane(page, relayUrl);
	await divider.press("Home");
	await divider.press("ArrowLeft");
	const width = await divider.getAttribute("aria-valuenow");
	await page.setViewportSize({ width: 800, height: 900 });
	const expand = page.locator("#files-pane-expand");
	await expect(expand).toBeDisabled();
	await expect(expand).toHaveAttribute(
		"aria-label",
		"Not enough room to show chat beside Files",
	);
	await expect(page.locator("#messages")).toBeHidden();
	await expect(page.getByTestId("views-rail")).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(800);
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(expand).toBeEnabled();
	await expect(divider).toHaveAttribute("aria-valuenow", width ?? "");
});

test("width and open state survive reload only for their session", async ({
	page,
	relayUrl,
}) => {
	const { files, divider } = await openPane(page, relayUrl);
	const firstUrl = page.url();
	await divider.press("Home");
	await divider.press("ArrowLeft");
	await page.reload();
	await expect(files).toHaveAttribute("aria-pressed", "true");
	await expect(divider).toHaveAttribute("aria-valuenow", "296");
	await new SidebarPage(page).createNewSession();
	await expect(page).not.toHaveURL(firstUrl);
	await expect(files).toHaveAttribute("aria-pressed", "false");
	await page.goto(firstUrl);
	await expect(files).toHaveAttribute("aria-pressed", "true");
	await expect(divider).toHaveAttribute("aria-valuenow", "296");
});

test("preview shows a path chip and File browser restores the tree", async ({
	page,
	relayUrl,
}) => {
	const { pane } = await openPane(page, relayUrl);
	await pane.locator(".fb-entry:not([aria-expanded])").first().click();
	await expect(pane.locator("#file-viewer")).toBeVisible();
	const path = (await pane.locator("#file-viewer-path").textContent())?.trim();
	await expect(pane.locator("#files-pane-title + span[title]")).toHaveAttribute(
		"title",
		path ?? "",
	);
	await pane.getByRole("button", { name: "File browser" }).click();
	await expect(pane.locator("#file-tree")).toBeVisible();
	await expect(pane.locator("#files-pane-title + span[title]")).toHaveCount(0);
});

test("failed content RPC shows an inline alert and tree navigation", async ({
	page,
	relayUrl,
}) => {
	await failFileContentRpc(page);
	const { pane } = await openPane(page, relayUrl);
	await pane.locator(".fb-entry:not([aria-expanded])").first().click();
	await expect(pane.getByRole("alert")).toContainText(
		"Failed to load file preview",
	);
	await expect(pane.getByText("Loading…")).toHaveCount(0);
	await pane.getByRole("button", { name: "File browser" }).click();
	await expect(pane.locator("#file-tree")).toBeVisible();
});

test("1000px chat keeps send and model picker inside the viewport", async ({
	page,
	relayUrl,
}) => {
	await openPane(page, relayUrl);
	await page.setViewportSize({ width: 1000, height: 900 });
	const chat = await page.locator("#messages").boundingBox();
	const send = await page.locator("#send").boundingBox();
	expect(chat && send).toBeTruthy();
	if (!chat || !send) return;
	expect(send.x + send.width).toBeLessThanOrEqual(chat.x + chat.width + 1);
	await page.getByTestId("model-picker-trigger").click();
	const picker = await page.getByTestId("model-picker").boundingBox();
	expect(picker).toBeTruthy();
	if (!picker) return;
	expect(picker.x).toBeGreaterThanOrEqual(0);
	expect(picker.x + picker.width).toBeLessThanOrEqual(1000);
});

test.describe("reading position", () => {
	test.use({ recording: "chat-code-block" });
	test("opening and closing Files keeps scrollTop within 2px with a replayed transcript", async ({
		page,
		relayUrl,
	}) => {
		test.setTimeout(60_000);
		const app = new AppPage(page);
		await app.goto(relayUrl);
		await app.sendMessage("Show the code block");
		await expect(page.locator("#messages pre code").first()).toBeVisible();
		// Constrain the real transcript so this short recording has a reading position.
		await app.messages.evaluate((el) => {
			el.style.maxHeight = "200px";
		});
		await expect
			.poll(() =>
				app.messages.evaluate((el) => el.scrollHeight - el.clientHeight),
			)
			.toBeGreaterThan(100);
		await app.messages.evaluate((el) => {
			el.scrollTop = 100;
		});
		const before = await app.messages.evaluate((el) => el.scrollTop);
		expect(before).toBeGreaterThan(0);
		await page.getByTestId("views-rail-files").click();
		await expect(page.getByTestId("side-pane-files")).toBeVisible();
		await expect
			.poll(async () =>
				Math.abs((await app.messages.evaluate((el) => el.scrollTop)) - before),
			)
			.toBeLessThanOrEqual(2);
		await page.getByTestId("views-rail-files").click();
		await expect
			.poll(async () =>
				Math.abs((await app.messages.evaluate((el) => el.scrollTop)) - before),
			)
			.toBeLessThanOrEqual(2);
	});
});
