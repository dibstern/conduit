// [DEBUG-st33r] Throwaway repro: in one headless tab, start a turn in a scratch
// session (idle -> busy), queue "Continue", and report whether its row has Steer.
// Exit 1 (red) when the queued row has no Steer while the turn runs.
// Usage: node .debug-steer/ui-repro.mjs [sessionId]   (no id = new scratch session via /new)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { chromium, devices } from "@playwright/test";

const base = process.env.PROBE_BASE ?? "http://localhost:2633";
const existing = process.argv[2];
const pin = readFileSync(
	`${homedir()}/.config/conduit/.probe-pin`,
	"utf8",
).trim();

const browser = await chromium.launch();
const context = await browser.newContext(
	process.env.PROBE_PHONE
		? { ...devices["iPhone 15"], defaultBrowserType: undefined }
		: { viewport: { width: 1400, height: 900 } },
);
await context.request.post(`${base}/auth`, { data: { pin } });
// Keep every socket the app opens so the probe can drop them like a daemon restart would.
await context.addInitScript(() => {
	const Native = window.WebSocket;
	window.__probeSockets = [];
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args);
			window.__probeSockets.push(this);
		}
	};
});
const dropSockets = async (label) => {
	const n = await page.evaluate(() => {
		const open = window.__probeSockets.filter((s) => s.readyState === 1);
		for (const s of open) s.close(4000, "probe");
		return open.length;
	});
	console.log(`[DEBUG-st33r] dropped ${n} sockets (${label})`);
	await page.waitForTimeout(Number(process.env.PROBE_RECONNECT_MS ?? 4000));
};
const page = await context.newPage();
const frames = [];
const tStart = Date.now();
page.on("websocket", (ws) =>
	ws.on("framereceived", ({ payload }) => {
		const text = typeof payload === "string" ? payload : payload.toString();
		for (const m of text.matchAll(/\{"_tag":"inbox","inbox":\{[^}]*\}\}/g))
			frames.push(`${Date.now() - tStart}ms ${m[0]}`);
	}),
);
const from = process.env.PROBE_FROM;
await page.goto(
	from
		? `${base}/s/${from}`
		: existing
			? `${base}/s/${existing}`
			: `${base}/new`,
);
const input = page.locator("#input");
await input.waitFor({ timeout: 20_000 });
if (from && existing) {
	// Arrive the way a user does: open another session, then click this one in the sidebar.
	await page.waitForTimeout(3000);
	await page
		.locator(`#session-list .session-item[data-session-id="${existing}"]`)
		.click({ position: { x: 60, y: 12 } });
	await page.waitForFunction((id) => location.pathname.includes(id), existing, {
		timeout: 10_000,
	});
	console.log("[DEBUG-st33r] switched via sidebar");
}
await page.waitForTimeout(Number(process.env.PROBE_SETTLE_MS ?? 3000));

if (process.env.PROBE_RELOAD) {
	// Like a build reload: the page reopens this session from its saved copy.
	await page.reload();
	await input.waitFor({ timeout: 20_000 });
	await page.waitForTimeout(Number(process.env.PROBE_SETTLE_MS ?? 3000));
	console.log("[DEBUG-st33r] reloaded");
}

if (process.env.PROBE_DROP_WS === "idle") await dropSockets("idle");

// The draft defaults to a paused account; pick the one the user's session ran on.
if (!existing) {
	await page.getByTestId("model-picker-trigger").first().click();
	await page.getByTestId("picker-back").click();
	await page
		.getByTestId("picker-account-name")
		.filter({ hasText: process.env.PROBE_ACCOUNT ?? "Claude 2" })
		.click();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
}

await input.fill(
	process.env.PROBE_PROMPT ??
		"[conduit steer probe] Run the shell command `sleep 45` with your Bash tool, then reply with just: done",
);
await page.locator("#send").click();
await page.locator("#stop").waitFor({ timeout: 30_000 });
console.log(`[DEBUG-st33r] busy at ${new URL(page.url()).pathname}`);

