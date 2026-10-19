import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { openComposerSheet } from "../helpers/model-picker.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

// The checkout labels the main folder's basename; a long one stresses the composer.
const folderName = "conduit-project-with-a-long-name";
const project: ProjectInfo = {
	slug: "e2e-replay",
	title: "Conduit",
	folders: [`/work/${folderName}`],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Keep the replay relay for the session; replace only the shell feed's project list.
async function supplyProject(
	page: Page,
	git?: ProjectInfo["git"],
): Promise<void> {
	const projects = [{ ...project, ...(git ? { git } : {}) }];
	await page.routeWebSocket(/\/rpc$/, (ws) => {
		const server = ws.connectToServer();
		const shellRequests = new Set<string>();
		ws.onMessage((message) => {
			if (typeof message === "string") {
				const raw: unknown = JSON.parse(message);
				for (const frame of Array.isArray(raw) ? raw : [raw])
					if (
						isRecord(frame) &&
						frame["_tag"] === "Request" &&
						frame["tag"] === "SubscribeShell"
					)
						shellRequests.add(String(frame["id"]));
			}
			server.send(message);
		});
		server.onMessage((message) => {
			if (typeof message !== "string") {
				ws.send(message);
				return;
			}
			const replace = (frame: unknown): unknown =>
				isRecord(frame) &&
				frame["_tag"] === "Chunk" &&
				shellRequests.has(String(frame["requestId"])) &&
				Array.isArray(frame["values"])
					? {
							...frame,
							values: frame["values"].map((value: unknown) =>
								isRecord(value) && value["_tag"] === "projects"
									? { ...value, projects }
									: value,
							),
						}
					: frame;
			const raw: unknown = JSON.parse(message);
			ws.send(
				JSON.stringify(Array.isArray(raw) ? raw.map(replace) : replace(raw)),
			);
		});
	});
}

// The relay reads real git for its folder; a non-git folder keeps the mocked project git in charge.
test.use({
	recording: "chat-simple",
	screenshot: "off",
	projectDir: mkdtempSync(join(tmpdir(), "git-identity-")),
});

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			"conduit-composer-preferences",
			JSON.stringify({ controls: "words" }),
		);
	});
});

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 320, height: 640 },
]) {
	test(`phone checkout lives in the Composer sheet at ${viewport.width}px`, async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize(viewport);
		await supplyProject(page, {
			branch: "feature/git",
			worktree: "linked-17xt",
			dirty: true,
		});
		await gotoRelay(page, relayUrl);

		// The phone Words row omits the checkout; the Composer sheet carries it.
		await expect(
			page.getByTestId("composer-words-sheet-trigger"),
		).toBeVisible();
		await expect(page.getByTestId("composer-checkout")).toHaveCount(0);
		await openComposerSheet(page);
		const sheet = page.getByTestId("composer-more-sheet");
		const checkout = sheet.getByTestId("composer-checkout");
		await expect(checkout.locator('[data-part="project"]')).toHaveText(
			folderName,
		);
		await expect(checkout).toContainText("feature/git");
		// A linked worktree shows its icon; the name lives in the checkout details.
		await expect(
			checkout.locator('[data-part="worktree"][data-icon="worktree"] svg'),
		).toBeVisible();
		await expect(checkout).not.toContainText("linked-17xt");
		await expect(
			page
				.getByTestId("session-bar")
				.getByRole("button", { name: /^Checkout:/ }),
		).toHaveCount(0);
		const checkoutBox = await checkout.boundingBox();
		const sheetBox = await sheet.boundingBox();
		expect(checkoutBox).not.toBeNull();
		expect(sheetBox).not.toBeNull();
		if (!checkoutBox || !sheetBox) throw new Error("Sheet checkout missing");
		expect(checkoutBox.x).toBeGreaterThanOrEqual(sheetBox.x);
		expect(checkoutBox.x + checkoutBox.width).toBeLessThanOrEqual(
			sheetBox.x + sheetBox.width,
		);
		for (const part of ["project", "branch"]) {
			const height = await checkout
				.locator(`[data-part="${part}"]`)
				.evaluate((element) => ({
					actual: element.getBoundingClientRect().height,
					line: Number.parseFloat(getComputedStyle(element).lineHeight),
				}));
			expect(height.actual).toBeLessThanOrEqual(height.line + 1);
		}
		const branch = checkout.locator('[title="Branch: feature/git"]');
		await expect(branch).toBeVisible();
		const dirty = checkout.locator('[title="Uncommitted changes"]');
		await expect(dirty).toBeVisible();
		await expect(dirty).toHaveText("Uncommitted changes");
		await expect(dirty.locator(".sr-only")).toHaveText("Uncommitted changes");
	});
}

test("a project without git shows only its folder name", async ({
	page,
	relayUrl,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await supplyProject(page);
	await gotoRelay(page, relayUrl);
	await openComposerSheet(page);
	const checkout = page
		.getByTestId("composer-more-sheet")
		.getByTestId("composer-checkout");
	await expect(checkout.locator('[data-part="value"]')).toHaveText(folderName);
	await expect(checkout.locator('[data-icon="folder"] svg')).toBeVisible();
	await expect(checkout.locator('[title="Uncommitted changes"]')).toHaveCount(
		0,
	);
});
