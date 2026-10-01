// ─── Daemon Smart Default E2E Tests ──────────────────────────────────────────
// Full integration tests for the smart default instance detection.
// Creates a daemon WITHOUT an explicit opencodeUrl — it must auto-detect
// the default OpenCode instance via probeOpenCode().
//
// Verifies:
// - With smartDefault=true and no opencodeUrl, daemon probes the smart
//   default URL (pointed at OPENCODE_URL here; http://localhost:4096 in prod).
// - Probe succeeds → creates unmanaged "Default" instance on that port.
// - Instance becomes healthy (auth-aware health check works)
// - Browser can connect and use the relay normally
//
// Requires:
//   - OPENCODE_URL set to a disposable OpenCode server. There is no fallback
//     to localhost:4096: that is usually someone's live instance.
//   - OPENCODE_SERVER_PASSWORD set
//   - Project built (`pnpm run build`)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect } from "@playwright/test";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { isOpenCodeReachable } from "../helpers/daemon-harness.js";

const SMART_DEFAULT_OPENCODE_URL = process.env["OPENCODE_URL"];

interface SmartDaemonInfo {
	daemon: ForegroundDaemonHandle;
	port: number;
	baseUrl: string;
	projectUrl: string;
}

const test = base.extend<{
	isNarrow: boolean;
	smartDaemon: SmartDaemonInfo;
	smartDaemonProjectUrl: string;
}>({
	smartDaemon: async ({ browserName: _browserName }, use, testInfo) => {
		if (!SMART_DEFAULT_OPENCODE_URL) {
			testInfo.skip(true, "OPENCODE_URL is not set");
			return;
		}
		const available = await isOpenCodeReachable(SMART_DEFAULT_OPENCODE_URL);
		if (!available) {
			testInfo.skip(
				true,
				`OpenCode is not running at ${SMART_DEFAULT_OPENCODE_URL}`,
			);
			return;
		}
		if (!process.env["OPENCODE_SERVER_PASSWORD"]) {
			testInfo.skip(true, "OPENCODE_SERVER_PASSWORD is not set");
			return;
		}

		const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");
		const tmpDir = mkdtempSync(join(tmpdir(), "e2e-smart-default-"));

		// KEY: no opencodeUrl, smartDefault: true (the default)
		const daemon = await startForegroundDaemon({
			port: 0,
			host: "127.0.0.1",
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			staticDir,
			logLevel: "error",
			// No opencodeUrl! Smart default should auto-detect.
			smartDefaultUrl: SMART_DEFAULT_OPENCODE_URL,
		});

		// Register a project so we have a route
		const project = await daemon.addProject(process.cwd());
		const port = daemon.port;
		const baseUrl = `http://127.0.0.1:${port}`;
		const projectUrl = `${baseUrl}/?p=${encodeURIComponent(project.slug)}`;

		// Wait for the default instance to become healthy
		const start = Date.now();
		const timeout = 15_000;
		while (Date.now() - start < timeout) {
			const instances = daemon.getInstances();
			if (instances.some((i: { status: string }) => i.status === "healthy"))
				break;
			await new Promise((r) => setTimeout(r, 250));
		}

		try {
			await use({ daemon, port, baseUrl, projectUrl });
		} finally {
			await daemon.stop();
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	},

	smartDaemonProjectUrl: async ({ smartDaemon }, use) => {
		await use(smartDaemon.projectUrl);
	},

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

		// Should have exactly one "opencode" instance
		const defaultInst = instances.find(
			(i: { id: string }) => i.id === "opencode",
		);
		expect(defaultInst).toBeDefined();
		if (!defaultInst) throw new Error("expected default instance");
		expect(defaultInst.name).toBe("Default");

		// Should be unmanaged (connected to existing OpenCode, not spawned)
		expect(defaultInst.managed).toBe(false);

		// Should be on the port smart default probed
		expect(defaultInst.port).toBe(
			Number(new URL(SMART_DEFAULT_OPENCODE_URL ?? "").port),
		);

		// Should be healthy (auth-aware health check passed)
		expect(defaultInst.status).toBe("healthy");
	});

	test("browser connects to smart-default daemon and receives instance_list", async ({
		page,
		smartDaemonProjectUrl,
		isNarrow,
	}) => {
		await page.goto(smartDaemonProjectUrl);

		// SPA should load
		await expect(page).toHaveTitle("Conduit", { timeout: 10_000 });

		// Connect overlay unmounts once connected (a phone's list route hides
		// it, so "hidden" would not prove the socket connected)
		await page.locator(".connect-overlay").waitFor({
			state: "detached",
			timeout: 15_000,
		});

		// No "No healthy OpenCode instances" banner
		const banner = page.locator(".banner-text", {
			hasText: "No healthy OpenCode instances",
		});
		await expect(banner).not.toBeVisible({ timeout: 5_000 });

		// Full pipeline works. On a phone `/` is the session list screen and the
		// chat input lives at /s/<id> (d9da0776), so check the list.
		await expect(
			page.locator(isNarrow ? "#sidebar-panel-sessions" : "#input"),
		).toBeVisible({ timeout: 5_000 });
	});
});
