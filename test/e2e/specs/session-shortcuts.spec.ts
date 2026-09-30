import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({ recording: "chat-simple", screenshot: "off" });

for (const mode of [
	{
		name: "desktop",
		viewport: { width: 1440, height: 900 },
		isMobile: false,
		hasTouch: false,
	},
	{
		name: "phone",
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	},
] as const) {
	test.describe(`${mode.name} session shortcuts`, () => {
		test.use({
			viewport: mode.viewport,
			isMobile: mode.isMobile,
			hasTouch: mode.hasTouch,
		});

		test("option digits select views without changing the draft", async ({
			page,
			relayUrl,
		}) => {
			await gotoRelay(page, relayUrl);
			const input = page.locator("#input");
			await input.fill("draft stays put");
			await page.keyboard.press("Alt+2");
			await expect(page.locator("#terminal-panel")).toBeVisible();
			await page.keyboard.press("Alt+1");
			await expect(input).toBeVisible();
			await expect(input).toHaveValue("draft stays put");
			await input.focus();
			await page.keyboard.press("Alt+3");
			if (mode.name === "phone")
				await expect(page.locator("#terminal-panel")).toBeHidden();
			else await expect(page.locator("#terminal-panel")).toBeVisible();
			await expect(input).toHaveValue("draft stays put");
			await page.keyboard.press("Alt+4");
			if (mode.name === "desktop")
				await expect(page.getByTestId("side-pane-files")).toBeVisible();
			else
				await expect(
					page.getByText("File Browser", { exact: true }),
				).toBeVisible();
			if (mode.name === "desktop") {
				await page.locator("#files-pane-expand").click();
				await expect(page.locator("#chat-area")).toHaveAttribute("inert", "");
			}
			await page.keyboard.press("Alt+1");
			await expect(input).toBeVisible();
			await expect(input).toHaveValue("draft stays put");
			if (mode.name === "desktop") {
				await expect(page.locator("#chat-area")).not.toHaveAttribute(
					"inert",
					"",
				);
				await expect(input).toBeFocused();
				await page.keyboard.press("Alt+2");
				await expect(page.locator("#terminal-panel")).toBeHidden();
				await page.getByTestId("views-rail-terminal").hover();
				await expect(page.getByRole("tooltip")).toContainText("⌥2");
				await page.getByTestId("session-bar-settle").hover();
				await expect(page.getByRole("tooltip")).toContainText("s · ⌘⇧E");
			} else {
				await page.getByTestId("session-bar-views-button").tap();
				await expect(
					page
						.getByTestId("session-bar-views-sheet")
						.locator(".shortcut-hint")
						.first(),
				).toBeHidden();
			}
		});

		test("settle shortcuts toggle the open session and explain a disabled settle", async ({
			page,
			relayUrl,
		}) => {
			await gotoRelay(page, relayUrl);
			const messages = page.locator("#messages");
			await messages.focus();
			await page.keyboard.press("s");
			await expect(page.getByTestId("session-bar-state-chip")).toBeVisible();
			await page.locator("#input").focus();
			await page.keyboard.press("ControlOrMeta+Shift+E");
			await expect(page.getByTestId("session-bar-state-chip")).toHaveCount(0);
			await messages.focus();
			await page.keyboard.press("p");
			await expect(
				page.locator('#session-list [title="Pinned session"]'),
			).toHaveCount(1);
			await page.keyboard.press("ControlOrMeta+Shift+E");
			await expect(
				page.getByRole("status").filter({ hasText: "Unpin to settle" }),
			).toBeVisible();
			await expect(page.getByTestId("session-bar-state-chip")).toHaveCount(0);
		});

		test("transcript verbs target the open session while composer letters remain text", async ({
			page,
			relayUrl,
		}) => {
			await gotoRelay(page, relayUrl);
			const messages = page.locator("#messages");
			await messages.focus();
			await page.keyboard.press("z");
			await expect(page.getByTestId("snooze-option-indefinite")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(messages).toBeFocused();
			await page.keyboard.press("r");
			await expect(
				page.getByRole("textbox", { name: "Session name" }),
			).toBeVisible();
			await page.keyboard.press("Escape");
			await messages.focus();
			await page.keyboard.press("u");
			await expect(
				page
					.locator("#session-list .session-item")
					.first()
					.getByTestId("session-unread-dot"),
			).toBeVisible();
			if (mode.name === "phone")
				await page.locator("#session-list .session-item").first().click();
			const input = page.locator("#input");
			await input.fill("");
			await input.focus();
			for (const key of ["s", "z", "p", "r", "u"])
				await page.keyboard.press(key);
			await expect(input).toHaveValue("szpru");
			await expect(page.getByTestId("snooze-option-indefinite")).toHaveCount(0);
			await expect(page.getByTestId("session-bar-state-chip")).toHaveCount(0);
		});

		test("plain verbs still act on the focused list row", async ({
			page,
			relayUrl,
		}) => {
			await gotoRelay(page, new URL("/", relayUrl).toString());
			const row = page.locator("#session-list .session-item").first();
			await expect(row).toBeVisible();
			await row.focus();
			await page.keyboard.press("p");
			await expect(row.locator('[title="Pinned session"]')).toHaveCount(1);
			await row.focus();
			await page.keyboard.press("p");
			await expect(row.locator('[title="Pinned session"]')).toHaveCount(0);
			await row.focus();
			await page.keyboard.press("z");
			await expect(page.getByTestId("snooze-option-indefinite")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(row).toBeFocused();
			await page.keyboard.press("r");
			await expect(
				row.getByRole("textbox", { name: "Session name" }),
			).toBeVisible();
			await page.keyboard.press("Escape");
			await row.focus();
			await page.keyboard.press("u");
			await expect(row.getByTestId("session-unread-dot")).toBeVisible();
			await row.focus();
			await page.keyboard.press("s");
			await expect(row).toHaveCount(0);
		});
	});
}
