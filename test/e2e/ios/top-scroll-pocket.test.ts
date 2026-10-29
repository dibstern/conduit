/**
 * The iOS 26+ top scroll pocket blur, checked in real WebKit. Opt-in.
 *
 * iOS blurs the status-bar area of a page unless WebKit finds a fixed or
 * sticky box at the top edge; #compact-top-edge is that box on phones. Each
 * step below is followed by 2s of samples (H = blur hidden, S = blur shown),
 * because WebKit re-reads the edge only on some changes, such as an overlay
 * closing. The blur came back after closing the "..." menus once the transcript
 * was scrolled up (conduit-test-mi97); test/e2e/specs/phone-top-edge.spec.ts
 * guards the same rule in Chromium on every run.
 *
 * Safari's toolbar covers the blur, so this builds a small WKWebView host app
 * from ./pocket-probe and installs it on the simulator. Needs Xcode with an
 * iOS 26+ simulator runtime and a booted simulator; pin one with
 * IOS_SIMULATOR_UDID. Verified on iPhone 17e, iOS 26.5 and 27.0.
 *
 *   pnpm test:e2e:ios
 *
 * Artifacts: test-results/ios-top-scroll-pocket/ holds each case's probe
 * output and result.json.
 */
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createReplayHarness,
	type ReplayHarness,
} from "../helpers/e2e-harness.js";

const RUN = process.env["RUN_IOS_E2E"] === "1";
const ARTIFACTS = "test-results/ios-top-scroll-pocket";
const UDID = process.env["IOS_SIMULATOR_UDID"] ?? "booted";
const APP = `${ARTIFACTS}/PocketProbe.app`;
const SOURCE = fileURLToPath(new URL("./pocket-probe/", import.meta.url));
// Async: the replay server runs in this process and must keep serving.
const run = promisify(execFile);

// In-page steps are async function bodies, run by the probe app; a throw fails the step.
const q = (selector: string) =>
	`document.querySelector(${JSON.stringify(selector)})`;
const SETTLE = "await new Promise((resolve) => setTimeout(resolve, 300));";
const ESCAPE = `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`;
const click = (selector: string) => `${q(selector)}.click(); return "clicked";`;
/** Runs `action` and checks the menu behind `trigger` ends up open or closed. */
const menu = (
	trigger: string,
	open: boolean,
	action = open ? `${q(trigger)}.click();` : ESCAPE,
) =>
	`${action} ${SETTLE} if (${q(trigger)}.getAttribute("aria-expanded") !== "${open}") throw new Error(${JSON.stringify(`${trigger} did not ${open ? "open" : "close"}`)}); return "${open ? "opened" : "closed"}";`;
const settings = (action: string, open: boolean) =>
	`${action} ${SETTLE} if (!!${q("#settings-panel")}?.closest("dialog")?.open !== ${open}) throw new Error("settings did not ${open ? "open" : "close"}"); return "${open ? "opened" : "closed"}";`;
// The chat hydrates over the WebSocket after the page loads.
const READY = `for (const deadline = Date.now() + 15000; !document.getElementById("session-bar-more"); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > deadline) throw new Error("no chat at " + location.href); return "chat";`;
const UNFOLD = `for (const deadline = Date.now() + 5000; document.getElementById("layout").classList.contains("layout-compact"); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > deadline) throw new Error("still compact"); return document.documentElement.clientWidth + "px, sidebar " + document.getElementById("sidebar").getBoundingClientRect().width + "px";`;
const STRIP_COLOUR = `Object.assign(document.createElement("canvas").getContext("2d"), { fillStyle: getComputedStyle(${q("#compact-top-edge")}).backgroundColor }).fillStyle`;
const GROW = `const filler = document.createElement("div"); filler.style.height = "4000px"; document.getElementById("messages").append(filler); return "grown";`;
// Scrolled up, the sticky "scroll to bottom" button renders; that is what
// made WebKit read the box painted over the strip.
const SCROLL_UP = `document.getElementById("messages").scrollTop = 1500; ${SETTLE} if (getComputedStyle(document.getElementById("scroll-btn")).display === "none") throw new Error("still following"); return "detached";`;
// Swaps the theme in place; theme-color follows --color-bg as initTheme() would set it.
// Returns the new --color-bg, which the status bar must take on.
const LIGHT = `document.documentElement.classList.replace("dark-theme", "light-theme"); const bg = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim(); const hex = Object.assign(document.createElement("canvas").getContext("2d"), { fillStyle: bg }).fillStyle; ${q('meta[name="theme-color"]')}.content = bg; return hex;`;
// Switching to another app and back: ARM listens for the return, the test
// switches apps once ARM's line prints (switchApps), and AWAY resolves on return.
const ARM = `window.__back = new Promise((resolve) => document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resolve("back"); })); return "armed";`;
const AWAY = `return await window.__back;`;
const COLLAPSE = `document.getElementById("messages").dispatchEvent(new WheelEvent("wheel", { deltaY: 120 })); ${SETTLE} if (document.getElementById("session-bar").dataset.collapsed !== "true") throw new Error("island did not collapse"); return "collapsed";`;