if (process.env.PROBE_DROP_WS === "busy") await dropSockets("busy");
if (process.env.PROBE_EFFORT_SWITCH) {
	// The user's distinctive step: effort changed mid-turn, before queueing.
	await input.focus();
	await page.keyboard.press("Control+t");
	await page.waitForTimeout(1500);
	console.log(
		`[DEBUG-st33r] effort now ${await page.getByTestId("variant-badge").first().getAttribute("title")}`,
	);
}
await input.fill("Continue");
if (process.env.PROBE_PHONE) await page.locator("#send").click();
else await input.press("Enter");
const row = page.getByTestId("pending-input-row");
await row.first().waitFor({ timeout: 10_000 });
// The user's restart came after "Continue" was queued: replay that order.
if (process.env.PROBE_AFTER_QUEUE === "drop") await dropSockets("after queue");
if (process.env.PROBE_AFTER_QUEUE === "restart") {
	// A real daemon restart: a build writes build-ready.json, which dev.mjs watches.
	const { spawnSync } = await import("node:child_process");
	const build = spawnSync("pnpm", ["build"], {
		input: "",
		stdio: ["pipe", "ignore", "ignore"],
		env: {
			...process.env,
			npm_config_verify_deps_before_run: "false",
			pnpm_config_verify_deps_before_run: "false",
		},
	});
	console.log(
		`[DEBUG-st33r] build rc=${build.status} at ${Date.now() - tStart}ms`,
	);
}
if (process.env.PROBE_AFTER_QUEUE === "reload") {
	await page.reload();
	await row.first().waitFor({ timeout: 20_000 });
	console.log("[DEBUG-st33r] reloaded after queue");
}

const t0 = Date.now();
const samples = [];
for (let i = 0; i < Number(process.env.PROBE_SAMPLES ?? 60); i++) {
	samples.push(
		await page
			.evaluate(() => ({
				stop: document.querySelector("#stop") !== null,
				queued: [
					...document.querySelectorAll('[data-testid="pending-input-row"]'),
				].filter(
					(r) =>
						r.querySelector('[data-testid="pending-input-state"]')
							?.textContent === "Queued",
				).length,
				steer: document.querySelectorAll('[data-testid="pending-input-steer"]')
					.length,
			}))
			.catch(() => ({ stop: false, queued: -1, steer: -1 }))
			.then((s) => ({ ...s, ms: Date.now() - t0 })),
	);
	const cur = samples.at(-1);
	const prev = samples.at(-2);
	if (
		!prev ||
		prev.stop !== cur.stop ||
		prev.queued !== cur.queued ||
		prev.steer !== cur.steer
	)
		console.log(`[DEBUG-st33r] t=${cur.ms}ms ${JSON.stringify(cur)}`);
	await page.waitForTimeout(100);
}
const missing = samples.filter((s) => s.stop && s.queued > 0 && s.steer === 0);
const firstSteer = samples.find((s) => s.steer > 0)?.ms ?? "never";
console.log(
	`[DEBUG-st33r] steer missing in ${missing.length}/${samples.length} samples; first steer at ${firstSteer}ms; last missing at ${missing.at(-1)?.ms ?? "-"}ms`,
);
// A row can render a frame before its Steer; only a gap longer than a second is the bug.
const red = missing.length >= 10;
console.log(`[DEBUG-st33r] inbox frames ${JSON.stringify(frames.slice(-8))}`);
console.log(
	`[DEBUG-st33r] verdict ${red ? "RED: queued row without Steer while working" : "GREEN: Steer shown"}`,
);

// Leave the scratch session idle: remove the queued input, then stop the turn.
const remove = page.getByTestId("pending-input-remove");
if (await remove.count()) await remove.first().click();
if (await page.locator("#stop").count()) await page.locator("#stop").click();
await page.waitForTimeout(1500);
await browser.close();
process.exit(red ? 1 : 0);
