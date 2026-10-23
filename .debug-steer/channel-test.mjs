// [DEBUG-st33r] Throwaway: prove the /__debug-st33r report channel reaches daemon.log.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { chromium } from "@playwright/test";

const base = "http://localhost:2633";
const pin = readFileSync(
	`${homedir()}/.config/conduit/.probe-pin`,
	"utf8",
).trim();
const browser = await chromium.launch();
const context = await browser.newContext();
await context.request.post(`${base}/auth`, { data: { pin } });
const page = await context.newPage();
await page.goto(`${base}/new`);
await page.evaluate(() => {
	const s = new WebSocket(
		`${location.origin.replace(/^http/, "ws")}/__debug-st33r?d=channel-test`,
	);
	s.onerror = () => {};
});
await page.waitForTimeout(1500);
await browser.close();