const CASES: Record<string, string[]> = {
	"chat, scrolled up": [
		`ready=${READY}`,
		`grow=${GROW}`,
		`scroll-up=${SCROLL_UP}`,
		`session-menu-open=${menu("#session-bar-more", true)}`,
		`session-menu-close=${menu("#session-bar-more", false)}`,
		`composer-menu-open=${menu('[data-testid="model-picker-trigger"]', true)}`,
		`composer-menu-close=${menu('[data-testid="model-picker-trigger"]', false)}`,
	],
	"island, scrolled up": [
		`ready=${READY}`,
		`grow=${GROW}`,
		`scroll-up=${SCROLL_UP}`,
		`collapse=${COLLAPSE}`,
		`island-menu-open=${menu("#session-bar-more", true)}`,
		`island-menu-close=${menu("#session-bar-more", false)}`,
	],
	"session list": [
		`ready=${READY}`,
		`back=${click("#session-bar-back")}`,
		`settings-open=${settings(`${q("#list-bar-settings")}.click();`, true)}`,
		`settings-close=${settings(`${q('[data-testid="settings-close-btn"]')}.click();`, false)}`,
	],
	// The status bar keeps the colour sampled when a fullscreen dialog opened
	// unless the dialog has its own top-edge strip (Dialog.svelte).
	"settings, theme switched while open": [
		`ready=${READY}`,
		`back=${click("#session-bar-back")}`,
		`settings-open=${settings(`${q("#list-bar-settings")}.click();`, true)}`,
		`light=${LIGHT}`,
	],
	// Reported as "blurred after switching apps". Switching keeps whatever WebKit
	// last sampled; the blur was there from the first frame, because the closed
	// top-sheet wrapper in #session-chrome hid the strip (Menu.svelte).
	"chat, after switching apps": [
		`ready=${READY}`,
		`arm=${ARM}`,
		`app-switch=${AWAY}`,
	],
	"settings, after switching apps": [
		`ready=${READY}`,
		`back=${click("#session-bar-back")}`,
		`settings-open=${settings(`${q("#list-bar-settings")}.click();`, true)}`,
		`arm=${ARM}`,
		`app-switch=${AWAY}`,
	],
	// The probe widens the page to the iPhone Duo's inner screen first.
	unfolded: [
		`ready=${READY}`,
		`unfold=${UNFOLD}`,
		`session-menu-open=${menu("#session-bar-more", true)}`,
		`session-menu-close=${menu("#session-bar-more", false)}`,
		`aligned=const selectors = ["[data-testid=list-bar-title]", "#sidebar-toggle-btn", "#session-bar-title", "#session-bar-settle", "#session-bar-more"]; const centres = selectors.map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top + r.height / 2; }); if (Math.max(...centres) - Math.min(...centres) > 0.5) throw new Error(selectors.map((s, i) => s + "=" + centres[i]).join(", ")); return centres[0] + " strip=" + ${STRIP_COLOUR};`,
	],
	// A card covering WebKit's sample at (innerWidth/2, 4) must keep the chat colour and hide the blur.
	"unfolded, widest sidebar": [
		`ready=${READY}`,
		`unfold=${UNFOLD}`,
		`widen=${q("#sidebar")}.style.width = "480px"; ${SETTLE} const right = ${q("#sidebar")}.getBoundingClientRect().right; if (right <= innerWidth / 2) throw new Error("sidebar right " + right + " did not pass " + innerWidth / 2); return "strip=" + ${STRIP_COLOUR};`,
		`session-menu-open=${menu("#session-bar-more", true)}`,
		`session-menu-close=${menu("#session-bar-more", false)}`,
	],
	// Proves the probe can see the blur: without the strip it must show.
	control: [
		`ready=${READY}`,
		`hide-strip=document.getElementById("compact-top-edge").style.display = "none"; return "hidden";`,
		`menu-open=${menu("#session-bar-more", true)}`,
		`menu-close=${menu("#session-bar-more", false)}`,
	],
};

/** Sends the probe to the background behind Settings, then brings it back. */
async function switchApps() {
	await run("xcrun", ["simctl", "launch", UDID, "com.apple.Preferences"]);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	await run("xcrun", ["simctl", "launch", UDID, "dev.conduit.pocketprobe"]);
}

