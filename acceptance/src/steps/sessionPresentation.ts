import type { Page } from "@playwright/test";
import { PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";

const transcriptMessageTops = new WeakMap<Page, number>();
const rememberedSessionViews = new WeakMap<Page, string[]>();

export const sessionPresentationHandlers: StepHandler[] = [
	{
		name: "set phone viewport",
		match: /^the viewport is a phone$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, PHONE_VIEWPORT);
		},
	},
	{
		name: "scroll transcript up",
		match: /^I scroll the transcript up by ([0-9]+) pixels$/,
		run: async ({ world, match }) => {
			await world.page.locator("#messages").hover();
			await world.page.mouse.wheel(0, -Number(match[1]));
		},
	},
	{
		name: "remember transcript scroll position",
		match: /^I remember the transcript scroll position$/,
		run: async ({ world }) => {
			const { position, maxScroll, messageTop } = await world.page
				.locator("#messages")
				.evaluate((el) => ({
					position: el.scrollTop,
					maxScroll: el.scrollHeight - el.clientHeight,
					messageTop: el.querySelector(".msg-user")?.getBoundingClientRect()
						.top,
				}));
			if (maxScroll <= 0 || position >= maxScroll)
				throw new Error("transcript did not scroll before switching views");
			if (messageTop === undefined)
				throw new Error("transcript has no user message");
			transcriptMessageTops.set(world.page, messageTop);
		},
	},
	{
		name: "choose session view",
		match: /^I choose the (Chat|Terminal) session view$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId("session-bar-views-button").click();
			await world.page
				.getByTestId(`session-bar-view-${match[1]?.toLowerCase()}`)
				.click();
		},
	},
	{
		name: "remember session views from Views sheet",
		match: /^I remember the session views from the Views sheet$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-bar-views-button").click();
			rememberedSessionViews.set(
				world.page,
				await world.page
					.getByTestId("session-bar-views-sheet")
					.getByRole("menuitemradio")
					.evaluateAll((items) =>
						items.map((item) => item.textContent?.trim() ?? ""),
					),
			);
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "open session overflow menu",
		match: /^I open the session overflow menu$/,
		run: async ({ world }) => {
			const compact =
				(await world.page
					.getByTestId("session-bar")
					.getAttribute("data-compact")) === "true";
			await world.page
				.getByTestId(
					compact ? "session-bar-island-overflow" : "session-bar-overflow",
				)
				.click();
			await world.page
				.getByTestId(
					compact ? "session-bar-island-menu" : "session-bar-overflow-menu",
				)
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "menu lists same session views",
		match: /^the menu lists the same session views as the Views sheet$/,
		run: async ({ world }) => {
			const expected = rememberedSessionViews.get(world.page);
			if (!expected?.length)
				throw new Error("session views were not remembered");
			const actual = await world.page
				.getByTestId("session-bar-island-menu")
				.getByRole("menuitemradio")
				.evaluateAll(
					(items, count) =>
						items.slice(0, count).map((item) => item.textContent?.trim() ?? ""),
					expected.length,
				);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`menu views ${JSON.stringify(actual)} differ from Views sheet ${JSON.stringify(expected)}`,
				);
			}
		},
	},
	{
		name: "choose view from menu",
		match: /^I choose the (Chat|Terminal|Files) view from the menu$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("session-bar-island-menu")
				.getByRole("menuitemradio", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "session overflow menu is closed",
		match: /^the session overflow menu is closed$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("session-bar-island-menu")
				.waitFor({ state: "hidden" });
		},
	},
	{
		name: "terminal panel is visible",
		match: /^the terminal panel is visible$/,
		run: async ({ world }) => {
			await world.page.locator("#terminal-panel").waitFor({ state: "visible" });
		},
	},
	{
		name: "session view is selected",
		match: /^the (Chat|Terminal) session view is selected$/,
		run: async ({ world, match }) => {
			const expanded =
				(await world.page.getByTestId("session-bar-views-button").count()) > 0;
			await world.page
				.getByTestId(
					expanded ? "session-bar-views-button" : "session-bar-island-overflow",
				)
				.click();
			const selected = await world.page
				.getByTestId(
					`${expanded ? "session-bar-view" : "overflow-view"}-${match[1]?.toLowerCase()}`,
				)
				.getAttribute("aria-checked");
			await world.page.keyboard.press("Escape");
			if (selected !== "true")
				throw new Error(`${match[1]} view is not selected`);
		},
	},
	{
		name: "transcript stays at remembered scroll position",
		match: /^the transcript is visible at the remembered scroll position$/,
		run: async ({ world }) => {
			await world.page.locator("#messages").waitFor({ state: "visible" });
			const before = transcriptMessageTops.get(world.page);
			const after = await world.page
				.locator("#messages .msg-user")
				.first()
				.evaluate((el) => el.getBoundingClientRect().top);
			if (before === undefined || Math.abs(after - before) > 1) {
				throw new Error(`transcript message moved from ${before} to ${after}`);
			}
		},
	},
	{
		name: "scroll transcript to bottom",
		match: /^I scroll the transcript back to the bottom$/,
		run: async ({ world }) => {
			await world.page.locator("#messages").evaluate((el) => {
				el.scrollTo({ top: el.scrollHeight });
			});
		},
	},
	{
		name: "assert jump-to-latest visibility",
		match: /^the jump-to-latest control is (visible|not visible)$/,
		run: async ({ world, match }) => {
			const button = world.page.locator("#messages #scroll-btn");
			await button.waitFor({ state: "attached" });
			await button.waitFor({
				state: match[1] === "visible" ? "visible" : "hidden",
			});
		},
	},
	{
		// Geometry, not class names: the point of bar 18 is that a phone can see
		// which session it is in without scrolling, and only the rendered boxes
		// can say whether that is true.
		name: "session bar title sits above the transcript",
		match: /^the session bar title is above the transcript$/,
		run: async ({ world }) => {
			const title = world.page.locator("[data-testid='session-bar-title']");
			await title.waitFor({ state: "visible" });
			const titleBox = await title.boundingBox();
			const transcript = world.page.locator("#messages");
			const transcriptBox = await transcript.boundingBox();
			if (!titleBox || !transcriptBox) {
				throw new Error("session bar title or transcript has no layout box");
			}
			const contentInset = await transcript.evaluate((el) =>
				Number.parseFloat(getComputedStyle(el).paddingTop),
			);
			if (titleBox.y + titleBox.height > transcriptBox.y + contentInset + 1) {
				throw new Error(
					`session bar title overlaps the transcript content: title ends at ${
						titleBox.y + titleBox.height
					}, content starts at ${transcriptBox.y + contentInset}`,
				);
			}
		},
	},
	{
		name: "only the session bar is rendered above the transcript",
		match: /^only the session bar is rendered above the transcript$/,
		run: async ({ world }) => {
			const shown = await world.page
				.locator("#session-chrome > :visible")
				.evaluateAll((elements) => elements.map((element) => element.id));
			if (shown.length !== 1 || shown[0] !== "session-bar") {
				throw new Error(
					`expected only the session bar above the transcript, found [${shown.join(", ")}]`,
				);
			}
		},
	},
	{
		name: "desktop merged bar remains one row",
		match: /^the desktop session bar remains one row$/,
		run: async ({ world }) => {
			const bar = world.page.getByTestId("session-bar");
			await bar.waitFor({ state: "visible" });
			const layout = await bar.evaluate((element) => ({
				compact: element.getAttribute("data-compact"),
				collapsed: element.getAttribute("data-collapsed"),
				height: element.getBoundingClientRect().height,
			}));
			if (
				layout.compact !== "false" ||
				layout.collapsed !== "false" ||
				layout.height > 50
			) {
				throw new Error(
					`desktop bar is not one row: ${JSON.stringify(layout)}`,
				);
			}
		},
	},
	{
		name: "phone first row reads back, identity, Views",
		match:
			/^the session bar's first row reads back, identity and Views from left to right$/,
		run: async ({ world }) => {
			const boxes = await Promise.all(
				[
					"[data-testid='session-bar-back']",
					"#session-bar-meta",
					"[data-testid='session-bar-views-button']",
				].map((selector) => world.page.locator(selector).boundingBox()),
			);
			const [back, identity, views] = boxes;
			if (!back || !identity || !views) {
				throw new Error(
					`first-row control has no layout box: ${JSON.stringify(boxes)}`,
				);
			}
			const middle = (box: { y: number; height: number }) =>
				box.y + box.height / 2;
			const oneRow = [identity, views].every(
				(box) => Math.abs(middle(box) - middle(back)) < 8,
			);
			const ordered =
				back.x + back.width <= identity.x + 1 &&
				identity.x + identity.width <= views.x + 1;
			if (!oneRow || !ordered) {
				throw new Error(
					`first row out of order: ${JSON.stringify({ back, identity, views })}`,
				);
			}
		},
	},
	{
		name: "desktop identity sits in the right group",
		match: /^the desktop identity sits in the right-hand group$/,
		run: async ({ world }) => {
			const [bar, identity] = await Promise.all([
				world.page.getByTestId("session-bar").boundingBox(),
				world.page.locator("#session-bar-meta").boundingBox(),
			]);
			if (
				!bar ||
				!identity ||
				identity.x + identity.width / 2 < bar.x + bar.width / 2
			) {
				throw new Error(
					`desktop identity is not right-aligned: ${JSON.stringify({ bar, identity })}`,
				);
			}
		},
	},
	{
		name: "enable desktop debug action",
		match: /^I enable the desktop Debug action$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Control+Shift+KeyD");
			await world.page
				.locator('.debug-panel button[title="Close panel"]')
				.click();
			await world.page.locator(".debug-panel").waitFor({ state: "hidden" });
		},
	},
	{
		name: "desktop overflow lists global actions",
		match:
			/^the desktop overflow lists Share, Settings and Debug panel in order$/,
		run: async ({ world }) => {
			const menu = world.page.getByTestId("session-bar-overflow-menu");
			await menu.waitFor({ state: "visible" });
			const actions = await menu.getByRole("menuitem").allTextContents();
			const expected = ["Share", "Settings", "Debug panel"];
			if (
				JSON.stringify(actions.map((action) => action.trim())) !==
				JSON.stringify(expected)
			) {
				throw new Error(`desktop overflow actions: ${JSON.stringify(actions)}`);
			}
		},
	},
	{
		name: "tap back to the session list",
		match: /^I tap back to the session list$/,
		run: async ({ world }) => {
			await world.page.locator("[data-testid='session-bar-back']").click();
		},
	},
	{
		name: "session list is open",
		match: /^the session list is open$/,
		run: async ({ world }) => {
			await world.page.waitForFunction(
				() => new URL(window.location.href).pathname === "/",
			);
			await world.page
				.locator("#sidebar-panel-sessions")
				.waitFor({ state: "visible" });
		},
	},
	{
		// Geometry as well as the attribute. `data-collapsed` is what the CSS keys
		// on, so checking it alone would pass a regression where the attribute
		// flips correctly and the grid template does not — which is exactly the
		// failure this ticket's whole layout is one edit away from.
		name: "session bar collapse state",
		match: /^the session bar is (collapsed|expanded)$/,
		run: async ({ world, match }) => {
			const want = match[1] === "collapsed";
			const bar = world.page.locator("#session-bar");
			await bar.waitFor({ state: "attached" });
			// Polled by hand rather than through waitForFunction so the failure can
			// name the state it actually found. A bare timeout here says only "the
			// bar was wrong", which is the least useful half of the answer.
			const read = () =>
				bar.evaluate((el) => ({
					collapsed: el.getAttribute("data-collapsed") === "true",
					height: el.getBoundingClientRect().height,
					compact: matchMedia("(max-width: 767px)").matches,
				}));
			// The collapsed row is 46px in the design; expanded is two bands and
			// necessarily taller. 50 separates them with room for the border and
			// subpixel rounding without being a second definition of the number.
			const ok = (s: { collapsed: boolean; height: number }) =>
				s.collapsed === want && (want ? s.height <= 50 : s.height > 50);
			let state = await read();
			for (let i = 0; i < 50 && !ok(state); i++) {
				await world.page.waitForTimeout(100);
				state = await read();
			}
			if (!ok(state)) {
				throw new Error(
					`expected the session bar to be ${match[1]}, found data-collapsed=${state.collapsed} height=${state.height} compact=${state.compact}`,
				);
			}
		},
	},
	{
		name: "tap the chevron to show the bar",
		match: /^I tap the chevron to show the bar$/,
		run: async ({ world }) => {
			await world.page.locator("[data-testid='session-bar-expand']").click();
		},
	},
	{
		// The chevron changes the overlaid bar's height. The transcript must
		// remain pinned while its top clearance changes.
		name: "transcript is pinned to the bottom",
		match: /^the transcript is pinned to the bottom$/,
		run: async ({ world }) => {
			await world.page.waitForFunction(
				() => {
					const el = document.querySelector("#messages");
					if (!el) return false;
					return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
				},
				undefined,
				{ timeout: 5_000 },
			);
		},
	},
];
