#!/usr/bin/env node
/**
 * Side-by-side sheets of the chat-redesign spec against the real app.
 *
 * For every section of the spec doc's Final tabs, in dark and light, it draws
 * the doc's own drawing on the left and the Storybook stories that render the
 * same surface on the right, then writes index.html and README.md beside them.
 *
 *   pnpm storybook:build && pnpm artifact:spec-vs-app
 *
 * Sections are read from the doc at run time and joined to SECTIONS by
 * "<tab>/<heading>". A doc section with no entry, an entry the doc no longer
 * has, a missing story, or a story that renders the wrong theme is drawn into
 * its sheet, listed in index.html, and makes the run exit 1.
 *
 * Env: STORYBOOK_PORT (default: any free port), SPEC_VS_APP_OUT (output directory).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = "docs/plans/2026-10-16-chat-redesign-designs.html";
const OUT = resolve(
	ROOT,
	process.env["SPEC_VS_APP_OUT"] ||
		"docs/plans/2026-10-18-chat-redesign-spec-vs-app",
);
if (OUT === resolve(ROOT))
	throw new Error("SPEC_VS_APP_OUT must not be the repository root.");
const STORYBOOK_DIR = join(ROOT, "dist", "storybook");
const COMMAND = "pnpm storybook:build && pnpm artifact:spec-vs-app";

/** The Final tabs. The earlier tabs (today, A–D, AC, jev-A/C/AC, avatar) are rejected directions. */
const TABS = ["final", "app", "menu", "jev", "new"];
/** @type {readonly Theme[]} */
const THEMES = ["dark", "light"];
/** Desktop is the doc's desktop frame (.f-desk); phone is the app's phone project in test/visual. */
const VIEWPORTS = {
	desktop: { width: 1120, height: 860 },
	phone: { width: 393, height: 852 },
};
/** Same instant as test/visual/components.spec.ts, so stories match their baselines. */
const FIXED_CLOCK = new Date("2026-02-25T10:14:00Z");
const WEBP_QUALITY = 0.8;
/** WebP's hard limit per side. */
const WEBP_MAX = 16383;

/**
 * @typedef {"dark" | "light"} Theme
 * @typedef {keyof typeof VIEWPORTS} Viewport
 * @typedef {{ stories?: string[], note?: string, none?: string }} Mapping
 *   `stories` are Storybook ids; `@phone` renders one at the phone viewport.
 *   `none` says why the app has nothing to show; `note` qualifies a partial match.
 * @typedef {{ key: string, tab: string, title: string, clip: { x: number, y: number, width: number, height: number } }} DocSection
 * @typedef {{ label: string, png?: Buffer, error?: string, width: number, trim?: boolean }} Capture
 *   `trim` crops a desktop capture to its content; a phone keeps its whole screen.
 */