type Probe = { lines: string[]; timelines: Record<string, string> };

/** Launches the probe app on `url`, runs the steps, and saves and reads its PROBE lines. */
async function probe(
	name: string,
	url: string,
	steps: string[],
): Promise<Probe> {
	const artifact = `${ARTIFACTS}/${name.replaceAll(/\W+/g, "-")}.txt`;
	const launch = run(
		"xcrun",
		[
			"simctl",
			"launch",
			"--console-pty",
			"--terminate-running-process",
			UDID,
			"dev.conduit.pocketprobe",
			url,
			...steps,
		],
		{ encoding: "utf8", timeout: 120_000 },
	);
	launch.child.stdout?.on("data", (chunk: string) => {
		if (chunk.includes("PROBE arm ")) void switchApps();
	});
	const { stdout } = await launch.catch(
		(error: Error & { stdout?: string }) => {
			writeFileSync(artifact, `${error.stdout ?? ""}\n${error.message}`);
			throw error;
		},
	);
	const lines = stdout
		.split("\n")
		.filter((line) => line.startsWith("PROBE "))
		.map((line) => line.trim());
	// "PROBE <label> <timeline> <native state> js=<result>"
	const timelines = Object.fromEntries(
		lines.flatMap((line) => {
			const [, label, timeline] = line.split(" ");
			return label && timeline && /^[HS]+$/.test(timeline)
				? [[label, timeline]]
				: [];
		}),
	);
	writeFileSync(artifact, lines.join("\n"));
	return { lines, timelines };
}

describe.skipIf(!RUN)("iOS top scroll pocket (WKWebView probe app)", () => {
	let harness: ReplayHarness | undefined;
	const results: Record<string, Probe> = {};

	beforeAll(async () => {
		// Stale logs from an earlier run would pass for this one's.
		rmSync(ARTIFACTS, { recursive: true, force: true });
		mkdirSync(APP, { recursive: true });
		if (UDID !== "booted")
			execFileSync("xcrun", ["simctl", "bootstatus", UDID, "-b"], {
				stdio: "ignore",
				timeout: 180_000,
			});
		copyFileSync(`${SOURCE}Info.plist`, `${APP}/Info.plist`);
		const arch = process.arch === "arm64" ? "arm64" : "x86_64";
		await run("xcrun", [
			"-sdk",
			"iphonesimulator",
			"swiftc",
			"-parse-as-library",
			"-target",
			`${arch}-apple-ios26.0-simulator`,
			`${SOURCE}main.swift`,
			"-o",
			`${APP}/PocketProbe`,
		]);
		await run("codesign", ["-s", "-", "--force", APP]);
		await run("xcrun", ["simctl", "install", UDID, APP]);
		harness = await createReplayHarness("chat-simple");
	}, 300_000);

	afterAll(async () => {
		writeFileSync(
			`${ARTIFACTS}/result.json`,
			JSON.stringify(results, null, "\t"),
		);
		await harness?.stop();
	});

	for (const [name, steps] of Object.entries(CASES)) {
		it(name === "control"
			? "control: without the strip the blur shows"
			: `the blur stays hidden: ${name}`, async () => {
			if (!harness) throw new Error("No harness");
			const result = await probe(
				name,
				`${harness.relayBaseUrl}${harness.projectUrl}`,
				steps,
			);
			results[name] = result;

			expect(
				result.lines,
				"the probe could not set the status-bar inset",
			).not.toContain("PROBE no _setObscuredInsets");
			expect(result.lines.filter((line) => line.includes("jsError="))).toEqual(
				[],
			);
			const labels = steps.map((step) => step.slice(0, step.indexOf("=")));
			expect(Object.keys(result.timelines)).toEqual(labels);
			const light = result.lines.find((line) =>
				line.startsWith("PROBE light "),
			);
			if (light)
				expect(light, "status bar colour after the theme switch").toContain(
					`c=${light.match(/js=(\S+)/)?.[1]}/1.00`,
				);
			if (name.startsWith("unfolded")) {
				const strip = result.lines
					.join("\n")
					.match(/\bstrip=(#[\da-f]{6})\b/i)?.[1];
				const final = result.lines.find((line) =>
					line.startsWith(`PROBE ${labels.at(-1)} `),
				);
				expect(
					final?.toLowerCase(),
					"status bar colour matches the chat strip",
				).toContain(`c=${strip?.toLowerCase()}/1.00`);
			}
			if (name === "control")
				expect(result.timelines["menu-close"]).toContain("S");
			else
				expect(result.timelines).toEqual(
					Object.fromEntries(
						labels.map((label) => [label, expect.stringMatching(/^H+$/)]),
					),
				);
		}, 180_000);
	}
});
