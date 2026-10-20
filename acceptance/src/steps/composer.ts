import { expect, type Page } from "@playwright/test";
import { sendMockFamily } from "../../../test/e2e/helpers/rpc-mock.js";
import { InputPage } from "../../../test/e2e/page-objects/input.page.js";
import { DESKTOP_VIEWPORT, PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openComposerMoreSheet,
	openSessionRoute,
	relayControls,
	requireRelayControl,
	requireRpcControl,
	rpcControls,
} from "./shared.js";

const composerMessages = new WeakMap<Page, string>();

async function openApprovalsMenu(page: Page): Promise<void> {
	const menu = page.getByTestId("permission-mode-dropdown");
	if (await menu.isVisible()) return;
	let button = page.getByTestId(
		/^(permission-mode-badge|composer-word-approvals)$/,
	);
	if ((page.viewportSize()?.width ?? 0) < 768) {
		const row = page.getByTestId("composer-more-mode");
		if (await row.isVisible()) button = row;
		else if (!(await button.isVisible())) {
			await openComposerMoreSheet(page);
			button = row;
		}
	}
	await expect(button).not.toHaveAttribute("aria-busy", "true");
	await button.click();
	await expect(menu).toBeVisible();
}

export const composerHandlers: StepHandler[] = [
	{
		name: "assert ordered mock messages after clock changes",
		match: /^generated messages follow the scenario clock in arrival order$/,
		run: async ({ world }) => {
			const page = world.page;
			const now = await page.evaluate(() => Date.now());
			const texts = ["Start a composer turn.", "The fixed-clock reply"];
			for (let index = 0; index < 12; index++) {
				const text = `Device message ${index + 1}`;
				texts.push(text);
				requireRelayControl(page).sendMessage({
					type: "user_message",
					sessionId: "sess-mockup-001",
					text,
				});
			}
			const times = page.locator("#messages time");
			await expect(times).toHaveCount(texts.length);
			const stamps = await times.evaluateAll((elements) =>
				elements.map((element) =>
					Date.parse(element.getAttribute("datetime") ?? ""),
				),
			);
			expect(stamps[0]).toBe(now);
			for (let index = 1; index < stamps.length; index++)
				expect(stamps[index]).toBeGreaterThan(stamps[index - 1] ?? 0);
			const transcript = page.locator("#messages");
			const content = await transcript.innerText();
			for (let index = 1; index < texts.length; index++)
				expect(content.indexOf(texts[index] ?? "")).toBeGreaterThan(
					content.indexOf(texts[index - 1] ?? ""),
				);
		},
	},
	{
		name: "assert deterministic mock identity and time",
		match:
			/^the mock avatar and message clock match the fixed acceptance fixture$/,
		run: async ({ world }) => {
			const page = world.page;
			expect(
				await page.evaluate(() => ({
					now: Date.now(),
					date: new Date().toISOString(),
					zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					locale: navigator.language,
				})),
			).toEqual({
				now: PINNED_CLOCK_MS,
				date: new Date(PINNED_CLOCK_MS).toISOString(),
				zone: "UTC",
				locale: "en-US",
			});
			const message = page.locator("#messages .msg-user").last();
			await expect(message.getByTestId("user-avatar")).toHaveText("Y");
			const timestamp = await message.locator("time").getAttribute("datetime");
			const createdAt = Date.parse(timestamp ?? "");
			expect(createdAt).toBeGreaterThanOrEqual(PINNED_CLOCK_MS);
			expect(createdAt).toBeLessThan(PINNED_CLOCK_MS + 60_000);
		},
	},
	{
		name: "set desktop viewport",
		match: /^the viewport is a desktop$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, DESKTOP_VIEWPORT);
		},
	},
	{
		name: "type into composer",
		match: /^I type (.*) into the composer$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			composerMessages.set(world.page, message);
			await new InputPage(world.page).type(message);
		},
	},
	{
		name: "send composer message",
		match: /^I send the composer message$/,
		run: async ({ world }) => {
			await new InputPage(world.page).send();
		},
	},
	{
		name: "tap send with the keyboard open",
		match: /^I tap the send button with the keyboard open$/,
		run: async ({ world }) => {
			const page = world.page;
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			// An iPhone home-indicator inset, which iOS keeps at full size while the keyboard is up.
			await cdp.send("Emulation.setSafeAreaInsetsOverride", {
				insets: { bottom: 34, bottomMax: 34 },
			});
			await page.locator("#input-area textarea").focus();
			const box = await page.locator("#send").boundingBox();
			if (!box) throw new Error("Send button is not visible");
			const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [point],
			});
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			await cdp.detach();
		},
	},
	{
		name: "assert command menu entries",
		match: /^the command menu (offers|does not offer) (\S+)$/,
		run: async ({ world, match }) => {
			const names = world.page.locator("#command-menu .cmd-name");
			await names.first().waitFor({ state: "visible" });
			const offered = (await names.allInnerTexts()).map((name) => name.trim());
			const expected = match[1] === "offers";
			if (offered.includes(match[2] ?? "") !== expected) {
				throw new Error(
					`Expected command menu to ${match[1]} ${match[2]}; it lists ${offered.join(", ")}`,
				);
			}
		},
	},
	{
		name: "assert sent text",
		match: /^the relay receives the sent text (.+)$/,
		run: async ({ world, match }) => {
			const rpcControl = rpcControls.get(world.page);
			if (!rpcControl) throw new Error("Mock RPC was not initialised");
			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["text"] === match[1],
			);
		},
	},
	{
		name: "replay sent message for selected session",
		match: /^the mock relay replays the sent message for the selected session$/,
		run: async ({ world }) => {
			const message = composerMessages.get(world.page);
			const rpcControl = rpcControls.get(world.page);
			const relayControl = relayControls.get(world.page);
			if (message == null || !rpcControl || !relayControl) {
				throw new Error("Mock relay controls were not initialised");
			}

			// The composer hands the provider its own spelling of $goal.
			const sent = message.replace(/^\$goal\b/, "/goal");
			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "input.submit" && request.payload["text"] === sent,
			);
			// Stand in for the adapter placing the sent message (the browser keeps
			// no copy of its own), then finish the turn the send started, as the
			// relay's done does.
			await relayControl.sendMessages([
				{ type: "user_message", text: sent },
				{ type: "done", code: 0 },
			]);
		},
	},
	{
		name: "replay subagent family",
		match: /^the mock relay replays a session family with a parent$/,
		run: async ({ world }) => {
			await openSessionRoute(world.page, "sess-subagent");
			sendMockFamily(world.page, [
				{ id: "sess-mockup-001", title: "Parent session", status: "idle" },
				{
					id: "sess-subagent",
					title: "Subagent session",
					status: "idle",
					parentID: "sess-mockup-001",
				},
			]);
		},
	},
	{
		name: "assert transcript message",
		match: /^the transcript shows (.*)$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			await world.page
				.locator("#messages")
				.getByText(message, { exact: true })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "assert subagent parent link",
		match: /^the subagent parent link is visible$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: /Parent/ })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "clear composer",
		match: /^I clear the composer$/,
		run: async ({ world }) => {
			await new InputPage(world.page).type("");
		},
	},
	{
		name: "assert send button state",
		match: /^the send button is (true|false)$/,
		run: async ({ world, match }) => {
			const expectedEnabled = match[1] === "true";
			const input = new InputPage(world.page);
			await world.page.waitForFunction(
				(expected) => {
					const send = document.getElementById(
						"send",
					) as HTMLButtonElement | null;
					return send != null && !send.disabled === expected;
				},
				expectedEnabled,
				{ timeout: 2_000 },
			);
			const actualEnabled = await input.sendBtn.isEnabled();
			if (actualEnabled !== expectedEnabled) {
				throw new Error(
					`Expected send button enabled=${expectedEnabled}, got ${actualEnabled}`,
				);
			}
		},
	},
	{
		name: "set approvals mode",
		match: /^I set approvals to (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await openApprovalsMenu(world.page);
			await world.page.getByTestId(`permission-mode-option-${mode}`).click();
		},
	},
	{
		name: "assert approvals dropdown omits a mode",
		match:
			/^the approvals dropdown does not offer (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await openApprovalsMenu(world.page);
			await expect(
				world.page.getByTestId(`permission-mode-option-${mode}`),
			).toHaveCount(0);
		},
	},
	{
		name: "assert approvals shield accessible label",
		match:
			/^the approvals chip shows (Never ask|Plan|Ask before edits|Auto-accept edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("permission-mode-badge"),
			).toHaveAccessibleName(`Approvals: ${match[1]}. Open options`);
		},
	},
	{
		name: "seed approvals mode",
		match: /^approvals are (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			// The open session's shell row carries its approval mode.
			const rpc = requireRpcControl(world.page);
			const id = decodeURIComponent(
				new URL(world.page.url()).pathname.split("/")[2] ?? "",
			);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === id,
			);
			rpc.upsertShellRow({
				title: id,
				status: "idle",
				...(row as object | undefined),
				id,
				permissionMode: match[1],
			});
		},
	},
	{
		name: "tap approvals shield",
		match: /^I tap the approvals (shield|word)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word"
					? "composer-word-approvals"
					: "permission-mode-badge",
			);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await button.click();
		},
	},
	{
		name: "open approvals menu",
		match: /^I open the approvals menu$/,
		run: async ({ world }) => {
			await openApprovalsMenu(world.page);
		},
	},
	{
		name: "assert approvals word label",
		match: /^the approvals word shows (never|plan|ask|edits|auto|full)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId("composer-word-approvals");
			await expect(button).toHaveText(match[1] ?? "");
			await expect(button.locator("svg")).toHaveCount(0);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
		},
	},
	{
		name: "assert approval word tone",
		match:
			/^the approvals word uses the (never|plan|ask|edits|auto|full) tone$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId("composer-word-approvals");
			// The tone animates (transition-colors), so poll until it settles.
			await expect
				.poll(() =>
					button.evaluate((element, tone) => {
						const probe = document.createElement("span");
						probe.style.color = `var(--color-${tone === "full" ? "error" : tone === "edits" || tone === "auto" ? "status-ask" : "text-secondary"})`;
						document.body.append(probe);
						const expected = getComputedStyle(probe).color;
						probe.remove();
						return getComputedStyle(element).color === expected;
					}, match[1] ?? ""),
				)
				.toBe(true);
		},
	},
	{
		name: "assert ranked approvals menu",
		match: /^the approvals menu is ranked (.+)$/,
		run: async ({ world, match }) => {
			const expected = (match[1] ?? "").split(", ");
			const menu = world.page.getByTestId("permission-mode-dropdown");
			await expect(menu).toBeVisible();
			await expect(menu.getByRole("menuitemradio")).toHaveCount(
				expected.length,
			);
			const actual = await menu
				.getByRole("menuitemradio")
				.evaluateAll((items) =>
					items.map((item) =>
						item
							.getAttribute("data-testid")
							?.replace("permission-mode-option-", ""),
					),
				);
			if (actual.join(", ") !== expected.join(", ")) {
				throw new Error(
					`Expected approval order ${expected.join(", ")}, got ${actual.join(", ")}`,
				);
			}
		},
	},
	{
		name: "assert approvals menu description",
		match:
			/^the approvals option (dontAsk|plan|ask|acceptEdits|auto|full) describes (.+)$/,
		run: async ({ world, match }) => {
			const option = world.page.getByTestId(
				`permission-mode-option-${match[1]}`,
			);
			await expect(option).toContainText(match[2] ?? "");
			await expect(option.locator("svg").first()).toBeVisible();
		},
	},
	{
		name: "assert Claude-only approval tags",
		match: /^only dontAsk, plan and auto carry Claude tags$/,
		run: async ({ world }) => {
			for (const mode of [
				"dontAsk",
				"plan",
				"ask",
				"acceptEdits",
				"auto",
				"full",
			]) {
				const option = world.page.getByTestId(`permission-mode-option-${mode}`);
				const tag = option.getByText("Claude", { exact: true });
				await expect(tag).toHaveCount(
					["dontAsk", "plan", "auto"].includes(mode) ? 1 : 0,
				);
			}
		},
	},
	{
		name: "assert approvals menu closed",
		match: /^the approvals menu is closed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("permission-mode-dropdown"),
			).toHaveCount(0);
		},
	},
];