/** @type {Record<string, Mapping>} */
const SECTIONS = {
	// Final · combined
	"final/Desktop · settled": {
		stories: [
			"layout-chatlayout--default",
			"chat-surfacing-summary--new-since-last",
			"chat-turn-activity--settled",
		],
		note: "No story renders the whole desktop app with a Jev turn; the shell and the turn are shown apart.",
	},
	"final/Desktop · live": {
		stories: ["chat-surfacing-card--live-pending", "chat-turn-activity--live"],
	},
	"final/Phone": {
		stories: [
			"layout-sessionbar--phone-top@phone",
			"layout-sessionbar--phone-island-badge@phone",
			"chat-turn-activity--summary-row@phone",
			"chat-surfacing-summary--new-since-last@phone",
		],
	},
	"final/Session menu": {
		stories: [
			"session-sessioncontextmenu--phone-default@phone",
			"ui-phonesheet--held@phone",
			"session-sessioncontextmenu--phone-snoozed@phone",
			"session-sessioncontextmenu--phone-pinned@phone",
			"session-sessioncontextmenu--phone-auto-settle-off@phone",
		],
	},

	// Final · app
	"app/Session header": {
		stories: [
			"layout-sessionbar--desktop-unread",
			"layout-sessionbar--desktop-settled",
			"layout-sessionbar--snoozed@phone",
			"layout-sessionbar--woke@phone",
			"layout-sessionbar--goal-checking@phone",
			"layout-sessionbar--goal-met@phone",
			"layout-chatlayout--sidebar-collapsed",
			"layout-sessionbar--desktop-background-tasks",
			"layout-sessionbar--island-with-banners@phone",
			"layout-sessionbar--goal-details-open@phone",
			"layout-sessionbar--desktop-side-threads-open",
			"layout-sessionbar--desktop-with-skills",
			"layout-sessionbar--overflow-menu-open@phone",
			"layout-sessionbar--phone-top@phone",
			"layout-sessionbar--phone-island-badge@phone",
			"layout-sessionbar--desktop-goal-pursuing",
			"layout-sessionbar--desktop-goal-details",
			"layout-sessionbar--desktop-menu",
			"layout-sessionbar--desktop-snooze-list",
			"layout-sessionbar--desktop-goal-summary-stuck-ready",
			"layout-sessionbar--phone-goal-summary-stuck-ready@phone",
		],
	},
	"app/Composer": {
		stories: [
			"input-inputarea--final-icons-desktop",
			"input-inputarea--words-desktop",
			"input-inputarea--words-working-desktop",
			"input-inputarea--goal-checking",
			"input-inputarea--context-warning",
			"input-inputarea--usage-warning-desktop",
			"input-inputarea--limited",
			"input-inputarea--working-queued",
			"model-instancemodelpicker--open",
			"input-inputarea--mode-menu-open",
			"input-inputarea--dollar-menu",
			"input-inputarea--attach-menu-open",
			"input-inputarea--usage-warning-phone@phone",
			"input-inputarea--final-icons-phone@phone",
			"input-inputarea--words-working-phone@phone",
			"input-inputarea--reply-references-phone@phone",
			"input-inputarea--limited-phone@phone",
			"input-inputarea--composer-sheet@phone",
		],
	},
	"app/Sidebar and usage": {
		stories: [
			"layout-sidebar--final",
			"session-sessionlist--pinned-and-settled-shelf-open",
			"layout-sidebar--needs-you-single-account",
			"layout-usagefootermeter--states",
			"layout-usagefootermeter--codex-allowances",
			"layout-sidebar--final-phone@phone",
			"layout-usagefootermeter--phone-sheet@phone",
		],
	},
	"app/Settings": {
		stories: [
			"overlays-settingspanel--default",
			"overlays-settingspanel--usage",
			"overlays-settingspanel--server",
			"overlays-settingspanel--default@phone",
			"overlays-settingspanel--usage@phone",
			"overlays-settingspanel--server@phone",
		],
	},

	// Final · session menu
	"menu/Phone · five states": {
		stories: [
			"session-sessioncontextmenu--phone-default@phone",
			"ui-phonesheet--held@phone",
			"session-sessioncontextmenu--phone-snoozed@phone",
			"session-sessioncontextmenu--phone-pinned@phone",
			"session-sessioncontextmenu--phone-auto-settle-off@phone",
		],
	},
	"menu/Triage by session state": {
		stories: [
			"session-sessioncontextmenu--phone-default@phone",
			"session-sessioncontextmenu--phone-unread@phone",
			"session-sessioncontextmenu--phone-snoozed@phone",
			"session-sessioncontextmenu--phone-snoozed-indefinitely@phone",
			"session-sessioncontextmenu--phone-disabled-reason@phone",
			"session-sessioncontextmenu--phone-settled@phone",
		],
	},
	"menu/Snooze: tap or hold": {
		stories: [
			"session-snoozesheet--morning@phone",
			"ui-phonesheet--held@phone",
		],
	},
	"menu/Auto-settle row": {
		stories: [
			"ui-phonesheet--switch-on@phone",
			"ui-phonesheet--switch-off@phone",
			"ui-phonesheet--switch-saving@phone",
		],
	},
	"menu/How should Auto-settle show on or off?": {
		stories: [
			"ui-phonesheet--switch-on@phone",
			"ui-phonesheet--switch-off@phone",
		],
		note: "Only option A, the chosen switch row, is built; B to E are reference drawings with no app equivalent.",
	},
	"menu/Header and view cards": {
		stories: [
			"session-sessioncontextmenu--phone-unknown-branch@phone",
			"ui-viewcard--current",
			"ui-viewcard--unavailable",
			"ui-viewcard--with-badge",
			"ui-viewcard--files",
		],
	},
	"menu/Other sheets": {
		stories: [
			"session-sessioncontextmenu--phone-sheet@phone",
			"layout-sessionbar--views-sheet-open@phone",
		],
		note: "The title-chevron sheet was removed; session actions now open from the overflow menu, and views have their own sheet.",
	},
	"menu/Desktop": {
		stories: ["session-sessioncontextmenu--default"],
	},

	// Final · Jev
	"jev/The turn · live": {
		stories: ["chat-surfacing-card--ask", "chat-surfacing-card--live-picked"],
	},
	"jev/The turn · settled": {
		stories: [
			"chat-surfacing-summary--cited-message",
			"chat-surfacing-read--final",
		],
	},
	"jev/Pin lane": {
		stories: [
			"chat-surfacing-read--key",
			"chat-surfacing-card--balanced",
			"chat-surfacing-card--dense",
			"chat-surfacing-card--busiest",
			"chat-surfacing-card--group-current",
			"chat-surfacing-card--narrow-overflow",
		],
	},
	"jev/Card states": {
		stories: [
			"chat-surfacing-card--folded",
			"chat-surfacing-card--final",
			"chat-surfacing-card--short-turn",
			"chat-surfacing-card--nothing-at-key",
			"chat-surfacing-card--not-judged",
			"chat-surfacing-card--hand-back-first-block",
		],
	},
	"jev/Minimise": {
		stories: [
			"chat-surfacing-minimise--minimised",
			"chat-surfacing-minimise--peek",
			"chat-surfacing-minimise--auto-older",
			"chat-surfacing-minimise--minimised@phone",
		],
	},
	"jev/Turn summary": {
		stories: [
			"chat-surfacing-summary--unwritten",
			"chat-surfacing-summary--stale",
			"chat-surfacing-summary--generating",
			"chat-surfacing-summary--failed",
			"chat-surfacing-summary--whole-turn",
		],
	},
	"jev/Marks": {
		stories: [
			"chat-surfacing-marks--raise-why",
			"chat-surfacing-marks--retype-menu",
			"chat-surfacing-marks--retype-why",
			"chat-surfacing-marks--saved-mark",
			"chat-surfacing-marks--lowered-in-log",
		],
	},
	"jev/Reply references": {
		stories: [
			"input-inputarea--reply-references",
			"input-inputarea--reply-excerpt",
			"input-inputarea--reply-recap",
			"input-inputarea--reply-multiple",
			"input-inputarea--reply-references-phone@phone",
		],
	},
	"jev/Keyboard": { stories: ["session-shortcutsheet--surfacing"] },
	"jev/Phone": {
		stories: [
			"chat-surfacing-card--ask@phone",
			"chat-surfacing-card--balanced@phone",
			"chat-surfacing-summary--new-since-last@phone",
			"chat-surfacing-marks--raise-why@phone",
		],
	},
	"jev/Settings › Surfacing": {
		stories: [
			"overlays-surfacingsettings--general",
			"overlays-surfacingsettings--categories-draft",
			"overlays-surfacingsettings--category-editor",
			"overlays-surfacingcategories--session-counts",
			"overlays-surfacingtuning--ledger",
			"overlays-surfacingtuning--review",
			"overlays-surfacingsettings--general@phone",
		],
	},
	"jev/Part 2 · Where the spec departs from the mockups": {
		none: "A list of written decisions, not a drawn surface.",
	},
	"jev/B1 · Drops in under the strip": {
		stories: ["chat-surfacing-summary--new-since-last"],
	},
	"jev/B2 · Floats over the transcript": {
		stories: ["chat-surfacing-summary--new-since-last@phone"],
		note: "The desktop popover is the unchosen alternative; only the phone sheet is built.",
	},
	"jev/Q · The context behind a question": {
		stories: [
			"chat-ask-context--setup",
			"chat-ask-context--explained",
			"chat-ask-context--setup@phone",
		],
	},
	"jev/P · The phone summary button": {
		stories: ["chat-turn-activity--summary-row@phone"],
	},
	"jev/R · Reading a summary without jumping": {
		stories: [
			"chat-surfacing-summary--cited-message",
			"chat-surfacing-summary--cited-replied",
			"chat-surfacing-summary--recap-quote",
			"chat-surfacing-summary--cited-message@phone",
		],
		note: "The doc still presents nine unchosen alternatives; the app now has a citation reader with Reply and excerpt actions.",
	},
	"jev/S · Where the reader lives": {
		none: "Open question in the doc (preset A is only proposed), so no reader tray or side pane is built.",
	},
	"jev/J · Jev categorisation and escalation off": {
		stories: [
			"chat-surfacing-switches--jev-off-summaries-on",
			"chat-surfacing-switches--both-off",
			"overlays-surfacingsettings--jev-off-summaries-on",
		],
		note: "The app supports summaries with Jev off and both off; the doc still labels this decision open.",
	},

	// New features
	"new/1 Run now for any queued message": {
		stories: [
			"input-inputarea--working-queued",
			"input-inputarea--paused-queued",
		],
	},
	"new/2 Add Files": {
		stories: ["input-inputarea--attach-menu-open", "input-attachmenu--open"],
	},
	"new/3 Limit and queue in one card": {
		stories: ["input-inputarea--limited", "input-inputarea--waiting-for-reset"],
	},
	"new/4 One model chip at every width": {
		stories: [
			"input-inputarea--final-icons-desktop",
			"input-inputarea--narrow-366",
		],
	},
	"new/5 Words controls, kept alongside Icons": {
		stories: [
			"input-inputarea--words-desktop",
			"input-inputarea--words-phone@phone",
		],
	},
	"new/6 Phone: the model pill opens every control": {
		stories: ["input-inputarea--composer-sheet@phone"],
	},
	"new/7 $ menu: $goal first, $compact shows context": {
		stories: ["input-inputarea--dollar-menu"],
	},
	"new/8 Settled shelf: true count, above Snoozed": {
		stories: [
			"session-sessionlist--pinned-and-settled-shelf-open",
			"session-sessionlist--settled-count-before-rows",
		],
	},
	"new/9 Hover actions: Settle, Snooze, Pin, ⋯": {
		stories: [
			"session-sessionitem--hover-actions",
			"session-sessionitem--settled-hover-actions",
		],
	},
	"new/10 Phone list header: Select and New session move up; Resume by ID goes":
		{
			stories: [
				"layout-sidebar--final-phone@phone",
				"layout-sidebar--phone-select@phone",
			],
		},
	"new/11 Phone settings: full-screen pages": {
		stories: [
			"overlays-settingspanel--default@phone",
			"overlays-settingspanel--usage@phone",
		],
	},
};

