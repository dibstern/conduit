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
 * taken after each hold. test-results/ios-hold-menu/ holds the HoldMenu
 * gesture's result.json and twelve step screenshots, two of them native
 * simulator captures taken while the finger is still down.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";
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
type TouchAction =
	| {
			type: "pointerMove";
			duration: number;
			x: number;
			y: number;
			origin: "viewport";
	  }
	| { type: "pointerDown" | "pointerUp"; button: 0 }
	| { type: "pause"; duration: number };

const moveTo = ({ x, y }: Point, duration = 0): TouchAction => ({
	type: "pointerMove",
	duration,
	x: Math.round(x),
	y: Math.round(y),
	origin: "viewport",
});

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
	const createSession = () =>
		call("POST", "/session", {
			capabilities: {
				alwaysMatch: {
					platformName: "iOS",
					browserName: "Safari",
					"safari:useSimulator": true,
					...(udid ? { "safari:deviceUDID": udid } : {}),
				},
			},
		});
	// Safari unpairs from the previous describe's session a moment after it quits.
	let created: unknown;
	for (const deadline = Date.now() + 20_000; created === undefined; ) {
		created = await createSession().catch(async (error: unknown) => {
			const paired =
				error instanceof Error && error.message.includes("already paired");
			if (!paired || Date.now() > deadline) throw error;
			await sleep(1000);
			return undefined;
		});
	}
	const { sessionId, capabilities } = created as {
		sessionId: string;
		capabilities: unknown;
	};
	const at = `/session/${sessionId}`;
	const run = (script: string) =>
		call("POST", `${at}/execute/sync`, { script, args: [] });
	const touch = async (actions: readonly TouchAction[]): Promise<void> => {
		try {
			await call("POST", `${at}/actions`, {
				actions: [
					{
						type: "pointer",
						id: "finger",
						parameters: { pointerType: "touch" },
						actions,
					},
				],
			});
		} finally {
			await call("DELETE", `${at}/actions`);
		}
	};

	return {
		capabilities,
		run,
		touch,
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
		async hold(point: Point): Promise<void> {
			await touch([
				moveTo(point),
				{ type: "pointerDown", button: 0 },
				{ type: "pause", duration: HOLD_MS },
				{ type: "pointerUp", button: 0 },
			]);
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

type MenuSample = {
	sheetOpen: boolean;
	listOpen: boolean;
	phase: string | null;
	scrollTop: number | null;
	sheetTop: number | null;
	transform: string | null;
	pageScroll: number;
	rowBackground: string | null;
	picked: string;
	picks: number;
};
type MenuProof = {
	samples: (MenuSample & { fingerDown: boolean; at: number })[];
	events: {
		type: string;
		pointerId: number;
		pointerType: string;
		trusted: boolean;
		at: number;
	}[];
	moves: number[];
	selections: string[];
	final: MenuSample;
};
type Shot = { file: string; from: number; to: number };

const MENU_SAMPLE = `(() => {
	const sheet = document.querySelector('[role="menu"][aria-label="Session actions"]');
	const row = document.querySelector('[data-hold-menu-item="evening"]');
	return {
		sheetOpen: !!sheet,
		listOpen: !!document.querySelector('[data-hold-menu-panel]'),
		phase: document.querySelector('[data-hold-menu-trigger]')?.dataset.holdMenuPhase ?? null,
		scrollTop: sheet?.querySelector('[data-sheet-body]')?.scrollTop ?? null,
		sheetTop: sheet?.getBoundingClientRect().top ?? null,
		transform: sheet ? getComputedStyle(sheet).transform : null,
		pageScroll: scrollY,
		rowBackground: row ? getComputedStyle(row).backgroundColor : null,
		picked: document.querySelector('[data-testid="hold-menu-picked"]').textContent,
		picks: Number(document.querySelector('[data-testid="hold-menu-picks"]').textContent),
	};
})()`;

// Sample while WebDriver is executing the continuous gesture. Asking WebDriver
// for the DOM between down/move/up would split the native touch sequence.
// The simulator shares the host clock, so Date.now() lines samples up with the
// native screenshots taken during the gesture.
const OBSERVE_MENU = `
	getSelection().removeAllRanges();
	const samples = [], events = [], moves = [], selections = [];
	let fingerDown = false;
	const sample = () => samples.push({ ...${MENU_SAMPLE}, fingerDown, at: Date.now() });
	const record = (event) => {
		if (event.type === 'pointermove') return void moves.push(Date.now());
		fingerDown = event.type === 'pointerdown';
		events.push({ type: event.type, pointerId: event.pointerId, pointerType: event.pointerType, trusted: event.isTrusted, at: Date.now() });
		queueMicrotask(sample);
	};
	const select = () => {
		const text = getSelection().toString().trim();
		if (fingerDown && text) selections.push(text);
	};
	const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
	for (const type of types) window.addEventListener(type, record, true);
	document.addEventListener('selectionchange', select);
	const timer = setInterval(sample, 32);
	window.__holdMenuProof = {
		samples, events, moves, selections,
		stop: () => {
			clearInterval(timer);
			for (const type of types) window.removeEventListener(type, record, true);
			document.removeEventListener('selectionchange', select);
		},
	};
`;

describe.skipIf(!RUN)("iOS Safari HoldMenu (Simulator)", () => {
	const artifacts = "test-results/ios-hold-menu";
	const run = promisify(execFile);
	let safaridriver: ChildProcess | undefined;
	let storybook: ChildProcess | undefined;
	let driver: Awaited<ReturnType<typeof connect>>;
	let simulator = "";
	const results: Record<string, unknown> = {};

	beforeAll(async () => {
		rmSync(artifacts, { recursive: true, force: true });
		mkdirSync(artifacts, { recursive: true });
		const storybookPort = await freePort();
		storybook = spawn(
			"npx",
			[
				"--no-install",
				"http-server",
				"dist/storybook",
				"-p",
				String(storybookPort),
				"-s",
				"-c-1",
			],
			{ stdio: "ignore" },
		);
		const url = `http://127.0.0.1:${storybookPort}/iframe.html?id=ui-holdmenu--device-probe&viewMode=story`;
		for (const deadline = Date.now() + 10_000; ; await sleep(200)) {
			const served = await fetch(url).then(
				(response) => response.ok,
				() => false,
			);
			if (served) break;
			if (Date.now() > deadline)
				throw new Error(
					`Storybook did not serve ${url}; is dist/storybook built?`,
				);
		}
		const driverPort = await freePort();
		safaridriver = spawn("safaridriver", ["-p", String(driverPort)], {
			stdio: "ignore",
		});
		driver = await connect(`http://127.0.0.1:${driverPort}`);
		results["capabilities"] = driver.capabilities;
		// Native screenshots must come from the simulator safaridriver drives.
		simulator = String(
			(driver.capabilities as Record<string, unknown>)["safari:deviceUDID"],
		);
		results["url"] = url;
		await driver.go(url);
		await driver.settle(
			`return document.querySelector('[data-hold-menu-trigger]') ? true : null;`,
		);
	}, 300_000);

	afterAll(async () => {
		writeFileSync(
			`${artifacts}/result.json`,
			JSON.stringify(results, null, "\t"),
		);
		await driver?.quit().catch(() => undefined);
		safaridriver?.kill();
		storybook?.kill();
	});

	async function point(selector: string): Promise<Point> {
		return driver.settle<Point>(`
			const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
			if (!box || !box.width || !box.height) return null;
			const x = box.left + box.width / 2, y = box.top + box.height / 2;
			return x > 0 && x < innerWidth && y > 0 && y < innerHeight ? { x, y } : null;
		`);
	}

	async function tap(selector: string) {
		await driver.touch([
			moveTo(await point(selector)),
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 80 },
			{ type: "pointerUp", button: 0 },
		]);
	}

	async function record(name: string): Promise<MenuSample> {
		const sample = await driver.settle<MenuSample>(`return ${MENU_SAMPLE};`);
		results[name] = sample;
		await driver.screenshot(`${artifacts}/${name}.png`);
		return sample;
	}

	/** Keeps the native screenshot taken wholly inside [from, to], nearest its middle. */
	function keepShot(shots: Shot[], from: number, to: number, name: string) {
		const middle = (from + to) / 2;
		const inside = shots
			.filter((shot) => shot.from >= from && shot.to <= to)
			.sort(
				(a, b) =>
					Math.abs((a.from + a.to) / 2 - middle) -
					Math.abs((b.from + b.to) / 2 - middle),
			);
		const shot = inside[0];
		if (!shot) throw new Error(`No native screenshot fell inside ${name}`);
		renameSync(shot.file, `${artifacts}/${name}.png`);
		return shot;
	}

	async function slide(
		name: string,
		target: Point,
		heldShot: string,
		slidShot: string,
	): Promise<MenuProof> {
		const start = await point("[data-hold-menu-trigger]");
		const baseline = await driver.settle<MenuSample>(`return ${MENU_SAMPLE};`);
		await driver.run(OBSERVE_MENU);
		// One W3C action request with one down and one up. Native screenshots run
		// outside WebDriver, back to back, for the whole gesture; the page samples
		// decide afterwards which of them show the held and the slid states.
		const shots: Shot[] = [];
		let lifted = false;
		const gesture = driver
			.touch([
				moveTo(start),
				{ type: "pointerDown", button: 0 },
				{ type: "pause", duration: 2_500 },
				moveTo(target, 400),
				{ type: "pause", duration: 2_500 },
				{ type: "pointerUp", button: 0 },
			])
			.finally(() => {
				lifted = true;
			});
		const burst = (async () => {
			for (let i = 0; !lifted; i++) {
				const file = `${artifacts}/${name}-burst-${i}.png`;
				const from = Date.now();
				await run("xcrun", ["simctl", "io", simulator, "screenshot", file], {
					timeout: 10_000,
				});
				shots.push({ file, from, to: Date.now() });
			}
		})();
		const outcomes = await Promise.allSettled([gesture, burst]);
		const proof = (await driver.run(`
			window.__holdMenuProof.stop();
			const { samples, events, moves, selections } = window.__holdMenuProof;
			return { samples, events, moves, selections, final: ${MENU_SAMPLE} };
		`)) as MenuProof;
		results[name] = { start, target, baseline, ...proof };
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") throw outcome.reason;
		}
		expect(proof.events.map((event) => event.type)).toEqual([
			"pointerdown",
			"pointerup",
		]);
		expect(new Set(proof.events.map((event) => event.pointerId)).size).toBe(1);
		expect(
			proof.events.every(
				(event) => event.trusted && event.pointerType === "touch",
			),
		).toBe(true);
		// No text selection while the finger is down (the iOS long-press hold).
		expect(proof.selections).toEqual([]);
		const following = proof.samples.filter(
			(sample) => sample.fingerDown && sample.phase === "following",
		);
		expect(following.length).toBeGreaterThan(5);
		for (const sample of following) {
			expect(sample.sheetOpen).toBe(true);
			expect(sample.listOpen).toBe(true);
			expect(sample.scrollTop).toBe(baseline.scrollTop);
			expect(sample.transform).toBe(baseline.transform);
			expect(sample.pageScroll).toBe(baseline.pageScroll);
			expect(sample.sheetTop).toBe(baseline.sheetTop);
		}
		const firstFollowing = following[0]?.at ?? 0;
		const firstMove = proof.moves[0] ?? 0;
		const lastMove = proof.moves.at(-1) ?? 0;
		const lift = proof.events[1]?.at ?? 0;
		results[`${name}-shots`] = {
			held: keepShot(shots, firstFollowing, firstMove, heldShot),
			slid: keepShot(shots, lastMove, lift, slidShot),
		};
		for (const shot of shots) rmSync(shot.file, { force: true });
		return proof;
	}

	it("tap, continuous hold-slide-release, off-list release, dim dismissal and native scroll", async () => {
		const closed = await record("00-closed");
		expect(closed).toMatchObject({
			sheetOpen: true,
			listOpen: false,
			scrollTop: 0,
			picks: 0,
		});
		await tap("[data-hold-menu-trigger]");
		await sleep(700);
		const opened = await record("01-tap-stays-open");
		expect(opened).toMatchObject({
			sheetOpen: true,
			listOpen: true,
			phase: "open",
			picks: 0,
		});
		const row = await point('[data-hold-menu-item="evening"]');
		const offList = await point('[data-testid="hold-menu-views"]');
		await tap('[data-testid="hold-menu-views"]');
		expect(await record("02-dim-closes-list")).toMatchObject({
			sheetOpen: true,
			listOpen: false,
			picks: 0,
			picked: "",
		});

		const pick = await slide(
			"pick-gesture",
			row,
			"03-hold-under-finger",
			"04-slide-highlight",
		);
		const highlighted = pick.samples.filter(
			(sample) =>
				sample.fingerDown &&
				sample.phase === "following" &&
				sample.rowBackground !== opened.rowBackground,
		);
		expect(highlighted.length).toBeGreaterThan(5);
		for (const sample of highlighted) {
			expect(sample.rowBackground).not.toBeNull();
			expect(sample.rowBackground).not.toMatch(
				/^(transparent|rgba\(0, 0, 0, 0\))$/,
			);
		}
		expect(await record("05-release-picks-once")).toMatchObject({
			sheetOpen: false,
			listOpen: false,
			picked: "evening",
			picks: 1,
		});

		await tap("[data-dropdown-menu-trigger]");
		expect(await record("06-reopened")).toMatchObject({
			sheetOpen: true,
			listOpen: false,
			scrollTop: 0,
		});
		await slide(
			"off-list-gesture",
			offList,
			"07-hold-again",
			"08-slide-off-list",
		);
		await sleep(700);
		expect(await record("09-off-list-stays-open")).toMatchObject({
			sheetOpen: true,
			listOpen: true,
			phase: "open",
			picked: "evening",
			picks: 1,
		});
		await tap('[data-testid="hold-menu-views"]');
		expect(await record("10-dim-keeps-sheet")).toMatchObject({
			sheetOpen: true,
			listOpen: false,
			picked: "evening",
			picks: 1,
		});

		// A swipe that becomes a native scroll hangs safaridriver, so the
		// scroll-cancels-press case is proven by the Chromium touch spec instead.
		const trigger = await point("[data-hold-menu-trigger]");
		await driver.touch([
			moveTo(trigger),
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 1500 },
			{ type: "pointerUp", button: 0 },
		]);
		await sleep(700);
		expect(await record("11-hold-release-in-place-stays-open")).toMatchObject({
			sheetOpen: true,
			listOpen: true,
			phase: "open",
			picked: "evening",
			picks: 1,
		});
		results["deviceProbe"] = await driver.run(
			`return JSON.parse(document.querySelector('[data-testid="hold-menu-probe-json"]').textContent);`,
		);
	}, 120_000);
});
