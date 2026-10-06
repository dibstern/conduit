/**
 * Long-press on iPhone Safari, driven in the iOS Simulator. Opt-in.
 *
 * Chromium cannot see this class of bug: it treats -webkit-user-select as an
 * alias of user-select and has no native text-selection hold, so every
 * Playwright lane passed while an iPhone selected text in the session action
 * sheet (conduit-test-wmzr). safaridriver delivers real UIKit touches.
 *
 * Needs Xcode with an iOS simulator runtime. safaridriver boots a simulator on
 * its own; pin one with IOS_SIMULATOR_UDID. Verified on iPhone 17e, iOS 26.5.
 *
 *   pnpm test:e2e:ios
 *
 * Artifacts: test-results/ios-long-press/ holds result.json and a screenshot
 * taken after each hold.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createReplayHarness,
	type ReplayHarness,
} from "../helpers/e2e-harness.js";

const RUN = process.env["RUN_IOS_E2E"] === "1";
const ARTIFACTS = "test-results/ios-long-press";
// Our long-press opens the sheet at 500ms and iOS starts its own
// text-selection hold at about 650ms. Hold past both, as a person does.
const HOLD_MS = 1_000;

type Point = { x: number; y: number };
type HoldResult = { held: string[]; sheetOpen: boolean };

// In-page scripts are strings: the transpiler may wrap a function's source in
// helpers that do not exist in Safari.
const ROW_POINT = `
	const row = document.querySelector("#session-list .session-item");
	if (!row) return null;
	const box = row.getBoundingClientRect();
	// Over the title, clear of the timestamp on the right.
	return { x: box.left + box.width * 0.35, y: box.top + box.height / 2 };
`;
const CHAT_WORD_POINT = `
	const transcript = document.getElementById("messages");
	if (!transcript) return null;
	const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const start = node.textContent.indexOf("reply with just");
		if (start < 0) continue;
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + "reply".length);
		const box = range.getBoundingClientRect();
		return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	}
	return null;
`;
// WebDriver lifts the finger at (0,0), dragging any live selection with it,
// so only selections made while the finger is still down are the user's.
const RECORD_HELD_SELECTIONS = `
	getSelection().removeAllRanges();
	window.__held = [];
	let lifted = false;
	for (const type of ["touchend", "touchcancel"])
		document.addEventListener(type, () => { lifted = true; }, true);
	document.addEventListener("selectionchange", () => {
		const text = getSelection().toString().replace(/\\s+/g, " ").trim();
		if (!lifted && text) window.__held.push(text);
	});
`;
const READ_HOLD_RESULT = `
	return {
		held: window.__held,
		sheetOpen: document.querySelector('[data-testid="session-action-sheet"]') !== null,
	};
`;

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise((resolve) => server.close(resolve));
	if (typeof address !== "object" || address === null)
		throw new Error("No free port");
	return address.port;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The few W3C WebDriver commands this test needs, against safaridriver. */
