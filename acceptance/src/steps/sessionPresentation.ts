import { expect, type Page } from "@playwright/test";
import { inspectTouchTarget } from "../../../src/lib/frontend/stories/touch-target.js";
import { PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const transcriptMessageTops = new WeakMap<Page, number>();
const rememberedSessionViews = new WeakMap<Page, string[]>();
const transcriptAnchors = new WeakMap<Page, { top: number; gap: number }>();

export const sessionPresentationHandlers: StepHandler[] = [
	{
		name: "phone header controls own their touch targets",
		match:
			/^the phone header controls own separate touch areas of at least 24 pixels, using 44 where space permits$/,
		run: async ({ world }) => {
			let checked = 0;
			const small = [
				"session-skills-chip",
				"side-threads-control",
				"session-bar-settle",
				"session-bar-title-menu",
				"session-bar-unread-chip",
				"session-bar-state-chip",
				"session-goal-subtitle",
			];
			for (const id of [
				"session-bar-back",
				"session-bar-island-overflow",
				"session-bar-expand",
				...small,
				"background-tasks-toggle",
				"background-tasks-row-stop-all",
				"goal-details-pause",
				"goal-details-resume",
				"goal-details-edit",
				"goal-details-clear",
				"goal-details-new",
				"goal-details-dismiss",
			]) {
				const control = world.page.getByTestId(id);
				if (
					!(await control.count()) ||
					!(await control.isVisible()) ||
					!(await control.evaluate((el) => el.tagName === "BUTTON"))
				)
					continue;
				checked++;
				const minimum =
					small.includes(id) &&
					!(
						!(await world.page.getByTestId("background-tasks-row").count()) &&
						(id === "session-goal-subtitle" ||
							(id === "session-bar-state-chip" &&
								!(await world.page
									.getByTestId("session-goal-subtitle")
									.count())))
					)
						? 24
						: 44;
				const target = await control.evaluate(inspectTouchTarget, minimum);
				expect(target.width, id).toBeGreaterThanOrEqual(minimum);
				expect(target.height, id).toBeGreaterThanOrEqual(minimum);
				expect(
					target.missing,
					`${id}: ${JSON.stringify(target.failures)}`,
				).toBe(0);
			}
			expect(checked).toBeGreaterThanOrEqual(2);
		},
	},
	{
		name: "verify Settle keyboard focus ring",
		match:
			/^the Settle segment shows a focus ring after tabbing and clears it after a pointer click$/,
		run: async ({ world }) => {
			const bar = world.page.getByTestId("session-bar");
			const settle = world.page.getByTestId("session-bar-settle");
			await expect(settle).toBeVisible();
			await expect(settle).not.toBeFocused();
			await expect(settle).toHaveCSS("box-shadow", "none");
			await bar.click({ position: { x: 1, y: 1 } });
			for (let tabs = 0; tabs < 20; tabs++) {
				await world.page.keyboard.press("Tab");
				if (await settle.evaluate((el) => el === document.activeElement)) break;
			}
			await expect(settle).toBeFocused();
			await expect(settle.locator(":scope:focus-visible")).toHaveCount(1);
			await expect(settle).not.toHaveCSS("box-shadow", "none");
			const keyboardPath =
				"acceptance/visual/artifacts/settle-keyboard-focus.png";
			await bar.screenshot({ path: keyboardPath });
			world.artifacts.push(keyboardPath);
			await bar.click({ position: { x: 1, y: 1 } });
			await expect(settle).not.toBeFocused();
			await expect(settle).toHaveCSS("box-shadow", "none");
			const pointerPath =
				"acceptance/visual/artifacts/settle-pointer-focus.png";
			await bar.screenshot({ path: pointerPath });
			world.artifacts.push(pointerPath);
		},
	},
	{
		name: "set phone viewport",
		match: /^the viewport is a phone$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, PHONE_VIEWPORT);
		},
	},
	{
		name: "message from another device",
		match: /^another device sends the message (.+)$/,
		run: async ({ world, match }) => {
			const text = match[1] ?? "";
			requireRelayControl(world.page).sendMessage({
				type: "user_message",
				sessionId: "sess-mockup-001",
				text,
			});
			await world.page.locator("#messages").getByText(text).waitFor();
		},
	},
	{
		name: "scroll transcript by wheel",
		match: /^I scroll the transcript (up|down) by ([0-9]+) pixels$/,
		run: async ({ world, match }) => {
			const sign = match[1] === "up" ? -1 : 1;
			await world.page.locator("#messages").hover();
			await world.page.mouse.wheel(0, sign * Number(match[2]));
		},
	},
	{
		// A real touch scroll, not a wheel: Chromium drops a scrollTop write made
		// mid-touch-scroll, which a wheel never shows.
		name: "swipe transcript by touch",
		match: /^I swipe the transcript towards (older|newer) by ([0-9]+) pixels$/,
		run: async ({ world, match }) => {
			const box = await world.page.locator("#messages").boundingBox();
			if (!box) throw new Error("transcript has no box");
			const cdp = await world.page.context().newCDPSession(world.page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			await cdp.send("Input.synthesizeScrollGesture", {
				x: box.x + box.width / 2,
				y: box.y + box.height / 2,
				yDistance: (match[1] === "older" ? 1 : -1) * Number(match[2]),
				gestureSourceType: "touch",
				speed: 600,
			});
			await cdp.detach();
		},
	},
	{
		name: "remember where the transcript content sits",
		match: /^I remember where the transcript content sits$/,
		run: async ({ world }) => {
			const anchor = await world.page
				.locator("#messages")
				.evaluate(async (el) => {
					// A wheel scroll animates, so wait until the offset holds still.
					let last = Number.NaN;
					for (
						let still = 0;
						still < 5;
						still = el.scrollTop === last ? still + 1 : 0
					) {
						last = el.scrollTop;
						await new Promise((resolve) => requestAnimationFrame(resolve));
					}
					const box = el.getBoundingClientRect();
					const target = document.elementFromPoint(
						box.left + 30,
						box.top + el.clientHeight / 2,
					);
					if (!target || target === el || !el.contains(target))
						return undefined;
					for (const old of el.querySelectorAll("[data-test-anchor]"))
						old.removeAttribute("data-test-anchor");
					target.setAttribute("data-test-anchor", "");
					return {
						top: target.getBoundingClientRect().top,
						gap: el.scrollHeight - el.scrollTop - el.clientHeight,
					};
				});
			if (!anchor)
				throw new Error(
					"no transcript content at the middle of the transcript",
				);
			transcriptAnchors.set(world.page, anchor);
		},
	},
	{
		name: "transcript content moved",
		match:
			/^the transcript content moved (?:([0-9]+) pixels|its remembered distance from the bottom) towards (older|newer)$/,
		run: async ({ world, match }) => {
			const before = transcriptAnchors.get(world.page);
			if (!before)
				throw new Error("transcript content position was not remembered");
			// Let a trailing frame (resize observers, scroll clamps) land first.
			await world.page.evaluate(
				() =>
					new Promise((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(resolve)),
					),
			);
			const after = await world.page
				.locator("#messages [data-test-anchor]")
				.evaluate((el) => el.getBoundingClientRect().top);
			const distance = match[1] === undefined ? before.gap : Number(match[1]);
			const expected =
				before.top + (match[2] === "older" ? distance : -distance);
			if (Math.abs(after - expected) > 3) {
				throw new Error(
					`transcript content is at ${after}, expected ${expected} (started at ${before.top})`,
				);
			}
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
			await world.page.getByTestId("session-bar-island-overflow").click();
			await world.page
				.getByTestId(`overflow-view-${match[1]?.toLowerCase()}`)
				.click();
		},
	},
	{
		name: "remember session views from expanded overflow",
		match: /^I remember the session views from the expanded bar overflow$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-bar-island-overflow").click();
			rememberedSessionViews.set(
				world.page,
				await world.page
					.getByTestId("session-bar-island-menu")
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
		match:
			/^the menu lists the same session views as the expanded bar overflow$/,
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
					`menu views ${JSON.stringify(actual)} differ from the expanded bar overflow ${JSON.stringify(expected)}`,
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
			await world.page.getByTestId("session-bar-island-overflow").click();
			const selected = await world.page
				.getByTestId(`overflow-view-${match[1]?.toLowerCase()}`)
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
			// The top clearance trails a bar resize by a frame (it is measured by a
			// ResizeObserver), so let it land before measuring.
			await world.page.evaluate(
				() =>
					new Promise((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(resolve)),
					),
			);
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
		// Sets scrollTop directly: a wheel would also toggle the bar, and the
		// scenario needs the bar change to come only from the step after this.
		name: "park transcript just above the bottom",
		match: /^the transcript is parked ([0-9]+) pixels above the bottom$/,
		run: async ({ world, match }) => {
			const gap = Number(match[1]);
			await world.page.locator("#messages").evaluate((el, gap) => {
				el.scrollTop = el.scrollHeight - el.clientHeight - gap;
			}, gap);
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
				layout.height > 60
			) {
				throw new Error(
					`desktop bar is not one row: ${JSON.stringify(layout)}`,
				);
			}
		},
	},
	{
		name: "phone first row reads back, session controls, overflow",
		match:
			/^the session bar's first row reads back, session controls and the overflow menu from left to right$/,
		run: async ({ world }) => {
			const boxes = await Promise.all(
				[
					"[data-testid='session-bar-back']",
					"#session-bar-meta",
					"[data-testid='session-bar-island-overflow']",
				].map((selector) => world.page.locator(selector).boundingBox()),
			);
			const [back, controls, overflow] = boxes;
			if (!back || !controls || !overflow) {
				throw new Error(
					`first-row control has no layout box: ${JSON.stringify(boxes)}`,
				);
			}
			const middle = (box: { y: number; height: number }) =>
				box.y + box.height / 2;
			const oneRow = [controls, overflow].every(
				(box) => Math.abs(middle(box) - middle(back)) < 8,
			);
			const ordered =
				back.x + back.width <= controls.x + 1 &&
				controls.x + controls.width <= overflow.x + 1;
			if (!oneRow || !ordered) {
				throw new Error(
					`first row out of order: ${JSON.stringify({ back, controls, overflow })}`,
				);
			}
		},
	},
	{
		name: "desktop session controls sit in the right group",
		match: /^the desktop session controls sit in the right-hand group$/,
		run: async ({ world }) => {
			const [bar, controls] = await Promise.all([
				world.page.getByTestId("session-bar").boundingBox(),
				world.page.locator("#session-bar-meta").boundingBox(),
			]);
			if (
				!bar ||
				!controls ||
				controls.x + controls.width / 2 < bar.x + bar.width / 2
			) {
				throw new Error(
					`desktop controls are not right-aligned: ${JSON.stringify({ bar, controls })}`,
				);
			}
		},
	},
	{
		name: "assert the header has no checkout",
		match: /^the session header has no checkout$/,
		run: async ({ world }) => {
			const bar = world.page.getByTestId("session-bar");
			await expect(bar).toBeVisible();
			await expect(bar.getByRole("button", { name: /^Checkout:/ })).toHaveCount(
				0,
			);
			await expect(bar.getByTestId("composer-checkout")).toHaveCount(0);
		},
	},
	{
		name: "assert the header has no account or instance control",
		match: /^the session header has no account or instance control$/,
		run: async ({ world }) => {
			const bar = world.page.getByTestId("session-bar");
			await expect(bar).toBeVisible();
			await expect(
				bar.getByRole("button", {
					name: /^(Session account:|Select instance)/,
				}),
			).toHaveCount(0);
			await expect(bar.getByTestId("account-dot")).toHaveCount(0);
			await expect(bar.getByTestId("project-instance-trigger")).toHaveCount(0);
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
			const actions = await menu
				.locator('[data-testid^="overflow-"]')
				.evaluateAll((items) =>
					items.map(
						(item) =>
							item.getAttribute("aria-label") ?? item.textContent?.trim() ?? "",
					),
				);
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
