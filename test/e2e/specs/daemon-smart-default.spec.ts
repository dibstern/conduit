// ─── Daemon Smart Default E2E Tests ──────────────────────────────────────────
// Full integration tests for the smart default instance detection.
// Creates a Daemon WITHOUT an explicit opencodeUrl — it must auto-detect
// the running OpenCode instance at localhost:4096 via probeOpenCode().
//
// Verifies:
// - With smartDefault=true and no opencodeUrl, daemon probes localhost:4096
// - Probe succeeds → creates unmanaged "Default" instance on port 4096
// - Instance becomes healthy (auth-aware health check works)
// - Browser can connect and use the relay normally
//
// Requires:
//   - OpenCode running at localhost:4096
//   - OPENCODE_SERVER_PASSWORD set
//   - Project built (`pnpm run build`)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect } from "@playwright/test";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
import { isOpenCodeReachable } from "../helpers/daemon-harness.js";

interface SmartDaemonInfo {
	daemon: Daemon;
	port: number;
	baseUrl: string;
	projectUrl: string;
}

// Worker-scoped fixture: one daemon per worker
const test = base.extend<
	{ isNarrow: boolean },
	{ smartDaemon: SmartDaemonInfo; smartDaemonProjectUrl: string }
>({
	smartDaemon: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
		async ({}, use) => {
			const available = await isOpenCodeReachable();
			if (!available) {
				throw new Error(
					"OpenCode is not running at http://localhost:4096. Start it with: opencode serve",
				);
			}
			if (!process.env["OPENCODE_SERVER_PASSWORD"]) {
				throw new Error(
					"OPENCODE_SERVER_PASSWORD is not set. Required for daemon health checks.",
				);
			}

			const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");
			const tmpDir = mkdtempSync(join(tmpdir(), "e2e-smart-default-"));

			// KEY: no opencodeUrl, smartDefault: true (the default)
			const daemon = new Daemon({
				port: 0,
				host: "127.0.0.1",
				configDir: tmpDir,
				socketPath: join(tmpDir, "relay.sock"),
				pidPath: join(tmpDir, "daemon.pid"),
				logPath: join(tmpDir, "daemon.log"),
				staticDir,
				// No opencodeUrl! Smart default should auto-detect.
			});

			await daemon.start();

			// Register a project so we have a route
			const project = await daemon.addProject(process.cwd());
			const port = daemon.port;
			const baseUrl = `http://127.0.0.1:${port}`;
			const projectUrl = `${baseUrl}/p/${project.slug}/`;

			// Wait for the default instance to become healthy
			const start = Date.now();
			const timeout = 15_000;
			while (Date.now() - start < timeout) {
				const instances = daemon.getInstances();
				if (instances.some((i) => i.status === "healthy")) break;
				await new Promise((r) => setTimeout(r, 250));
			}

			await use({ daemon, port, baseUrl, projectUrl });

			await daemon.stop();
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
		{ scope: "worker", timeout: 30_000 },
	],

	smartDaemonProjectUrl: [
		async ({ smartDaemon }, use) => {
			await use(smartDaemon.projectUrl);
		},
		{ scope: "worker" },
	],

	isNarrow: async ({ page }, use) => {
		const viewport = page.viewportSize();
		await use(viewport ? viewport.width < 769 : false);
	},
});

test.describe("Smart Default Detection", () => {
	test("auto-detects running OpenCode and creates unmanaged default instance", async ({
		smartDaemon,
	}) => {
		const { daemon } = smartDaemon;
		const instances = daemon.getInstances();

		// Should have exactly one "default" instance
		const defaultInst = instances.find((i) => i.id === "default");
		expect(defaultInst).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(defaultInst!.name).toBe("Default");

		// Should be unmanaged (connected to existing OpenCode, not spawned)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(defaultInst!.managed).toBe(false);

		// Should be on port 4096 (the default OpenCode port)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(defaultInst!.port).toBe(4096);

		// Should be healthy (auth-aware health check passed)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(defaultInst!.status).toBe("healthy");
	});

	test("browser connects to smart-default daemon and receives instance_list", async ({
		page,
		smartDaemonProjectUrl,
	}) => {
		await page.goto(smartDaemonProjectUrl);

		// SPA should load
		await expect(page).toHaveTitle("OpenCode Relay", { timeout: 10_000 });

		// Connect overlay should disappear
		await page.locator(".connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		// No "No healthy OpenCode instances" banner
		const banner = page.locator(".banner-text", {
			hasText: "No healthy OpenCode instances",
		});
		await expect(banner).not.toBeVisible({ timeout: 5_000 });

		// Chat input should be visible — full pipeline works
		await expect(page.locator("#input")).toBeVisible({ timeout: 5_000 });
	});
});
