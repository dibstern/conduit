import { expect, test } from "@playwright/test";

test("Button hoverFill replaces the background while preserving its tone", async ({
	page,
}, testInfo) => {
	// Ghost's default tone brightens on hover; the existing GhostAccent stays accent.
	await page.goto(
		"/iframe.html?id=ui-button--hover-fill-replaces-variant&viewMode=story",
		{ waitUntil: "domcontentloaded" },
	);
	const button = page.getByRole("button", { name: "Open" });
	await expect(button).toBeVisible();
	await page.evaluate(() => {
		const storybookWindow = window as Window & {
			__STORYBOOK_ADDONS_PREVIEW?: {
				getChannel(): { emit(event: string, payload: unknown): void };
			};
		};
		const addons = storybookWindow.__STORYBOOK_ADDONS_PREVIEW;
		if (!addons) throw new Error("Storybook preview channel is unavailable");
		addons.getChannel().emit("updateStoryArgs", {
			storyId: "ui-button--hover-fill-replaces-variant",
			updatedArgs: { variant: "ghost-accent" },
		});
	});
	await expect(button).toHaveClass(/\btext-accent\b/);
	await button.evaluate(async (element) => {
		await Promise.all(
			element.getAnimations().map((animation) => animation.finished),
		);
	});
	const resting = await button.evaluate((element) => {
		const style = getComputedStyle(element);
		const probe = document.createElement("div");
		probe.style.backgroundColor = "var(--color-sidebar-hover)";
		element.parentElement?.append(probe);
		try {
			return {
				background: style.backgroundColor,
				colour: style.color,
				hoverBackground: getComputedStyle(probe).backgroundColor,
			};
		} finally {
			probe.remove();
		}
	});

	await button.hover();
	await expect(button).toHaveCSS("background-color", resting.hoverBackground);
	await expect(button).not.toHaveCSS("background-color", resting.background);
	await expect(button).toHaveCSS("color", resting.colour);
	await testInfo.attach("button-sidebar-hover", {
		body: await button.screenshot(),
		contentType: "image/png",
	});
});