async function connect(base: string) {
	async function call(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const { value } = (await response.json()) as { value: unknown };
		if (!response.ok)
			throw new Error(`${method} ${path}: ${JSON.stringify(value)}`);
		return value;
	}

	for (let ready = false, deadline = Date.now() + 10_000; !ready; ) {
		ready = await call("GET", "/status").then(
			() => true,
			() => false,
		);
		if (!ready && Date.now() > deadline)
			throw new Error("safaridriver did not start");
		if (!ready) await sleep(200);
	}
	const udid = process.env["IOS_SIMULATOR_UDID"];
	const { sessionId, capabilities } = (await call("POST", "/session", {
		capabilities: {
			alwaysMatch: {
				platformName: "iOS",
				browserName: "Safari",
				"safari:useSimulator": true,
				...(udid ? { "safari:deviceUDID": udid } : {}),
			},
		},
	})) as { sessionId: string; capabilities: unknown };
	const at = `/session/${sessionId}`;
	const run = (script: string) =>
		call("POST", `${at}/execute/sync`, { script, args: [] });

	return {
		capabilities,
		run,
		go: (url: string) => call("POST", `${at}/url`, { url }),
		/** Polls a script until it returns the same non-null value twice running. */
		async settle<T>(script: string): Promise<T> {
			let previous = "";
			for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
				const value = await run(script);
				const current = JSON.stringify(value);
				if (value !== null && current === previous) return value as T;
				previous = current;
				await sleep(150);
			}
			throw new Error(`Never settled: ${script.trim().split("\n")[0]}`);
		},
		async hold({ x, y }: Point): Promise<void> {
			const finger = [
				{
					type: "pointerMove",
					duration: 0,
					x: Math.round(x),
					y: Math.round(y),
					origin: "viewport",
				},
				{ type: "pointerDown", button: 0 },
				{ type: "pause", duration: HOLD_MS },
				{ type: "pointerUp", button: 0 },
			];
			await call("POST", `${at}/actions`, {
				actions: [
					{
						type: "pointer",
						id: "finger",
						parameters: { pointerType: "touch" },
						actions: finger,
					},
				],
			});
			await call("DELETE", `${at}/actions`);
		},
		async screenshot(file: string): Promise<void> {
			const png = (await call("GET", `${at}/screenshot`)) as string;
			writeFileSync(file, Buffer.from(png, "base64"));
		},
		quit: () => call("DELETE", at),
	};
}

describe.skipIf(!RUN)("iOS Safari long-press (Simulator)", () => {
	let harness: ReplayHarness | undefined;
	let safaridriver: ChildProcess | undefined;
	let driver: Awaited<ReturnType<typeof connect>> | undefined;
	let url = "";
	const results: Record<string, unknown> = {};

	beforeAll(async () => {
		mkdirSync(ARTIFACTS, { recursive: true });
		harness = await createReplayHarness("chat-simple");
		const sessionId = decodeURIComponent(
			harness.projectUrl.replace(/^\/s\//, ""),
		);
		// A transcript to select from.
		harness.mock.triggerPromptSse(sessionId);
		url = `${harness.relayBaseUrl}${harness.projectUrl}`;
		const port = await freePort();
		safaridriver = spawn("safaridriver", ["-p", String(port)], {
			stdio: "ignore",
		});
		// Booting a simulator on first use takes a while.
		driver = await connect(`http://127.0.0.1:${port}`);
		results["capabilities"] = driver.capabilities;
	}, 300_000);

	afterAll(async () => {
		writeFileSync(
			`${ARTIFACTS}/result.json`,
			JSON.stringify(results, null, "\t"),
		);
		await driver?.quit().catch(() => undefined);
		safaridriver?.kill();
		await harness?.stop();
	});

	async function holdAndRecord(
		name: string,
		point: Point,
	): Promise<HoldResult> {
		if (!driver) throw new Error("No WebDriver session");
		await driver.run(RECORD_HELD_SELECTIONS);
		await driver.hold(point);
		const result = (await driver.run(READ_HOLD_RESULT)) as HoldResult;
		results[name] = { point, ...result };
		await driver.screenshot(`${ARTIFACTS}/${name}.png`);
		return result;
	}

	it("holding a session row opens the action sheet and selects no text", async () => {
		if (!driver) throw new Error("No WebDriver session");
		await driver.go(url);
		await driver.settle(
			`return document.getElementById("session-bar-back") ? true : null;`,
		);
		await driver.run(`document.getElementById("session-bar-back").click();`);
		const result = await holdAndRecord(
			"row-hold",
			await driver.settle<Point>(ROW_POINT),
		);

		expect(result.sheetOpen).toBe(true);
		expect(result.held).toEqual([]);
	});

	it("holding chat text still selects the pressed word", async () => {
		if (!driver) throw new Error("No WebDriver session");
		await driver.go(url);
		const result = await holdAndRecord(
			"chat-hold",
			await driver.settle<Point>(CHAT_WORD_POINT),
		);

		expect(result.held[0]).toBe("reply");
	});
});
