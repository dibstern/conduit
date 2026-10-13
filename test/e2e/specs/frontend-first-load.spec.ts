import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { devices } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({ recording: "chat-simple" });

test("cold mobile first paint records the entry bundle and requests", async ({
	browser,
	relayUrl,
}, testInfo) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		serviceWorkers: "block",
	});
	await context.tracing.start({ screenshots: true, snapshots: true });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
	await cdp.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 150,
		downloadThroughput: 1_250_000,
		uploadThroughput: 625_000,
	});
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	const requests: string[] = [];
	page.on("request", (request) => requests.push(request.url()));
	try {
		await gotoRelay(page, relayUrl);
		const paint = await page.evaluate(() => ({
			fcpMs: performance.getEntriesByName("first-contentful-paint")[0]
				?.startTime,
			entry: document.querySelector<HTMLScriptElement>('script[type="module"]')
				?.src,
		}));
		if (!paint.entry) throw new Error("Missing entry script");
		const entry = readFileSync(
			join("dist/frontend/assets", basename(new URL(paint.entry).pathname)),
		);
		await testInfo.attach("first-load-report", {
			body: JSON.stringify(
				{
					...paint,
					entryBytes: entry.byteLength,
					entryGzipBytes: gzipSync(entry).byteLength,
					requests,
				},
				null,
				2,
			),
			contentType: "application/json",
		});
		expect(paint.fcpMs).toBeGreaterThan(0);
		expect(
			requests.filter((url) => new URL(url).hostname === "cdn.jsdelivr.net"),
		).toEqual([]);
	} finally {
		const trace = testInfo.outputPath("first-load-trace.zip");
		await context.tracing.stop({ path: trace });
		await testInfo.attach("first-load-trace", { path: trace });
		await context.close();
	}
});
