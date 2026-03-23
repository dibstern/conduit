// ─── Dashboard Delete E2E Tests ──────────────────────────────────────────────
// Tests project deletion from the Dashboard page via REST endpoint.
// Uses page.route() to mock the /api/projects endpoints.

import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

const DASHBOARD_URL = "/";

const MOCK_PROJECTS = [
	{
		slug: "myapp",
		path: "/src/myapp",
		title: "myapp",
		status: "ready",
		sessions: 2,
		clients: 1,
		isProcessing: false,
	},
	{
		slug: "mylib",
		path: "/src/mylib",
		title: "mylib",
		status: "ready",
		sessions: 1,
		clients: 0,
		isProcessing: false,
	},
];

/** Set up route mocks for the Dashboard's REST API. */
async function setupDashboardMocks(page: Page) {
	const projects = [...MOCK_PROJECTS];

	// Mock GET /api/projects
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ projects, version: "test" }),
			});
		} else {
			await route.continue();
		}
	});

	// Mock DELETE /api/projects/:slug
	await page.route("**/api/projects/*", async (route) => {
		if (route.request().method() === "DELETE") {
			const url = new URL(route.request().url());
			// biome-ignore lint/style/noNonNullAssertion: pathname always has segments
			const slug = url.pathname.split("/").pop()!;
			const idx = projects.findIndex((p) => p.slug === slug);
			if (idx >= 0) {
				projects.splice(idx, 1);
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ ok: true }),
				});
			} else {
				await route.fulfill({
					status: 404,
					contentType: "application/json",
					body: JSON.stringify({ error: "Not found" }),
				});
			}
		} else {
			await route.continue();
		}
	});
}

test.describe("Dashboard Project Delete", () => {
	test("project cards show a ... menu button", async ({ page, baseURL }) => {
		await setupDashboardMocks(page);
		await page.goto(baseURL + DASHBOARD_URL);

		// Wait for project cards to appear
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(2, {
			timeout: 5_000,
		});

		// Each card should have a more-options button
		const moreButtons = page.locator(
			"[data-testid='project-card'] .dash-more-btn",
		);
		await expect(moreButtons).toHaveCount(2);
	});

	test("clicking ... opens context menu with Remove", async ({
		page,
		baseURL,
	}) => {
		await setupDashboardMocks(page);
		await page.goto(baseURL + DASHBOARD_URL);
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(2, {
			timeout: 5_000,
		});

		// Click the ... button on the second project (mylib)
		const mylibCard = page.locator("[data-testid='project-card']").nth(1);
		await mylibCard.locator(".dash-more-btn").click();

		// Context menu should appear with Remove option
		const removeBtn = page.locator("button:has-text('Remove')");
		await expect(removeBtn).toBeVisible();
	});

	test("Remove shows confirmation modal and confirm sends DELETE", async ({
		page,
		baseURL,
	}) => {
		await setupDashboardMocks(page);
		await page.goto(baseURL + DASHBOARD_URL);
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(2, {
			timeout: 5_000,
		});

		// Open context menu and click Remove
		const mylibCard = page.locator("[data-testid='project-card']").nth(1);
		await mylibCard.locator(".dash-more-btn").click();
		await page.locator("button:has-text('Remove')").click();

		// Confirmation modal should appear
		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toBeVisible();
		await expect(confirmModal).toContainText("mylib");

		// Track the DELETE request
		const deletePromise = page.waitForRequest(
			(req) =>
				req.method() === "DELETE" && req.url().includes("/api/projects/mylib"),
		);

		// Confirm removal
		await page.click("#confirm-modal button:has-text('Remove')");

		// DELETE request should have been sent
		const deleteReq = await deletePromise;
		expect(deleteReq.url()).toContain("/api/projects/mylib");

		// After re-fetch, only 1 project should remain
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(1, {
			timeout: 5_000,
		});
		await expect(
			page.locator("[data-testid='project-card']").first(),
		).toContainText("myapp");
	});

	test("cancelling removal does not send DELETE", async ({ page, baseURL }) => {
		await setupDashboardMocks(page);
		await page.goto(baseURL + DASHBOARD_URL);
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(2, {
			timeout: 5_000,
		});

		// Open context menu and click Remove
		const mylibCard = page.locator("[data-testid='project-card']").nth(1);
		await mylibCard.locator(".dash-more-btn").click();
		await page.locator("button:has-text('Remove')").click();

		// Cancel
		await page.click("#confirm-modal button:has-text('Cancel')");

		// Modal should close
		await expect(page.locator("#confirm-modal")).not.toBeVisible();

		// Both projects should still be present
		await expect(page.locator("[data-testid='project-card']")).toHaveCount(2);
	});
});
