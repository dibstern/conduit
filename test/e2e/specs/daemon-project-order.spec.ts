// ─── Daemon Project Ordering E2E Tests ───────────────────────────────────────
// Verifies that both the Dashboard page and the sidebar ProjectSwitcher display
// projects ordered by most-recently-used (lastUsed descending). After a browser
// connects to an older project (triggering touchLastUsed via WS upgrade), that
// project should move to the top of both lists.
//
// Uses a custom daemon setup (not the shared fixture) because it needs to
// register multiple projects with staggered timestamps.
//
// Note: The daemon auto-discovers existing projects from the running OpenCode
// instance, so the test checks relative ordering of our test projects rather
// than expecting an exact list.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
import { isOpenCodeReachable } from "../helpers/daemon-harness.js";

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Small delay to guarantee distinct lastUsed timestamps between projects. */
function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Read the ordered slugs from dashboard project cards. */
async function getDashboardSlugs(
	page: import("@playwright/test").Page,
): Promise<string[]> {
	await page
		.locator("[data-testid='project-card']")
		.first()
		.waitFor({ timeout: 10_000 });
	return page
		.locator("[data-testid='project-card']")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-slug") ?? ""));
}

/** Open the ProjectSwitcher dropdown and read the ordered slugs. */
async function getSwitcherSlugs(
	page: import("@playwright/test").Page,
): Promise<string[]> {
	// On mobile, open the hamburger menu first to reveal the sidebar
	const hamburger = page.locator("#hamburger-btn");
	if (await hamburger.isVisible()) {
		await hamburger.click();
		// The sidebar slides in with a 0.25s CSS transition. Elements inside
		// pass Playwright's "visible" check immediately (non-zero bounding box
		// at negative coordinates due to overflow:visible), but remain outside
		// the viewport until the animation completes. Wait for the button's
		// bounding rect to actually be within the viewport.
		await page.waitForFunction(
			() => {
				const el = document.getElementById("project-switcher-btn");
				if (!el) return false;
				const r = el.getBoundingClientRect();
				return r.left >= 0 && r.right <= window.innerWidth;
			},
			null,
			{ timeout: 5_000 },
		);
	}

	// Click the project switcher button to open the dropdown
	await page.locator("#project-switcher-btn").click();
	await page
		.locator("[data-testid='project-switcher-dropdown']")
		.waitFor({ timeout: 5_000 });

	const slugs = await page
		.locator("[data-testid='project-item']")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-slug") ?? ""));

	// Close the dropdown by pressing Escape
	await page.keyboard.press("Escape");
	return slugs;
}

/** Extract only the test slugs (alpha, beta, gamma) preserving their relative order. */
function filterTestSlugs(allSlugs: string[]): string[] {
	const testSet = new Set(["alpha", "beta", "gamma"]);
	return allSlugs.filter((s) => testSet.has(s));
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let daemon: Daemon;
let baseUrl: string;
let tmpDir: string;
const projectDirs: string[] = [];
const testSlugs = ["alpha", "beta", "gamma"];

test.beforeAll(async () => {
	const available = await isOpenCodeReachable();
	if (!available) {
		test.skip(true, "OpenCode not running at localhost:4096");
		return;
	}
	if (!process.env["OPENCODE_SERVER_PASSWORD"]) {
		test.skip(true, "OPENCODE_SERVER_PASSWORD not set");
		return;
	}

	tmpDir = mkdtempSync(join(tmpdir(), "e2e-proj-order-"));
	const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");

	// Create temp directories for each project
	for (const slug of testSlugs) {
		const dir = join(tmpDir, slug);
		mkdirSync(dir, { recursive: true });
		projectDirs.push(dir);
	}

	daemon = new Daemon({
		port: 0,
		host: "127.0.0.1",
		configDir: join(tmpDir, "config"),
		socketPath: join(tmpDir, "relay.sock"),
		pidPath: join(tmpDir, "daemon.pid"),
		logPath: join(tmpDir, "daemon.log"),
		opencodeUrl: OPENCODE_URL,
		staticDir,
		logLevel: "error",
	});

	await daemon.start();

	// Add projects with staggered timestamps so ordering is deterministic.
	// alpha is oldest, gamma is newest.
	for (let i = 0; i < testSlugs.length; i++) {
		const dir = projectDirs[i];
		if (!dir) continue;
		await daemon.addProject(dir, testSlugs[i]);
		if (i < testSlugs.length - 1) await sleep(100);
	}

	// Wait for at least one healthy instance
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (daemon.getInstances().some((i) => i.status === "healthy")) break;
		await sleep(250);
	}

	baseUrl = `http://127.0.0.1:${daemon.port}`;
});

test.afterAll(async () => {
	if (daemon) await daemon.stop();
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("Project ordering", () => {
	test("dashboard shows projects ordered by lastUsed descending", async ({
		page,
	}) => {
		// Visit the dashboard (root URL shows multi-project view when >=2 projects)
		await page.goto(baseUrl);
		const allSlugs = await getDashboardSlugs(page);
		const order = filterTestSlugs(allSlugs);

		// gamma was added last (highest lastUsed) → first among our test projects
		// alpha was added first (lowest lastUsed) → last among our test projects
		expect(order).toEqual(["gamma", "beta", "alpha"]);

		// gamma should be the very first project overall (most recent)
		expect(allSlugs[0]).toBe("gamma");
	});

	test("visiting a project bumps it to the top of both lists", async ({
		page,
	}) => {
		// 1. Navigate to the oldest project (alpha) — WS upgrade triggers touchLastUsed
		await page.goto(`${baseUrl}/p/alpha/`);

		// Wait for WS connection to establish (connect overlay disappears)
		await page.locator(".connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		// 2. Open the ProjectSwitcher in the sidebar and verify alpha is now first
		const switcherSlugs = await getSwitcherSlugs(page);
		expect(switcherSlugs[0]).toBe("alpha");

		// 3. Navigate back to the dashboard and verify alpha is first there too
		await page.goto(baseUrl);
		const dashSlugs = await getDashboardSlugs(page);
		expect(dashSlugs[0]).toBe("alpha");
	});
});
