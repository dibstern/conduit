// [DEBUG-st33r] Throwaway probe: open a session in headless Chromium against the
// live daemon and report what the composer believes about steering.
// Usage: node .debug-steer/ui-probe.mjs <sessionId>   (PIN read from ~/.config/conduit/.probe-pin)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { chromium } from "@playwright/test";

const base = process.env.PROBE_BASE ?? "http://localhost:2633";
const sessionId = process.argv[2] ?? "ses_1b665655521b48589b30dc8e7c921974";
const pin = readFileSync(
	`${homedir()}/.config/conduit/.probe-pin`,
	"utf8",
).trim();

const browser = await chromium.launch();
const context = await browser.newContext();
const auth = await context.request.post(`${base}/auth`, { data: { pin } });
console.log(`[DEBUG-st33r] auth ${auth.status()}`);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
	if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
await page.goto(`${base}/s/${sessionId}`);
await page.locator("#input").waitFor({ timeout: 20_000 });
await page.waitForTimeout(Number(process.env.PROBE_SETTLE_MS ?? 5000));

const report = await page.evaluate(async () => {
	const rows = [
		...document.querySelectorAll('[data-testid="pending-input-row"]'),
	].map((row) => ({
		text: row.querySelector('[data-testid="pending-input-text"]')?.textContent,
		state: row.querySelector('[data-testid="pending-input-state"]')
			?.textContent,
		steerButton:
			row.querySelector('[data-testid="pending-input-steer"]') !== null,
	}));
	const stop = document.querySelector("#stop") !== null;
	// The send button's tooltip names steering only when the composer's steer flag is set.
	// A draft is needed for send to show while working; it lives ~50ms (sync debounce is 300ms).
	const input = document.querySelector("#input");
	let sendTitle = null;
	if (input instanceof HTMLTextAreaElement && input.value === "") {
		const set = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		).set;
		set.call(input, "x");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 50));
		sendTitle =
			document.querySelector("#send")?.getAttribute("title") ?? "(no #send)";
		set.call(input, "");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	return { stop, rows, sendTitle };
});
console.log(`[DEBUG-st33r] ${JSON.stringify(report)}`);
if (consoleErrors.length)
	console.log(
		`[DEBUG-st33r] consoleErrors ${JSON.stringify(consoleErrors.slice(0, 5))}`,
	);
await page.waitForTimeout(500);
await browser.close();