/** @param {string} text */
const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** @param {string} text */
const escapeHtml = (text) =>
	text.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
	);

/** @param {string[]} args */
const git = (args) =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/**
 * Serve dist/storybook. Built in, so the script needs no server process.
 * @returns {Promise<{ origin: string, close: () => void }>}
 */
async function serveStorybook() {
	/** @type {Record<string, string>} */
	const types = {
		".html": "text/html",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".css": "text/css",
		".json": "application/json",
		".svg": "image/svg+xml",
		".png": "image/png",
		".woff2": "font/woff2",
	};
	const server = createServer((req, res) => {
		const file = resolve(
			STORYBOOK_DIR,
			`.${decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)}`,
		);
		if (!file.startsWith(STORYBOOK_DIR + sep)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const body = readFileSync(file);
			res
				.writeHead(200, {
					"content-type": types[extname(file)] ?? "application/octet-stream",
				})
				.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	const port = Number(process.env["STORYBOOK_PORT"] ?? 0);
	await new Promise((done) => server.listen(port, "127.0.0.1", () => done(0)));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("no server port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => server.close(),
	};
}

/**
 * Every section of one tab in one theme, as page-space clips of the doc.
 * A section runs from its heading to the next one; a "new" row is its own section.
 * @param {import("@playwright/test").Page} page
 * @param {string} tab
 * @param {Theme} theme
 * @returns {Promise<DocSection[]>}
 */
async function docSections(page, tab, theme) {
	await page.goto(
		`${pathToFileURL(join(ROOT, DOC)).href}?variant=${tab}&theme=${theme}`,
	);
	await page.evaluate(() => document.fonts.ready);
	// The doc's floating tab switcher would land on whichever section is in view.
	await page.addStyleTag({
		content: ".switcher { display: none !important; }",
	});
	const found = await page.evaluate(
		({ theme, rows }) => {
			const frame = document.querySelector(`.jframe.${theme}`);
			if (!frame) throw new Error(`no .jframe.${theme}`);
			const box = (/** @type {Element} */ el) => {
				const r = el.getBoundingClientRect();
				return { top: r.top + scrollY, bottom: r.bottom + scrollY };
			};
			const f = frame.getBoundingClientRect();
			const x = f.left + scrollX;
			if (rows) {
				return [...frame.querySelectorAll(".nf-row")].map((row) => {
					const h4 = row.querySelector("h4");
					const n = h4?.querySelector(".nf-n")?.textContent?.trim() ?? "";
					const rest = (h4?.textContent ?? "").trim().slice(n.length);
					const b = box(row);
					return {
						title: `${n} ${rest}`.trim(),
						y: b.top,
						height: b.bottom - b.top,
						x,
						width: f.width,
					};
				});
			}
			const kids = [...frame.children];
			const starts = kids.filter((el) => el.matches(".f-sec, .js-part"));
			const end = box(frame).bottom - 16;
			return starts.flatMap((el, i) => {
				const next = starts[i + 1];
				// A part heading straight above a section heading heads nothing itself.
				if (el.nextElementSibling === next) return [];
				const top = box(el).top - 10;
				const bottom = next ? box(next).top - 6 : end;
				return [
					{
						title: (el.childNodes[0]?.textContent ?? "").trim(),
						y: top,
						height: bottom - top,
						x,
						width: f.width,
					},
				];
			});
		},
		{ theme, rows: tab === "new" },
	);
	return found.map(({ title, x, y, width, height }) => ({
		key: `${tab}/${title}`,
		tab,
		title,
		clip: {
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height),
		},
	}));
}

/**
 * Render one story the way test/visual does (pinned clock and randomness,
 * fonts, terminal render phase, settle, frozen animations) and screenshot it.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} origin
 * @param {Map<string, { tags?: string[] }>} index
 * @param {string} ref
 * @param {Theme} theme
 * @returns {Promise<Capture>}
 */
async function captureStory(browser, origin, index, ref, theme) {
	const [id = "", on = "desktop"] = ref.split("@");
	const viewport = on === "phone" ? "phone" : "desktop";
	const { width, height } = VIEWPORTS[viewport];
	// A `-light` sibling pins the light theme itself; otherwise ask via globals.
	const lightSibling = theme === "light" && index.has(`${id}-light`);
	const storyId = lightSibling ? `${id}-light` : id;
	const label = `${storyId} · ${viewport} ${width}×${height}`;
	const entry = index.get(storyId);
	if (!entry)
		return { label, width, error: `Story ${storyId} is not in Storybook.` };

	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
	});
	try {
		const page = await context.newPage();
		await page.addInitScript(() => {
			let seed = 0x2f6e2b1;
			Math.random = () => {
				seed = (seed + 0x6d2b79f5) | 0;
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		});
		await page.clock.setFixedTime(FIXED_CLOCK);
		const globals =
			theme === "light" && !lightSibling ? "&globals=theme:light" : "";
		await page.goto(
			`${origin}/iframe.html?id=${storyId}&viewMode=story${globals}`,
			{ waitUntil: "domcontentloaded" },
		);
		await page.evaluate(() => document.fonts.ready);
		const phase = await page
			.waitForFunction(
				(sid) => {
					/** @type {{ __STORYBOOK_PREVIEW__?: { storyRenders?: { id?: string, phase?: string }[] } }} */
					const w = /** @type {never} */ (window);
					const p = w.__STORYBOOK_PREVIEW__?.storyRenders?.find(
						(r) => r.id === sid,
					)?.phase;
					return ["finished", "errored", "aborted"].includes(p ?? "") && p;
				},
				storyId,
				{ polling: 50, timeout: 8_000 },
			)
			.then((h) => h.jsonValue())
			.catch(() => "timeout");
		if (phase !== "finished")
			return { label, width, error: `Story ${storyId} ${phase}.` };
		await page.waitForTimeout(800);
		if (entry.tags?.includes("visual-pointer-hover"))
			await page.locator("#storybook-root > :first-child").hover();
		await page.addStyleTag({
			content:
				"*, *::before, *::after { animation-delay: -0.0001s !important; animation-duration: 0s !important; animation-play-state: paused !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }",
		});
		await page.waitForTimeout(300);
		const rendered = await page.evaluate(() =>
			document.documentElement.classList.contains("light-theme")
				? "light"
				: "dark",
		);
		if (rendered !== theme)
			return {
				label,
				width,
				error: `Story ${storyId} pins the ${rendered} theme and has no -${theme} sibling.`,
			};
		const root = page.locator("#storybook-root");
		const rootBox = await root.boundingBox();
		const wholeViewport =
			entry.tags?.includes("viewport-capture") ||
			!rootBox ||
			rootBox.height <= 0;
		const png = wholeViewport
			? await page.screenshot()
			: await root.screenshot();

		return {
			label,
			// PNG IHDR: width is the big-endian u32 at byte 16.
			width: png.readUInt32BE(16),
			png,
			trim: viewport === "desktop",
		};
	} finally {
		await context.close();
	}
}

/**
 * Draw one sheet (header, spec column, app column) on a canvas and return WebP bytes.
 * @param {import("@playwright/test").Page} page
 * @param {{ title: string, subtitle: string, theme: Theme, spec: Buffer, specLabel: string, appLabel: string, note: string, none: string, captures: Capture[] }} sheet
 */
async function drawSheet(page, sheet) {
	const b64 = await page.evaluate(
		async ({ sheet, quality, max }) => {
			const load = async (/** @type {string} */ data) => {
				const img = new Image();
				img.src = `data:image/png;base64,${data}`;
				await img.decode();
				return img;
			};
			const dark = sheet.theme === "dark";
			const ink = dark ? "#ececef" : "#1c1c1e";
			const muted = dark ? "#9a9aa2" : "#5f5f66";
			const line = dark ? "#3a3a40" : "#d4d4da";
			const bad = dark ? "#ff8a80" : "#b3261e";
			const font = (/** @type {number} */ size, weight = 400) =>
				`${weight} ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
			const PAD = 32;
			const GAP = 40;
			const spec = await load(sheet.spec);
			const shots = await Promise.all(
				sheet.captures.map(async (c) => ({
					...c,
					img: c.png ? await load(c.png) : null,
				})),
			);
			/** Bounds of the pixels that differ from the top-left one, padded. */
			const contentBox = (/** @type {HTMLImageElement} */ img) => {
				const w = img.naturalWidth;
				const h = img.naturalHeight;
				const c = document.createElement("canvas");
				c.width = w;
				c.height = h;
				const g = /** @type {CanvasRenderingContext2D} */ (
					c.getContext("2d", { willReadFrequently: true })
				);
				g.drawImage(img, 0, 0);
				const d = g.getImageData(0, 0, w, h).data;
				let [x0, y0, x1, y1] = [w, h, -1, -1];
				for (let y = 0; y < h; y++)
					for (let x = 0; x < w; x++) {
						const i = (y * w + x) * 4;
						const diff =
							Math.abs((d[i] ?? 0) - (d[0] ?? 0)) +
							Math.abs((d[i + 1] ?? 0) - (d[1] ?? 0)) +
							Math.abs((d[i + 2] ?? 0) - (d[2] ?? 0));
						if (diff <= 24) continue;
						x0 = Math.min(x0, x);
						y0 = Math.min(y0, y);
						x1 = Math.max(x1, x);
						y1 = Math.max(y1, y);
					}
				if (x1 < 0) return { sx: 0, sy: 0, sw: w, sh: h };
				const sx = Math.max(0, x0 - 16);
				const sy = Math.max(0, y0 - 16);
				return {
					sx,
					sy,
					sw: Math.min(w, x1 + 17) - sx,
					sh: Math.min(h, y1 + 17) - sy,
				};
			};
			const cropped = shots.map((s) => ({
				...s,
				src: s.img
					? s.trim
						? contentBox(s.img)
						: { sx: 0, sy: 0, sw: s.img.naturalWidth, sh: s.img.naturalHeight }
					: null,
			}));
			const ctx0 = /** @type {CanvasRenderingContext2D} */ (
				document.createElement("canvas").getContext("2d")
			);
			const wrap = (/** @type {string} */ text, /** @type {number} */ w) => {
				const out = [];
				let lineText = "";
				for (const word of text.split(" ")) {
					const next = lineText ? `${lineText} ${word}` : word;
					if (ctx0.measureText(next).width > w && lineText) {
						out.push(lineText);
						lineText = word;
					} else lineText = next;
				}
				if (lineText) out.push(lineText);
				return out;
			};

			// App column: shelf-pack the captures, phones side by side.
			// Fits three phones (3 × 393 + 2 × 24) to a row.
			const rightW = Math.max(1227, ...shots.map((s) => s.width));
			ctx0.font = font(15);
			const noteLines = [sheet.none, sheet.note]
				.filter(Boolean)
				.flatMap((t) => wrap(t, rightW - 32));
			const CAP = 26;
			/** @type {{ x: number, y: number, s: (typeof cropped)[number], h: number }[]} */
			const placed = [];
			let y = noteLines.length ? noteLines.length * 22 + 40 : 0;
			let x = 0;
			let rowH = 0;
			for (const s of cropped) {
				const w = s.src ? s.src.sw : Math.min(s.width, rightW);
				const h = s.src ? s.src.sh : 120;
				if (x > 0 && x + w > rightW) {
					x = 0;
					y += rowH + 28;
					rowH = 0;
				}
				placed.push({ x, y, s, h });
				x += w + 24;
				rowH = Math.max(rowH, CAP + h);
			}
			const rightH = y + rowH;

			const HEAD = 96;
			const LABEL = 34;
			const W = PAD + spec.naturalWidth + GAP + rightW + PAD;
			const H = HEAD + LABEL + Math.max(spec.naturalHeight, rightH) + PAD + 8;
			const scale = Math.min(1, max / W, max / H);
			const canvas = document.createElement("canvas");
			canvas.width = Math.floor(W * scale);
			canvas.height = Math.floor(H * scale);
			const ctx = /** @type {CanvasRenderingContext2D} */ (
				canvas.getContext("2d")
			);
			ctx.scale(scale, scale);
			ctx.fillStyle = dark ? "#121214" : "#f7f7f8";
			ctx.fillRect(0, 0, W, H);
			ctx.textBaseline = "top";

			ctx.fillStyle = ink;
			ctx.font = font(26, 650);
			ctx.fillText(sheet.title, PAD, PAD - 4);
			ctx.fillStyle = muted;
			ctx.font = font(14);
			ctx.fillText(sheet.subtitle, PAD, PAD + 34);

			const colTop = HEAD;
			const rightX = PAD + spec.naturalWidth + GAP;
			ctx.fillStyle = ink;
			ctx.font = font(17, 650);
			ctx.fillText(sheet.specLabel, PAD, colTop);
			ctx.fillText(sheet.appLabel, rightX, colTop);
			ctx.fillStyle = line;
			ctx.fillRect(rightX - GAP / 2, colTop, 1, H - colTop - PAD);

			const bodyTop = colTop + LABEL;
			ctx.drawImage(spec, PAD, bodyTop);

			if (noteLines.length) {
				ctx.strokeStyle = sheet.none ? bad : line;
				ctx.lineWidth = 2;
				ctx.strokeRect(rightX, bodyTop, rightW, noteLines.length * 22 + 20);
				ctx.fillStyle = sheet.none ? bad : muted;
				ctx.font = font(15, sheet.none ? 600 : 400);
				for (const [i, t] of noteLines.entries())
					ctx.fillText(t, rightX + 16, bodyTop + 10 + i * 22);
			}
			for (const { x: px, y: py, s, h } of placed) {
				const left = rightX + px;
				const top = bodyTop + py;
				ctx.fillStyle = s.error ? bad : muted;
				ctx.font = font(13);
				ctx.fillText(
					s.src && s.img && s.src.sh < s.img.naturalHeight - 32
						? `${s.label}, cropped to content`
						: s.label,
					left,
					top,
					// Squeeze a long caption into its cell rather than overrun the next.
					s.src ? s.src.sw : Math.min(s.width, rightW),
				);
				if (s.img && s.src) {
					const { sx, sy, sw, sh } = s.src;
					ctx.drawImage(s.img, sx, sy, sw, sh, left, top + CAP, sw, sh);
					ctx.strokeStyle = line;
					ctx.lineWidth = 1;
					ctx.strokeRect(left - 0.5, top + CAP - 0.5, sw + 1, sh + 1);
				} else {
					const w = Math.min(s.width, rightW);
					ctx.strokeStyle = bad;
					ctx.lineWidth = 2;
					ctx.strokeRect(left, top + CAP, w, h);
					ctx.fillStyle = bad;
					ctx.font = font(15, 600);
					for (const [i, t] of wrap(s.error ?? "", w - 24).entries())
						ctx.fillText(t, left + 12, top + CAP + 12 + i * 22);
				}
			}
			return canvas.toDataURL("image/webp", quality).split(",")[1] ?? "";
		},
		{
			sheet: {
				...sheet,
				spec: sheet.spec.toString("base64"),
				captures: sheet.captures.map(({ png, ...c }) => ({
					...c,
					png: png?.toString("base64"),
				})),
			},
			quality: WEBP_QUALITY,
			max: WEBP_MAX,
		},
	);
	return Buffer.from(b64, "base64");
}

/**
 * Bounded-concurrency map, so captures run a few at a time.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
	/** @type {R[]} */
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(/** @type {T} */ (items[i]));
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));
	return out;
}

async function main() {
	/** @type {{ entries: Record<string, { id: string, type: string, tags?: string[] }> }} */
	const built = JSON.parse(
		readFileSync(join(STORYBOOK_DIR, "index.json"), "utf8"),
	);
	const index = new Map(
		Object.values(built.entries)
			.filter((e) => e.type === "story")
			.map((e) => [e.id, e]),
	);
	const commit = git(["rev-parse", "--short", "HEAD"]);
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
	const dirty =
		git(["status", "--porcelain", "--", "src", ".storybook", DOC]) !== "";
	const generatedAt = new Date().toISOString();

	const server = await serveStorybook();
	const browser = await chromium.launch();
	const docPage = await browser.newPage({
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 1,
	});
	const drawPage = await browser.newPage();
	/** @type {string[]} */
	const problems = [];
	/** @type {{ n: number, key: string, tab: string, title: string, mapping: Mapping, files: Record<Theme, string> }[]} */
	const rows = [];
	const outDir = OUT;
	mkdirSync(outDir, { recursive: true });

	try {
		/** @type {Set<string>} */
		const seen = new Set();
		for (const tab of TABS) {
			for (const theme of THEMES) {
				const sections = await docSections(docPage, tab, theme);
				for (const section of sections) {
					seen.add(section.key);
					const mapping = SECTIONS[section.key] ?? {
						none: `Not mapped: add "${section.key}" to SECTIONS in scripts/spec-vs-app.mjs.`,
					};
					if (!SECTIONS[section.key] && theme === "dark")
						problems.push(`Unmapped doc section: ${section.key}`);
					let row = rows.find((r) => r.key === section.key);
					if (!row) {
						row = {
							n: rows.length + 1,
							key: section.key,
							tab,
							title: section.title,
							mapping,
							files: { dark: "", light: "" },
						};
						rows.push(row);
					}
					const spec = await docPage.screenshot({
						clip: section.clip,
						fullPage: true,
					});
					const captures = await mapLimit(mapping.stories ?? [], 4, (ref) =>
						captureStory(browser, server.origin, index, ref, theme),
					);
					for (const c of captures)
						if (c.error) problems.push(`${section.key} (${theme}): ${c.error}`);
					const file = `${String(row.n).padStart(2, "0")}-${tab}-${slug(section.title)}-${theme}.webp`;
					const webp = await drawSheet(drawPage, {
						title: `${tab} · ${section.title} · ${theme}`,
						subtitle: `Spec: ${DOC}?variant=${tab}&theme=${theme}    App: Storybook at ${commit}${dirty ? " (uncommitted changes)" : ""}    ${generatedAt.slice(0, 10)}`,
						theme,
						spec,
						specLabel: "Spec",
						appLabel: "App",
						note: mapping.note ?? "",
						none: mapping.none ? `No app equivalent: ${mapping.none}` : "",
						captures,
					});
					writeFileSync(join(outDir, file), webp);
					row.files[theme] = file;
					console.log(`${file}  ${(webp.length / 1024).toFixed(0)} KB`);
				}
			}
		}
		for (const key of Object.keys(SECTIONS))
			if (!seen.has(key))
				problems.push(`Mapped section not in the doc: ${key}`);
	} finally {
		await browser.close();
		server.close();
	}

	const meta = { commit, branch, dirty, generatedAt };
	writeFileSync(join(outDir, "index.html"), indexHtml(rows, problems, meta));
	writeFileSync(join(outDir, "README.md"), readme(rows, meta));
	console.log(
		`${rows.length} sections × ${THEMES.length} themes → ${relative(ROOT, outDir)}`,
	);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
		process.exitCode = 1;
	}
}

/**
 * @param {{ n: number, key: string, tab: string, title: string, mapping: Mapping, files: Record<Theme, string> }[]} rows
 * @param {string[]} problems
 * @param {{ commit: string, branch: string, dirty: boolean, generatedAt: string }} meta
 */
function indexHtml(rows, problems, meta) {
	const cells = rows
		.map(({ n, key, mapping, files }) => {
			const stories = (mapping.stories ?? [])
				.map((s) => `<code>${escapeHtml(s)}</code>`)
				.join(" ");
			const none = mapping.none
				? `<p class="none">No app equivalent: ${escapeHtml(mapping.none)}</p>`
				: "";
			const note = mapping.note
				? `<p class="note">${escapeHtml(mapping.note)}</p>`
				: "";
			const shots = THEMES.map(
				(t) =>
					`<a href="${files[t]}"><img src="${files[t]}" alt="${escapeHtml(key)}, ${t}" loading="lazy"></a>`,
			).join("");
			return `<section id="s${n}"><h2>${n}. ${escapeHtml(key)}</h2>${none}${note}<p class="ids">${stories || "—"}</p><div class="pair">${shots}</div></section>`;
		})
		.join("\n");
	const issues = problems.length
		? `<h2 class="none">${problems.length} problem(s)</h2><ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chat redesign: spec vs app</title>
<style>
body { margin: 0; padding: 32px; background: #161618; color: #e8e8ea; font: 14px/1.5 -apple-system, system-ui, sans-serif; }
h1 { margin: 0 0 6px; font-size: 22px; }
h2 { margin: 0 0 6px; font-size: 16px; }
.meta { color: #a1a1a6; margin: 0 0 24px; }
section { margin: 0 0 36px; padding-top: 16px; border-top: 1px solid #333; }
.ids code { display: inline-block; margin: 0 6px 4px 0; padding: 1px 6px; border-radius: 4px; background: #26262a; font-size: 12px; }
.none { color: #ff8a80; }
.note { color: #c7c7cc; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair img { width: 100%; border: 1px solid #333; border-radius: 6px; }
</style>
</head>
<body>
<h1>Chat redesign: spec vs app</h1>
<p class="meta">${rows.length} sections × ${THEMES.length} themes (dark, light). Spec: <code>${DOC}</code>, tabs ${TABS.join(", ")}. App: Storybook built from <code>${meta.branch}</code> at <code>${meta.commit}</code>${meta.dirty ? " with uncommitted changes" : ""}, generated ${meta.generatedAt}. Regenerate: <code>${COMMAND}</code>.</p>
${issues}
${cells}
</body>
</html>
`;
}

/**
 * @param {{ n: number, key: string, mapping: Mapping }[]} rows
 * @param {{ commit: string, branch: string, dirty: boolean, generatedAt: string }} meta
 */
function readme(rows, meta) {
	const none = rows.filter((r) => r.mapping.none);
	return `# Chat redesign: spec vs app

Side-by-side sheets of every section of [the chat-redesign spec](${relative(resolve(ROOT, OUT), join(ROOT, DOC))})
(tabs ${TABS.map((t) => `\`${t}\``).join(", ")}) next to the Storybook stories that render the same surface,
in dark and light. Open [index.html](index.html) for the full list with story ids.

- ${rows.length} sections × ${THEMES.length} themes = ${rows.length * THEMES.length} sheets, named \`NN-<tab>-<section>-<theme>.webp\`.
- Generated from \`${meta.branch}\` at \`${meta.commit}\`${meta.dirty ? " with uncommitted changes" : ""} on ${meta.generatedAt.slice(0, 10)}.
- Desktop stories render at the doc's desktop frame, ${VIEWPORTS.desktop.width}×${VIEWPORTS.desktop.height}; phone stories at ${VIEWPORTS.phone.width}×${VIEWPORTS.phone.height}, as in \`test/visual\`.
- ${none.length} section(s) have no app equivalent: ${none.map((r) => `${r.n} (${r.key})`).join(", ") || "none"}.
- The earlier tabs (\`today\`, \`A\`–\`D\`, \`AC\`, \`jev-*\`, \`avatar\`) are rejected directions and are not compared.

## Regenerate

\`\`\`bash
${COMMAND}
\`\`\`

The section-to-story map is \`SECTIONS\` in [\`scripts/spec-vs-app.mjs\`](${relative(resolve(ROOT, OUT), join(ROOT, "scripts/spec-vs-app.mjs"))}). The run
writes the sheets and index and exits 1, after writing every sheet, when a doc section is unmapped, a mapped section
or story is gone, or a story fails to finish or renders the wrong theme. Set \`STORYBOOK_PORT\` to pin the local server's port
and \`SPEC_VS_APP_OUT\` to choose a different output directory.
`;
}

await main();
